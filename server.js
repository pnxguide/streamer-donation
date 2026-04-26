const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,   // send ping every 5s
  pingTimeout: 4000,    // disconnect if no pong within 4s
});

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'admin';

// Short-lived tokens issued after successful password check
// token -> expiry timestamp
const validTokens = new Map();
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function isValidToken(token) {
  const expiry = validTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { validTokens.delete(token); return false; }
  return true;
}

app.use(express.static('public'));
app.use(express.json());

// TTS proxy — Google Translate TTS (free, no API key)
app.get('/api/tts', (req, res) => {
  const text = String(req.query.text || '').slice(0, 200);
  if (!text) return res.status(400).end();

  const path = '/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q='
    + encodeURIComponent(text);

  const options = {
    hostname: 'translate.google.com',
    path,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  };

  https.get(options, (upstream) => {
    if (upstream.statusCode !== 200) {
      res.status(502).end();
      upstream.resume();
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    upstream.pipe(res);
  }).on('error', () => res.status(500).end());
});

// Host auth endpoint
app.post('/api/host-auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== HOST_PASSWORD) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  res.json({ token: issueToken() });
});

let hostCount = 0;

io.on('connection', (socket) => {
  // Immediately tell the new client the current host count
  socket.emit('host:count', hostCount);

  socket.on('host:join', ({ token } = {}) => {
    if (!isValidToken(token)) {
      socket.emit('host:rejected');
      return;
    }
    socket.join('hosts');
    hostCount++;
    io.emit('host:count', hostCount);
  });

  socket.on('donation:send', (data) => {
    const donation = {
      id: Date.now(),
      name: String(data.name || 'ไม่ระบุชื่อ').slice(0, 16),
      amount: Math.max(0, parseFloat(data.amount) || 0),
      message: String(data.message || '').slice(0, 64),
      currency: 'THB',
      timestamp: new Date().toISOString(),
    };
    io.to('hosts').emit('donation:received', donation);
    socket.emit('donation:confirmed', { id: donation.id });
  });

  socket.on('disconnect', () => {
    if (socket.rooms.has('hosts')) {
      hostCount = Math.max(0, hostCount - 1);
      io.emit('host:count', hostCount);
    }
  });
});

server.listen(PORT, () => {
  console.log(`DonationMimic running at http://localhost:${PORT}`);
  console.log(`  Donor page:   http://localhost:${PORT}/`);
  console.log(`  Host overlay: http://localhost:${PORT}/host.html`);
  console.log(`  Host password: ${HOST_PASSWORD}`);
});
