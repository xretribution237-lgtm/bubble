require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// Railway sits behind a reverse proxy — needed for cookies/sessions to work
app.set('trust proxy', 1);

// ─── ADMIN DISCORD IDs ────────────────────────────────────────────────────────
const ADMIN_IDS = {
  '1429171703879307277': 'owner',
  '1472967180747280562': 'owner',
  '1474153224654028850': 'co-owner',
  '1472967373198721137': 'admin',
};

// ─── FILE-BASED PERSISTENCE ───────────────────────────────────────────────────
// Saves to /data/*.json  —  survives restarts.
// On Railway: attach a Volume mounted at /data so it survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Create empty files on first run
if (!fs.existsSync(path.join(DATA_DIR, 'products.json'))) writeJSON('products.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'orders.json')))   writeJSON('orders.json',   []);

// Convenience accessors — always hit disk so nothing gets lost on crash
const db = {
  get products() { return readJSON('products.json', []); },
  set products(v) { writeJSON('products.json', v); },
  get orders()   { return readJSON('orders.json',   []); },
  set orders(v)  { writeJSON('orders.json',   v); },
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));         // allow base64 image uploads
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'nml-change-this-please',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000,   // 7 days
    secure:   true,
    sameSite: 'lax',
  },
}));

function requireAdmin(req, res, next) {
  if (!req.session.user || !ADMIN_IDS[req.session.user.discordId]) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ─── DISCORD OAUTH ────────────────────────────────────────────────────────────

// GET /auth/discord  →  redirect the browser to Discord's auth page
app.get('/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) {
    return res.status(500).send(`
      <h2>⚠️ DISCORD_CLIENT_ID not set</h2>
      <p>Add it to your .env file and restart the server.</p>
      <a href="/">← Back</a>
    `);
  }
  const redirectUri = process.env.DISCORD_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/auth/callback`;

  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'identify email',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// GET /auth/callback  →  Discord sends the user back here with ?code=
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?auth=failed');

  const redirectUri = process.env.DISCORD_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/auth/callback`;

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('❌ Discord token error:', JSON.stringify(tokenData));
      return res.redirect('/?auth=failed');
    }

    // Get the Discord user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const u = await userRes.json();
    if (!u.id) throw new Error('No user ID returned from Discord');

    const isAdmin = !!ADMIN_IDS[u.id];
    req.session.user = {
      discordId: u.id,
      username:  u.username,
      avatar:    u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
        : null,
      email:     u.email || '',
      isAdmin,
      role:      ADMIN_IDS[u.id] || 'customer',
    };

    console.log(`✅ Login: ${u.username} (${u.id}) — ${isAdmin ? 'ADMIN' : 'customer'}`);
    res.redirect(isAdmin ? '/admin' : '/');
  } catch (err) {
    console.error('❌ Auth callback error:', err.message);
    res.redirect('/?auth=failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  let list = db.products;
  const { tag, type, search } = req.query;
  if (tag)    list = list.filter(p => p.tags?.includes(tag));
  if (type)   list = list.filter(p => p.type === type);
  if (search) list = list.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(search.toLowerCase())
  );
  res.json(list);
});

app.get('/api/products/:id', (req, res) => {
  const p = db.products.find(p => p.id === req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/products', requireAdmin, (req, res) => {
  const products = db.products;
  const p = { ...req.body, id: 'p' + uuidv4().slice(0, 8), createdAt: new Date().toISOString() };
  products.unshift(p);
  db.products = products;
  console.log(`✅ Product created: "${p.name}" by ${req.session.user.username}`);
  res.json(p);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const products = db.products;
  const i = products.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  products[i] = { ...products[i], ...req.body, id: req.params.id };
  db.products = products;
  console.log(`✅ Product updated: "${products[i].name}" by ${req.session.user.username}`);
  res.json(products[i]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const products = db.products;
  const i = products.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  const name = products[i].name;
  products.splice(i, 1);
  db.products = products;
  console.log(`🗑️  Product deleted: "${name}" by ${req.session.user.username}`);
  res.json({ ok: true });
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Login required' });
  const all = db.orders;
  const list = ADMIN_IDS[u.discordId]
    ? all
    : all.filter(o => o.discordId === u.discordId || o.email === u.email);
  res.json(list);
});

app.post('/api/orders', (req, res) => {
  const orders = db.orders;
  const order = {
    ...req.body,
    id:        'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    status:    'pending',
    date:      new Date().toISOString().split('T')[0],
    discordId: req.session.user?.discordId || null,
  };
  orders.unshift(order);
  db.orders = orders;
  console.log(`📦 New order ${order.id} — ${order.customer} — $${order.total}`);
  res.json(order);
});

app.patch('/api/orders/:id/status', requireAdmin, (req, res) => {
  const orders = db.orders;
  const o = orders.find(o => o.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = req.body.status;
  db.orders = orders;
  res.json(o);
});

// ─── BOT API ──────────────────────────────────────────────────────────────────
app.post('/api/bot/verify', (req, res) => {
  const { discordId } = req.body;
  res.json({ isAdmin: !!ADMIN_IDS[discordId], role: ADMIN_IDS[discordId] || 'customer' });
});

app.get('/api/bot/orders', (req, res) => {
  if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(db.orders.slice(0, 20));
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  ok: true,
  products: db.products.length,
  orders:   db.orders.length,
}));

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛍️  N.M.L ShopWave running at http://localhost:${PORT}`);
  console.log(`📁  Data:    ${DATA_DIR}`);
  console.log(`🔑  Discord: ${process.env.DISCORD_CLIENT_ID ? '✅ configured' : '⚠️  DISCORD_CLIENT_ID not set!'}`);
  if (!process.env.DISCORD_CLIENT_ID) {
    console.log(`\n   → Copy .env.example to .env and fill in your Discord app credentials.\n`);
  }
});
