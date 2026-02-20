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
if (!fs.existsSync(path.join(DATA_DIR, 'products.json')))    writeJSON('products.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'orders.json')))      writeJSON('orders.json',   []);
if (!fs.existsSync(path.join(DATA_DIR, 'memberships.json'))) writeJSON('memberships.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'vouches.json')))     writeJSON('vouches.json',  []);
if (!fs.existsSync(path.join(DATA_DIR, 'suggestions.json'))) writeJSON('suggestions.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'settings.json')))    writeJSON('settings.json', {
  vouchChannelId: '',
  suggestionChannelId: '',
  storeName: 'N.M.L ShopWave',
  discordInvite: 'https://discord.gg/w9DrHk5r',
});

// Convenience accessors
const db = {
  get products()    { return readJSON('products.json',    []); },
  set products(v)   { writeJSON('products.json',    v); },
  get orders()      { return readJSON('orders.json',      []); },
  set orders(v)     { writeJSON('orders.json',      v); },
  get memberships() { return readJSON('memberships.json', []); },
  set memberships(v){ writeJSON('memberships.json', v); },
  get vouches()     { return readJSON('vouches.json',     []); },
  set vouches(v)    { writeJSON('vouches.json',     v); },
  get suggestions() { return readJSON('suggestions.json', []); },
  set suggestions(v){ writeJSON('suggestions.json', v); },
  get settings()    { return readJSON('settings.json',    {}); },
  set settings(v)   { writeJSON('settings.json',    v); },
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

// ─── SETTINGS ────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  // Only return sensitive channel IDs to admins
  const s = db.settings;
  if (req.session.user && ADMIN_IDS[req.session.user.discordId]) {
    return res.json(s);
  }
  res.json({ storeName: s.storeName, discordInvite: s.discordInvite });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  res.json(db.settings);
});

// ─── MEMBERSHIPS ──────────────────────────────────────────────────────────────
app.get('/api/memberships', requireAdmin, (req, res) => {
  res.json(db.memberships);
});

app.get('/api/memberships/:discordId', (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Login required' });
  // User can only view their own, admin can view anyone
  if (u.discordId !== req.params.discordId && !ADMIN_IDS[u.discordId]) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const m = db.memberships.find(m => m.discordId === req.params.discordId);
  res.json(m || null);
});

app.post('/api/memberships', requireAdmin, (req, res) => {
  const { discordId, username, note } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  const memberships = db.memberships;
  const existing = memberships.find(m => m.discordId === discordId);
  if (existing) return res.status(409).json({ error: 'Already has membership' });
  const m = {
    discordId, username: username || '',
    note: note || '',
    theme: 'default',
    addedAt: new Date().toISOString(),
    addedBy: req.session.user.username,
  };
  memberships.push(m);
  db.memberships = memberships;
  console.log(`💎 Membership added: ${username} (${discordId}) by ${req.session.user.username}`);
  res.json(m);
});

app.delete('/api/memberships/:discordId', requireAdmin, (req, res) => {
  const memberships = db.memberships;
  const i = memberships.findIndex(m => m.discordId === req.params.discordId);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  const name = memberships[i].username;
  memberships.splice(i, 1);
  db.memberships = memberships;
  console.log(`❌ Membership revoked: ${name} by ${req.session.user.username}`);
  res.json({ ok: true });
});

// Update theme (member can update their own, admin can update anyone)
app.patch('/api/memberships/:discordId/theme', (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Login required' });
  if (u.discordId !== req.params.discordId && !ADMIN_IDS[u.discordId]) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const memberships = db.memberships;
  const m = memberships.find(m => m.discordId === req.params.discordId);
  if (!m) return res.status(404).json({ error: 'No membership' });
  m.theme = req.body.theme;
  m.customColors = req.body.customColors || null;
  db.memberships = memberships;
  res.json(m);
});

// ─── VOUCHES ──────────────────────────────────────────────────────────────────
app.get('/api/vouches', (req, res) => {
  res.json(db.vouches);
});

app.post('/api/vouches', (req, res) => {
  // Called by bot after posting in Discord
  const vouches = db.vouches;
  const v = {
    id: 'V-' + Date.now(),
    ...req.body,
    createdAt: new Date().toISOString(),
  };
  vouches.unshift(v);
  db.vouches = vouches;
  res.json(v);
});

// ─── SUGGESTIONS ──────────────────────────────────────────────────────────────
app.get('/api/suggestions', requireAdmin, (req, res) => {
  res.json(db.suggestions);
});

app.post('/api/suggestions', (req, res) => {
  // Called by bot after posting in Discord
  const suggestions = db.suggestions;
  const s = {
    id: 'S-' + Date.now(),
    ...req.body,
    createdAt: new Date().toISOString(),
  };
  suggestions.unshift(s);
  db.suggestions = suggestions;
  res.json(s);
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

app.get('/api/bot/order/:id', (req, res) => {
  if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const o = db.orders.find(o => o.id === req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/bot/membership/:discordId', (req, res) => {
  if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const m = db.memberships.find(m => m.discordId === req.params.discordId);
  res.json(m || null);
});

app.post('/api/bot/membership/add', (req, res) => {
  if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { discordId, username, addedBy } = req.body;
  const memberships = db.memberships;
  if (memberships.find(m => m.discordId === discordId)) {
    return res.status(409).json({ error: 'Already has membership' });
  }
  const m = { discordId, username, note: '', theme: 'default', addedAt: new Date().toISOString(), addedBy };
  memberships.push(m);
  db.memberships = memberships;
  res.json(m);
});

app.post('/api/bot/membership/revoke', (req, res) => {
  if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { discordId } = req.body;
  const memberships = db.memberships;
  const i = memberships.findIndex(m => m.discordId === discordId);
  if (i === -1) return res.status(404).json({ error: 'No membership found' });
  memberships.splice(i, 1);
  db.memberships = memberships;
  res.json({ ok: true });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  ok: true,
  products: db.products.length,
  orders:   db.orders.length,
  memberships: db.memberships.length,
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
