// Serveur web : controle manuel + assistant LLM de la lampe LIFX
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createLamp, clamp } = require('./lamp');
const agent = require('./agent');

// ---------- .env (GROQ_API_KEY, GROQ_MODEL) ----------
const ENV = path.join(__dirname, '.env');
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const CONFIG = path.join(__dirname, 'config.json');
const PORT = 3000;
if (!fs.existsSync(CONFIG)) {
  console.error('config.json introuvable. Lance d\'abord : npm run discover');
  process.exit(1);
}
const { ip, mac, label } = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const lamp = createLamp({ ip, mac });

// "#ff8800" -> { hue 0-360, saturation 0-100 }
function hexToHueSat(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: (h * 60 + 360) % 360, saturation: max ? (d / max) * 100 : 0 };
}

// ---------- Verrou "eteint pendant X secondes" ----------
// On ne peut pas bloquer les paquets des autres PC : on renvoie "OFF" en boucle.
const lock = { until: 0, timer: null, busy: false };
const isLocked = () => Date.now() < lock.until;
const lockLeft = () => (isLocked() ? Math.ceil((lock.until - Date.now()) / 1000) : 0);

function startLock(seconds) {
  lamp.stopScene();
  lock.until = Date.now() + seconds * 1000;
  clearInterval(lock.timer);
  lock.timer = setInterval(async () => {
    if (!isLocked()) { clearInterval(lock.timer); lock.timer = null; return; }
    if (lock.busy) return;
    lock.busy = true;
    try { await lamp.power(false, 0); } catch (e) {}
    lock.busy = false;
  }, 300);
}

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// MediaPipe (detection de la main) servi en local pour la page gestes
app.use('/mediapipe', express.static(path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision')));

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && isLocked()) {
    return res.status(423).json({ error: 'Lampe verrouillee', lockLeft: lockLeft() });
  }
  next();
});

const route = fn => async (req, res) => {
  try { res.json(await fn(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/api/state', route(async () => {
  try {
    const s = await lamp.state();
    return { ip, ...s, label: s.label || label, lockLeft: lockLeft() };
  } catch (e) {
    if (isLocked()) return { ip, label, power: false, lockLeft: lockLeft() };
    throw e;
  }
}));

app.post('/api/power', route(async ({ on }) => {
  lamp.stopScene();
  await lamp.power(!!on);
  return { ok: true };
}));

app.post('/api/color', route(async ({ hex }) => {
  lamp.stopScene();
  await lamp.setColor(hexToHueSat(hex));
  return { ok: true };
}));

app.post('/api/white', route(async ({ kelvin }) => {
  lamp.stopScene();
  await lamp.setColor({ saturation: 0, kelvin });
  return { ok: true };
}));

app.post('/api/brightness', route(async ({ value }) => {
  lamp.stopScene();
  await lamp.setColor({ brightness: clamp(value, 0, 100) });
  return { ok: true };
}));

app.post('/api/effect', route(async ({ type, period }) => {
  if (type === 'stop') { await lamp.stopAll(); return { ok: true }; }
  lamp.stopScene();
  await lamp.waveform({
    type: type === 'blink' ? 'pulse' : 'sine',
    brightness: type === 'blink' ? 0 : 3,
    period_ms: period || 1000
  });
  return { ok: true };
}));

app.post('/api/lock', route(async ({ seconds }) => {
  const s = Math.round(clamp(seconds || 60, 5, 300));
  startLock(s);
  return { ok: true, lockLeft: s };
}));

// Assistant LLM : { history: [{ role, content }] }
app.post('/api/chat', route(async ({ history }) => {
  if (!Array.isArray(history) || !history.length) throw new Error('Message vide');
  const clean = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));
  return agent.chat(lamp, clean);
}));

// Speech-to-text : corps = audio brut (webm/ogg/mp4)
app.post('/api/transcribe', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw new Error('Audio trop court');
    res.json({ text: await agent.transcribe(req.body, req.headers['content-type'] || 'audio/webm', String(req.query.lang || '')) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Lampe : ${label} (${ip})`);
  console.log(`Assistant LLM : ${process.env.GROQ_API_KEY ? 'pret' : 'cle manquante (.env)'}`);
  console.log(`Interface : http://localhost:${PORT}`);
  console.log(`Gestes    : http://localhost:${PORT}/gestures.html`);
});
