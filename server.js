const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,
  pingTimeout: 4000,
});

const PORT           = process.env.PORT || 3000;
const HOST_PASSWORD  = process.env.HOST_PASSWORD  || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'moderator';

// ── Token store ──────────────────────────────────────────────
const validTokens = new Map(); // token -> { role, expiry }
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function issueToken(role) {
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.set(token, { role, expiry: Date.now() + TOKEN_TTL_MS });
  return token;
}

function getTokenRole(token) {
  const entry = validTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { validTokens.delete(token); return null; }
  return entry.role;
}

app.use(express.static('public'));
app.use(express.json());

// ── TTS proxy ────────────────────────────────────────────────
app.get('/api/tts', (req, res) => {
  const text = String(req.query.text || '').slice(0, 200);
  if (!text) return res.status(400).end();

  const path = '/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q='
    + encodeURIComponent(text);

  https.get({ hostname: 'translate.google.com', path, headers: { 'User-Agent': 'Mozilla/5.0' } },
    (upstream) => {
      if (upstream.statusCode !== 200) { res.status(502).end(); upstream.resume(); return; }
      res.setHeader('Content-Type', 'audio/mpeg');
      upstream.pipe(res);
    }
  ).on('error', () => res.status(500).end());
});

// ── Auth endpoints ───────────────────────────────────────────
app.post('/api/host-auth', (req, res) => {
  if (req.body.password !== HOST_PASSWORD)
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ token: issueToken('host') });
});

app.post('/api/admin-auth', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ token: issueToken('admin') });
});

// ── State ────────────────────────────────────────────────────
let hostCount = 0;
const hostSockets  = new Set();
const pendingQueue = new Map(); // id -> donation

function broadcastHostCount() { io.emit('host:count', hostCount); }
function broadcastPending()   { io.to('admins').emit('moderation:queue', [...pendingQueue.values()]); }

// ── Sockets ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('host:count', hostCount);

  // Host joins
  socket.on('host:join', ({ token } = {}) => {
    if (getTokenRole(token) !== 'host') { socket.emit('host:rejected'); return; }
    socket.join('hosts');
    hostSockets.add(socket.id);
    hostCount++;
    broadcastHostCount();
  });

  // Admin joins
  socket.on('admin:join', ({ token } = {}) => {
    if (getTokenRole(token) !== 'admin') { socket.emit('admin:rejected'); return; }
    socket.join('admins');
    // Send current queue immediately
    socket.emit('moderation:queue', [...pendingQueue.values()]);
  });

  // Donor sends a donation → goes to pending queue
  socket.on('donation:send', (data) => {
    const donation = {
      id: Date.now().toString(),
      name:    String(data.name    || 'ไม่ระบุชื่อ').slice(0, 16),
      amount:  Math.max(0, parseFloat(data.amount) || 0),
      message: String(data.message || '').slice(0, 64),
      currency: 'THB',
      timestamp: new Date().toISOString(),
      donorSocket: socket.id,
    };
    pendingQueue.set(donation.id, donation);
    // Tell donor it's queued
    socket.emit('donation:queued', { id: donation.id });
    // Notify all admins
    broadcastPending();
  });

  // Admin approves
  socket.on('moderation:approve', ({ id } = {}) => {
    if (!socket.rooms.has('admins')) return;
    const donation = pendingQueue.get(id);
    if (!donation) return;
    pendingQueue.delete(id);
    const { donorSocket, ...payload } = donation;
    io.to('hosts').emit('donation:received', payload);
    broadcastPending();
  });

  // Admin rejects
  socket.on('moderation:reject', ({ id } = {}) => {
    if (!socket.rooms.has('admins')) return;
    if (!pendingQueue.has(id)) return;
    pendingQueue.delete(id);
    broadcastPending();
  });

  socket.on('disconnect', () => {
    if (hostSockets.has(socket.id)) {
      hostSockets.delete(socket.id);
      hostCount = Math.max(0, hostCount - 1);
      broadcastHostCount();
    }
  });
});

server.listen(PORT, () => {
  console.log(`DonationMimic running at http://localhost:${PORT}`);
  console.log(`  Donor page:   http://localhost:${PORT}/`);
  console.log(`  Host overlay: http://localhost:${PORT}/host.html`);
  console.log(`  Admin/Mod:    http://localhost:${PORT}/admin.html`);
  console.log(`  Host password:  ${HOST_PASSWORD}`);
  console.log(`  Admin password: ${ADMIN_PASSWORD}`);
});
