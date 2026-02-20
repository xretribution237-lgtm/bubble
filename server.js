require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ADMIN DISCORD IDs ────────────────────────────────────────────────────────
const ADMIN_IDS = {
  '1429171703879307277': 'owner',
  '1472967180747280562': 'owner',
  '1474153224654028850': 'co-owner',
  '1472967373198721137': 'admin',
};

// ─── IN-MEMORY DATA (swap with DB on Railway) ─────────────────────────────────
const db = {
  products: [
    {
      id: 'p1', name: 'Premium Discord Bot License', type: 'digital',
      price: 24.99, originalPrice: 39.99,
      description: 'Full lifetime license. Includes all features, updates & priority support.',
      images: ['https://placehold.co/600x600/dbeafe/2563eb?text=🤖'],
      tags: ['HOT', 'SALE'], stock: null,
      variants: [
        { name: '1 Server', price: 24.99 },
        { name: '3 Servers', price: 49.99 },
        { name: 'Unlimited', price: 89.99 },
      ],
    },
    {
      id: 'p2', name: 'N.M.L Hoodie — Logo Edition', type: 'physical',
      price: 49.99, originalPrice: null,
      description: 'Premium embroidered hoodie. Soft, warm, and built to last.',
      images: ['https://placehold.co/600x600/f3e8ff/7e22ce?text=👕'],
      tags: ['NEW'], stock: 25,
      variants: [
        { name: 'S', price: 49.99 }, { name: 'M', price: 49.99 },
        { name: 'L', price: 49.99 }, { name: 'XL', price: 52.99 }, { name: '2XL', price: 54.99 },
      ],
    },
    {
      id: 'p3', name: 'Starter Pack Bundle', type: 'digital',
      price: 14.99, originalPrice: 29.99,
      description: 'Templates, guides, and exclusive community access. Instant delivery.',
      images: ['https://placehold.co/600x600/dcfce7/15803d?text=📦'],
      tags: ['SALE', 'BESTSELLER'], stock: null, variants: null,
    },
    {
      id: 'p4', name: 'Member NFC Card v2', type: 'physical',
      price: null, originalPrice: null,
      description: 'Exclusive NFC-enabled member card. Limited run for verified members only.',
      images: ['https://placehold.co/600x600/ffedd5/c2410c?text=💳'],
      tags: ['COMING SOON'], stock: 0, variants: null,
    },
    {
      id: 'p5', name: 'Pro Design Assets Bundle', type: 'digital',
      price: 19.99, originalPrice: null,
      description: '500+ assets, icons, templates and UI kits. One-time purchase.',
      images: ['https://placehold.co/600x600/fce7f3/be185d?text=🎨'],
      tags: ['HOT', 'FEATURED'], stock: null,
      variants: [
        { name: 'Basic — 200 assets', price: 19.99 },
        { name: 'Pro — 500 assets', price: 34.99 },
      ],
    },
    {
      id: 'p6', name: 'Enamel Pin Set', type: 'physical',
      price: 12.99, originalPrice: null,
      description: 'Set of 3 high-quality enamel pins. Grab yours before they\'re gone!',
      images: ['https://placehold.co/600x600/fef9c3/854d0e?text=📌'],
      tags: ['LIMITED'], stock: 8, variants: null,
    },
  ],
  orders: [
    { id: 'ORD-ABC123', customer: 'Jake M.', email: 'jake@example.com', discord: 'jakecool', items: [{ name: 'Premium Discord Bot License', variant: '1 Server', qty: 1, price: 24.99 }], total: 24.99, status: 'delivered', type: 'digital', date: '2025-02-15', notes: '' },
    { id: 'ORD-DEF456', customer: 'Sarah L.', email: 'sarah@example.com', discord: '', items: [{ name: 'N.M.L Hoodie', variant: 'L', qty: 1, price: 49.99 }], total: 49.99, status: 'shipped', type: 'physical', date: '2025-02-17', notes: 'Leave at door' },
    { id: 'ORD-GHI789', customer: 'Alex B.', email: 'alex@example.com', discord: 'alexb', items: [{ name: 'Starter Pack Bundle', variant: null, qty: 1, price: 14.99 }], total: 14.99, status: 'processing', type: 'digital', date: '2025-02-18', notes: '' },
    { id: 'ORD-JKL012', customer: 'Rio K.', email: 'rio@example.com', discord: '', items: [{ name: 'Enamel Pin Set', variant: null, qty: 2, price: 12.99 }], total: 25.98, status: 'pending', type: 'physical', date: '2025-02-19', notes: '' },
  ],
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'nml-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function requireAdmin(req, res, next) {
  if (!req.session.user || !ADMIN_IDS[req.session.user.discordId]) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.DISCORD_REDIRECT_URI,
      }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('No token');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const u = await userRes.json();

    req.session.user = {
      discordId: u.id,
      username:  u.username,
      avatar:    u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
      email:     u.email || '',
      isAdmin:   !!ADMIN_IDS[u.id],
      role:      ADMIN_IDS[u.id] || 'customer',
    };
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ─── DEMO LOGIN (remove in production) ────────────────────────────────────────
app.post('/api/demo-login', (req, res) => {
  const roles = {
    owner:    { discordId: '1429171703879307277', username: 'Owner',    avatar: null, email: '', isAdmin: true,  role: 'owner'    },
    admin:    { discordId: '1472967373198721137', username: 'AdminUser',avatar: null, email: '', isAdmin: true,  role: 'admin'    },
    customer: { discordId: '0000000000000000001', username: 'Customer', avatar: null, email: '', isAdmin: false, role: 'customer' },
  };
  req.session.user = roles[req.body.role] || roles.customer;
  res.json({ user: req.session.user });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  let list = [...db.products];
  const { tag, type, search } = req.query;
  if (tag)    list = list.filter(p => p.tags?.includes(tag));
  if (type)   list = list.filter(p => p.type === type);
  if (search) list = list.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  res.json(list);
});

app.get('/api/products/:id', (req, res) => {
  const p = db.products.find(p => p.id === req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/products', requireAdmin, (req, res) => {
  const p = { ...req.body, id: 'p' + uuidv4().slice(0,8) };
  db.products.unshift(p);
  res.json(p);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const i = db.products.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  db.products[i] = { ...db.products[i], ...req.body };
  res.json(db.products[i]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const i = db.products.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  db.products.splice(i, 1);
  res.json({ ok: true });
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Login required' });
  const list = ADMIN_IDS[u.discordId]
    ? db.orders
    : db.orders.filter(o => o.email === u.email || o.discord === u.username);
  res.json(list);
});

app.post('/api/orders', (req, res) => {
  const order = {
    ...req.body,
    id:     'ORD-' + Math.random().toString(36).slice(2,8).toUpperCase(),
    status: 'pending',
    date:   new Date().toISOString().split('T')[0],
  };
  db.orders.unshift(order);
  res.json(order);
});

app.patch('/api/orders/:id/status', requireAdmin, (req, res) => {
  const o = db.orders.find(o => o.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = req.body.status;
  res.json(o);
});

// ─── BOT API ──────────────────────────────────────────────────────────────────
app.post('/api/bot/verify', (req, res) => {
  const { discordId } = req.body;
  res.json({ isAdmin: !!ADMIN_IDS[discordId], role: ADMIN_IDS[discordId] || 'customer' });
});

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🛍️  N.M.L ShopWave → http://localhost:${PORT}`));
