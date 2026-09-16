const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Browsers } = require('@whiskeysockets/baileys');
const { DisconnectReason } = require('@whiskeysockets/baileys');

// Configuration
const PORT = process.env.PORT || 8080;
const SESSION_DIR = './session';
const UPLOAD_DIR = './uploads';
const BACKUP_DIR = './backups';
const LOG_DIR = './logs';
const TASKS_FILE = './tasks.json';

// Ensure directories exist
[SESSION_DIR, UPLOAD_DIR, BACKUP_DIR, LOG_DIR].forEach(dir => {
  fs.ensureDirSync(dir);
});

// Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer config for TXT uploads
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, `messages_${Date.now()}.txt`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Global state
let sock = null;
let activeTasks = new Map();
let reconnectAttempts = 0;
let isReconnecting = false;
let heartbeatInterval = null;
let messagingInterval = null;
let isMessagingActive = false;
let currentMessageIndex = 0;
let messageQueue = [];
let isProcessingQueue = false;

// Load tasks from file
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const tasksData = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      activeTasks = new Map(Object.entries(tasksData));
      console.log(`✅ Loaded ${activeTasks.size} tasks from persistence`);
    }
  } catch (error) {
    console.error('Failed to load tasks:', error);
  }
}

// Save tasks to file
function saveTasks() {
  try {
    const tasksObj = Object.fromEntries(activeTasks);
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksObj, null, 2));
  } catch (error) {
    console.error('Failed to save tasks:', error);
  }
}

// Cleanup resources
function cleanupResources() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (messagingInterval) {
    clearInterval(messagingInterval);
    messagingInterval = null;
  }
  isMessagingActive = false;
  isProcessingQueue = false;
}

// Start heartbeat
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  
  heartbeatInterval = setInterval(async () => {
    if (sock && sock.user) {
      try {
        await sock.sendPresenceUpdate('available');
        console.log('💓 Heartbeat sent');
      } catch (error) {
        console.log('Heartbeat failed:', error.message);
      }
    }
  }, 20000);
}

