const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 200);
  if (!text) return res.status(400).end();

  const url = 'https://translate.google.com/translate_tts?ie=UTF-8'
    + '&client=tw-ob'
    + '&tl=th'
    + `&q=${encodeURIComponent(text)}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!upstream.ok) return res.status(502).end();
    res.setHeader('Content-Type', 'audio/mpeg');
    const buf = await upstream.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (e) {
    res.status(500).end();
  }
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
      name: String(data.name || 'ไม่ระบุชื่อ').slice(0, 50),
      amount: Math.max(0, parseFloat(data.amount) || 0),
      message: String(data.message || '').slice(0, 300),
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
