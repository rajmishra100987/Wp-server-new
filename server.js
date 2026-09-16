const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Global variables
let sock = null;
let botActive = false;
let loopRunning = false;
let creds = null;
let pairingRequested = false;

// Log function for both console and socket
function emitLog(msg, type = 'info') {
    const colors = {
        success: chalk.green,
        error: chalk.red,
        warn: chalk.yellow,
        info: chalk.cyan,
        bold: chalk.bold
    };
    const colorFn = colors[type] || chalk.white;
    console.log(colorFn(msg));
    io.emit('log', { message: msg, type });
}

// ---------- WhatsApp Bot Logic ----------
async function startBot(phoneNumber, targetJid, messages, prefix, delayMs, socketId) {
    if (botActive) {
        emitLog('Bot is already running.', 'warn');
        return;
    }
    botActive = true;

    // Ensure session folder exists
    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'fatal' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // Request pairing code if not registered
        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            await delay(4000);
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                emitLog(`[+] YOUR PAIRING CODE: ${code}`, 'success');
                // Also send to the specific client
                io.to(socketId).emit('pairingCode', code);
            } catch (error) {
                emitLog(`[-] Pairing Code Failed: ${error.message || error}`, 'error');
                botActive = false;
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== 401) {
                emitLog('[-] Network lost. Auto Reconnecting in 3 seconds...', 'warn');
                await delay(3000);
                botActive = false;
                startBot(phoneNumber, targetJid, messages, prefix, delayMs, socketId);
            } else {
                emitLog('[-] Session expired, please delete "session" folder and restart.', 'error');
                botActive = false;
            }
        } else if (connection === 'open') {
            emitLog('[SUCCESS] WhatsApp Bot Successfully Connected! 🎉', 'success');
            // Start the message loop
            await runMessageLoop(targetJid, messages, prefix, delayMs);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ---------- Infinite Message Loop ----------
async function runMessageLoop(targetJid, messages, prefix, delayMs) {
    if (loopRunning) return;
    loopRunning = true;

    let totalSentCount = 0;
    let roundCount = 1;

    while (loopRunning) {
        emitLog(`--- [ROUND ${roundCount} STARTED] ---`, 'info');

        for (let i = 0; i < messages.length; i++) {
            totalSentCount++;
            const fullMessage = `${prefix.trim()} ${messages[i]}`;

            try {
                await sock.sendMessage(targetJid, { text: fullMessage });
                emitLog(`[SUCCESS] Total Sent: ${totalSentCount} | Round ${roundCount} [${i + 1}/${messages.length}]: ${fullMessage}`, 'success');
            } catch (err) {
                emitLog(`[ERROR] Total Sent: ${totalSentCount} | Failed [${i + 1}/${messages.length}]: ${err.message || err}`, 'error');
            }

            await delay(delayMs);
        }

        emitLog(`[+] Round ${roundCount} Finished! Re-starting loop from line 1...`, 'info');
        roundCount++;
    }
}

// ---------- Socket.IO Events ----------
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // User requests to fetch groups
    socket.on('getGroups', async () => {
        if (!sock) {
            socket.emit('log', { message: 'Bot not connected yet. Start the bot first.', type: 'warn' });
            return;
        }
        try {
            const groups = await sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);
            if (groupList.length === 0) {
                socket.emit('log', { message: 'No groups found for this account.', type: 'warn' });
                socket.emit('groupList', []);
                return;
            }
            const list = groupList.map(g => ({ id: g.id, subject: g.subject }));
            socket.emit('groupList', list);
        } catch (err) {
            socket.emit('log', { message: `Group fetch error: ${err.message || err}`, type: 'error' });
        }
    });

    // User starts the bot
    socket.on('startBot', async (data) => {
        const { phoneNumber, targetType, targetJid, messages, prefix, delay } = data;
        if (!phoneNumber) {
            socket.emit('log', { message: 'Phone number is required.', type: 'error' });
            return;
        }
        if (!targetJid) {
            socket.emit('log', { message: 'Target JID is required.', type: 'error' });
            return;
        }
        if (!messages || messages.length === 0) {
            socket.emit('log', { message: 'Message list is empty.', type: 'error' });
            return;
        }

        const delayMs = (parseInt(delay) || 5) * 1000;
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

        emitLog(`Starting bot for target: ${targetJid}`, 'info');
        await startBot(cleanNumber, targetJid, messages, prefix, delayMs, socket.id);
    });

    // Stop the bot (optional)
    socket.on('stopBot', () => {
        loopRunning = false;
        botActive = false;
        emitLog('Bot stopped by user.', 'warn');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(chalk.green.bold(`✅ Server running on port ${PORT}`));
    console.log(chalk.cyan(`🌐 Open http://localhost:${PORT} in your browser.`));
});