// Process message queue with serial sending
async function processMessageQueue() {
  if (isProcessingQueue || !isMessagingActive || !sock || !sock.user) {
    return;
  }
  
  isProcessingQueue = true;
  
  try {
    while (isMessagingActive && messageQueue.length > 0 && sock && sock.user) {
      const task = messageQueue[0];
      const { taskId, target, messages, hatersName, lastName, currentIndex } = task;
      
      if (currentIndex >= messages.length) {
        // Task completed
        const completedTask = activeTasks.get(taskId);
        if (completedTask) {
          completedTask.status = 'completed';
          completedTask.completedAt = new Date().toISOString();
          activeTasks.set(taskId, completedTask);
          saveTasks();
        }
        messageQueue.shift();
        continue;
      }
      
      const message = messages[currentIndex];
      const formattedMessage = `${hatersName} ${message} ${lastName}`;
      const chatId = target.includes('@g.us') ? target : `${target}@s.whatsapp.net`;
      
      try {
        await sock.sendMessage(chatId, { text: formattedMessage });
        console.log(`✅ Message sent: ${formattedMessage} to ${chatId}`);
        
        // Update task progress
        const updatedTask = activeTasks.get(taskId);
        if (updatedTask) {
          updatedTask.currentIndex = currentIndex + 1;
          updatedTask.lastSent = new Date().toISOString();
          updatedTask.sentCount = (updatedTask.sentCount || 0) + 1;
          activeTasks.set(taskId, updatedTask);
          saveTasks();
        }
        
        task.currentIndex = currentIndex + 1;
        
        // Wait between messages (avoid rate limiting)
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        console.error(`Failed to send message: ${error.message}`);
        // Don't increment index on failure, retry later
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

// Start messaging system
function startMessaging() {
  if (messagingInterval) clearInterval(messagingInterval);
  
  isMessagingActive = true;
  messagingInterval = setInterval(() => {
    if (isMessagingActive && messageQueue.length > 0 && sock && sock.user && !isProcessingQueue) {
      processMessageQueue().catch(console.error);
    }
  }, 1000);
}

// Stop messaging system
function stopMessaging() {
  isMessagingActive = false;
  if (messagingInterval) {
    clearInterval(messagingInterval);
    messagingInterval = null;
  }
  isProcessingQueue = false;
  messageQueue = [];
}

// Create WhatsApp socket with production config
async function createWhatsAppSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      defaultQueryTimeoutMs: 30000
    });
    
    socket.ev.on('creds.update', saveCreds);
    
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('QR Code received (should not happen with pairing code)');
      }
      
      if (connection === 'open') {
        console.log('✅ WhatsApp connection opened successfully');
        reconnectAttempts = 0;
        isReconnecting = false;
        startHeartbeat();
        
        // Resume any pending tasks
        if (activeTasks.size > 0) {
          console.log(`🔄 Resuming ${activeTasks.size} pending tasks`);
          startMessaging();
          
          // Re-queue active tasks
          for (const [taskId, task] of activeTasks) {
            if (task.status === 'active' && task.currentIndex < task.messages.length) {
              messageQueue.push({
                taskId,
                target: task.target,
                messages: task.messages,
                hatersName: task.hatersName,
                lastName: task.lastName,
                currentIndex: task.currentIndex || 0
              });
            }
          }
        }
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`Connection closed with code: ${statusCode}`);
        cleanupResources();
        
        if (shouldReconnect && !isReconnecting) {
          console.log('Attempting to reconnect...');
          await reconnectWithBackoff();
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out, backing up session...');
          await backupSession();
        }
      }
    });
    
    socket.ev.on('messaging-history.set', () => {
      console.log('Messaging history received');
    });
    
    return socket;
  } catch (error) {
    console.error('Failed to create socket:', error);
    throw error;
  }
}

// Reconnect with exponential backoff
async function reconnectWithBackoff() {
  if (isReconnecting) return;
  isReconnecting = true;
  
  const maxAttempts = 10;
  const baseDelay = 3000;
  
  for (let attempt = 1; attempt <= maxAttempts && isReconnecting; attempt++) {
    try {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Reconnect attempt ${attempt}/${maxAttempts} in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      if (sock) {
        try {
          sock.end(undefined);
        } catch (e) {}
        sock = null;
      }
      
      sock = await createWhatsAppSocket();
      
      if (sock && sock.user) {
        console.log('✅ Successfully reconnected');
        isReconnecting = false;
        reconnectAttempts = 0;
        return;
      }
    } catch (error) {
      console.error(`Reconnect attempt ${attempt} failed:`, error.message);
    }
  }
  
  console.error('Max reconnect attempts reached, manual intervention may be required');
  isReconnecting = false;
}

// Backup session
async function backupSession() {
  try {
    const backupPath = path.join(BACKUP_DIR, `session_${Date.now()}`);
    await fs.copy(SESSION_DIR, backupPath);
    console.log(`Session backed up to ${backupPath}`);
    
    // Keep only last 5 backups
    const backups = await fs.readdir(BACKUP_DIR);
    const sessionBackups = backups.filter(b => b.startsWith('session_')).sort();
    while (sessionBackups.length > 5) {
      const oldest = sessionBackups.shift();
      await fs.remove(path.join(BACKUP_DIR, oldest));
      console.log(`Removed old backup: ${oldest}`);
    }
  } catch (error) {
    console.error('Failed to backup session:', error);
  }
}

// Initialize socket on startup
async function initialize() {
  try {
    console.log('🚀 Initializing WhatsApp automation backend...');
    loadTasks();
    sock = await createWhatsAppSocket();
    console.log('✅ Backend initialized successfully');
  } catch (error) {
    console.error('Failed to initialize:', error);
    setTimeout(initialize, 10000);
  }
}

// API Endpoints
app.post('/login', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber || !phoneNumber.match(/^\d+$/)) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }
  
  try {
    if (sock && sock.user) {
      return res.status(400).json({ error: 'Already connected' });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const tempSocket = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });
    
    const pairingCode = await tempSocket.requestPairingCode(phoneNumber);
    console.log(`Pairing code for ${phoneNumber}: ${pairingCode}`);
    
    tempSocket.ev.on('creds.update', saveCreds);
    tempSocket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        sock = tempSocket;
        res.json({ success: true, message: 'Connected successfully', pairingCode });
      }
    });
    
    setTimeout(() => {
      if (!sock) {
        tempSocket.end(undefined);
        res.status(408).json({ error: 'Pairing timeout' });
      }
    }, 60000);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/startMessaging', upload.single('messagesFile'), async (req, res) => {
  const { target, hatersName, lastName } = req.body;
  
  if (!target || !hatersName || !lastName || !req.file) {
    return res.status(400).json({ error: 'Missing required fields or file' });
  }
  
  if (!sock || !sock.user) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  try {
    const messages = fs.readFileSync(req.file.path, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0);
    
    if (messages.length === 0) {
      return res.status(400).json({ error: 'No valid messages in file' });
    }
    
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const task = {
      taskId,
      target,
      hatersName,
      lastName,
      messages,
      currentIndex: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      sentCount: 0
    };
    
    activeTasks.set(taskId, task);
    saveTasks();
    
    messageQueue.push({
      taskId,
      target,
      messages,
      hatersName,
      lastName,
      currentIndex: 0
    });
    
    if (!isMessagingActive) {
      startMessaging();
    }
    
    res.json({ success: true, taskId, totalMessages: messages.length });
    
    // Cleanup uploaded file
    fs.unlink(req.file.path).catch(console.error);
  } catch (error) {
    console.error('Start messaging error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/stopTask', async (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    return res.status(400).json({ error: 'Task ID required' });
  }
  
  const task = activeTasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  task.status = 'stopped';
  task.stoppedAt = new Date().toISOString();
  activeTasks.set(taskId, task);
  saveTasks();
  
  // Remove from queue if present
  const queueIndex = messageQueue.findIndex(q => q.taskId === taskId);
  if (queueIndex !== -1) {
    messageQueue.splice(queueIndex, 1);
  }
  
  res.json({ success: true, message: 'Task stopped successfully' });
});

app.post('/taskStatus', async (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    const allTasks = Array.from(activeTasks.values());
    return res.json({ tasks: allTasks });
  }
  
  const task = activeTasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  res.json({ task });
});

app.post('/activeTasks', async (req, res) => {
  const tasks = Array.from(activeTasks.values()).filter(t => t.status === 'active');
  res.json({ activeTasks: tasks.length, tasks });
});

app.post('/getGroups', async (req, res) => {
  if (!sock || !sock.user) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  try {
    const groups = [];
    const chats = sock.chats;
    
    for (const [jid, chat] of Object.entries(chats || {})) {
      if (jid.includes('@g.us')) {
        groups.push({
          id: jid,
          name: chat.name || jid,
          participants: chat.participants?.length || 0
        });
      }
    }
    
    res.json({ groups });
  } catch (error) {
    console.error('Get groups error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', async (req, res) => {
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    connected: sock && sock.user ? true : false,
    phoneNumber: sock?.user?.id || null,
    uptime: process.uptime(),
    activeTasks: activeTasks.size,
    queueLength: messageQueue.length,
    isMessagingActive,
    memory: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
    },
    reconnectAttempts,
    isReconnecting,
    timestamp: new Date().toISOString()
  });
});

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  cleanupResources();
  setTimeout(() => initialize(), 5000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  cleanupResources();
  if (sock) sock.end(undefined);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  cleanupResources();
  if (sock) sock.end(undefined);
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Automation Backend`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  initialize();
});
