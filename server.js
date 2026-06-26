'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

// --- Load .env locally (Vercel injects env vars directly) ----------------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const db = require('./db');
const storage = require('./storage');
const sheets = require('./sheets');
const telegram = require('./telegram');

const ENTRY_PASSWORD = process.env.ENTRY_PASSWORD || 'bills123';
const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || 'finance123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const CURRENCY = process.env.CURRENCY || '₹';
const PORT = process.env.PORT || 3000;
const DEFAULT_TAGS = (process.env.DEFAULT_TAGS || '3061')
  .split(',').map((s) => s.trim()).filter(Boolean);

// --- Auth helpers --------------------------------------------------------
function sign(role) {
  const payload = `${role}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verify(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [role, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${role}.${ts}`).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (role !== 'entry' && role !== 'finance') return null;
  return role;
}

const app = express();
app.use(express.json());
app.use(cookieParser());

// Ensure schema + default tags exist (runs once per cold start).
let seedPromise = null;
function ensureReady() {
  if (!seedPromise) {
    seedPromise = (async () => {
      await db.init();
      if (storage.enabled()) await storage.initBucket();
      for (const name of DEFAULT_TAGS) {
        await db.query(
          `INSERT INTO tags (name, pinned) VALUES ($1, true)
           ON CONFLICT (lower(name)) DO UPDATE SET pinned = true`, [name]);
      }
    })().catch((err) => { seedPromise = null; throw err; });
  }
  return seedPromise;
}
app.use('/api', async (req, res, next) => {
  try { await ensureReady(); next(); }
  catch (err) { console.error('DB init failed:', err.message); res.status(500).json({ error: 'Database not reachable. Check DATABASE_URL.' }); }
});

function roleOf(req) { return verify(req.cookies && req.cookies.auth); }
function requireAuth(req, res, next) {
  const role = roleOf(req);
  if (!role) return res.status(401).json({ error: 'Not logged in' });
  req.role = role;
  next();
}
function requireFinance(req, res, next) {
  if (roleOf(req) !== 'finance') return res.status(403).json({ error: 'Finance access required' });
  next();
}

async function upsertTag(name) {
  const clean = String(name).trim();
  if (!clean) return null;
  const r = await db.query(
    `INSERT INTO tags (name) VALUES ($1)
     ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name
     RETURNING id`, [clean]);
  return r.rows[0].id;
}

// --- Login / session -----------------------------------------------------
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  let role = null;
  if (password && password === FINANCE_PASSWORD) role = 'finance';
  else if (password && password === ENTRY_PASSWORD) role = 'entry';
  if (!role) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('auth', sign(role), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ role });
});
app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ role: roleOf(req), currency: CURRENCY }); });

// --- Tags ----------------------------------------------------------------
app.get('/api/tags', requireAuth, async (req, res) => {
  const r = await db.query(`
    SELECT t.name, t.pinned, COUNT(bt.bill_id)::int AS count
    FROM tags t LEFT JOIN bill_tags bt ON bt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.pinned DESC, count DESC, t.name ASC
  `);
  res.json(r.rows);
});

app.post('/api/tags', requireAuth, async (req, res) => {
  const name = req.body && req.body.name ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Tag name required' });
  await upsertTag(name);
  res.json({ name });
});

app.delete('/api/tags/:name', requireAuth, async (req, res) => {
  const r = await db.query('SELECT id, pinned FROM tags WHERE lower(name) = lower($1)', [req.params.name]);
  if (!r.rows.length) return res.status(404).json({ error: 'Tag not found' });
  if (r.rows[0].pinned) return res.status(400).json({ error: 'Default company tag cannot be removed' });
  await db.query('DELETE FROM tags WHERE id = $1', [r.rows[0].id]);
  res.json({ ok: true });
});

// --- File uploads (memory -> Cloudinary) ---------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype) || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only images or PDF allowed'));
  },
});

// --- Create a bill -------------------------------------------------------
app.post('/api/bills', requireAuth, upload.array('screenshots', 8), async (req, res) => {
  try {
    const b = req.body || {};
    let tags = [];
    if (b.tags) { try { tags = JSON.parse(b.tags); } catch { tags = String(b.tags).split(','); } }
    tags = tags.map((t) => String(t).trim()).filter(Boolean);
    const billType = (b.bill_type && String(b.bill_type).trim()) || tags.join(', ');
    if (!billType) return res.status(400).json({ error: 'Pick at least one bill type' });

    const ins = await db.query(`
      INSERT INTO bills (bill_type, vendor, amount, currency, bill_date, due_date, status, note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [
      billType,
      b.vendor ? String(b.vendor).trim() : null,
      b.amount ? Number(b.amount) : null,
      CURRENCY,
      b.bill_date || new Date().toISOString().slice(0, 10),
      b.due_date || null,
      ['unpaid', 'paid', 'reviewed'].includes(b.status) ? b.status : 'unpaid',
      b.note ? String(b.note).trim() : null,
      req.role,
    ]);
    const billId = ins.rows[0].id;

    for (const name of tags) {
      const tagId = await upsertTag(name);
      if (tagId) await db.query('INSERT INTO bill_tags (bill_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [billId, tagId]);
    }

    for (const f of req.files || []) {
      if (!storage.enabled()) break;
      const up = await storage.upload(f.buffer, { mime: f.mimetype });
      await db.query(`
        INSERT INTO attachments (bill_id, url, public_id, original_name, mime, size)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [billId, up.url, up.public_id, f.originalname, f.mimetype, f.size]);
    }

    sheets.syncBill(billId);
    res.json({ id: billId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to save bill' });
  }
});

// --- Attachment loader ----------------------------------------------------
async function attachmentsFor(billIds) {
  if (!billIds.length) return {};
  const r = await db.query(
    'SELECT id, bill_id, url, mime, original_name FROM attachments WHERE bill_id = ANY($1)', [billIds]);
  const map = {};
  for (const a of r.rows) (map[a.bill_id] = map[a.bill_id] || []).push(a);
  return map;
}

// --- List bills with filters --------------------------------------------
app.get('/api/bills', requireAuth, async (req, res) => {
  const { tag, type, status, q, from, to } = req.query;
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  if (type) where.push(`b.bill_type = ${p(type)}`);
  if (status) where.push(`b.status = ${p(status)}`);
  if (from) where.push(`b.bill_date >= ${p(from)}`);
  if (to) where.push(`b.bill_date <= ${p(to)}`);
  if (q) where.push(`(b.bill_type ILIKE ${p('%' + q + '%')} OR b.vendor ILIKE $${params.length} OR b.note ILIKE $${params.length})`);
  if (tag) where.push(`b.id IN (SELECT bt.bill_id FROM bill_tags bt JOIN tags t ON t.id = bt.tag_id WHERE lower(t.name) = lower(${p(tag)}))`);

  const sql = `
    SELECT b.*, COALESCE(b.amount::float8, NULL) AS amount,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM bills b
    LEFT JOIN bill_tags bt ON bt.bill_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY b.id
    ORDER BY b.bill_date DESC NULLS LAST, b.id DESC
    LIMIT 1000
  `;
  const r = await db.query(sql, params);
  const bills = r.rows;
  const attMap = await attachmentsFor(bills.map((x) => x.id));
  for (const bill of bills) bill.attachments = attMap[bill.id] || [];

  const total = bills.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  res.json({ bills, count: bills.length, total, currency: CURRENCY });
});

app.get('/api/bills/:id', requireAuth, async (req, res) => {
  const r = await db.query(`
    SELECT b.*, b.amount::float8 AS amount,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM bills b
    LEFT JOIN bill_tags bt ON bt.bill_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id
    WHERE b.id = $1 GROUP BY b.id
  `, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const bill = r.rows[0];
  bill.attachments = (await attachmentsFor([bill.id]))[bill.id] || [];
  res.json(bill);
});

// --- Update status (finance) --------------------------------------------
app.patch('/api/bills/:id', requireAuth, requireFinance, async (req, res) => {
  const { status } = req.body || {};
  if (!['unpaid', 'paid', 'reviewed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const r = await db.query('UPDATE bills SET status = $1 WHERE id = $2', [status, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  sheets.syncBill(req.params.id);
  res.json({ ok: true });
});

// --- Delete (finance) ----------------------------------------------------
app.delete('/api/bills/:id', requireAuth, requireFinance, async (req, res) => {
  const atts = await db.query('SELECT public_id FROM attachments WHERE bill_id = $1', [req.params.id]);
  await db.query('DELETE FROM bills WHERE id = $1', [req.params.id]);
  for (const a of atts.rows) storage.destroy(a.public_id);
  sheets.deleteBill(req.params.id);
  res.json({ ok: true });
});

// --- CSV export (finance) ------------------------------------------------
app.get('/api/export.csv', requireAuth, requireFinance, async (req, res) => {
  const r = await db.query(`
    SELECT b.*, b.amount::float8 AS amount,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM bills b
    LEFT JOIN bill_tags bt ON bt.bill_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id
    GROUP BY b.id ORDER BY b.bill_date DESC NULLS LAST, b.id DESC
  `);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['id', 'date', 'type', 'vendor', 'amount', 'currency', 'status', 'due_date', 'tags', 'note', 'created_at'];
  const lines = [header.join(',')];
  for (const b of r.rows) {
    lines.push([b.id, b.bill_date, b.bill_type, b.vendor, b.amount, b.currency, b.status, b.due_date,
      (b.tags || []).join('; '), b.note, b.created_at && new Date(b.created_at).toISOString()].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// --- Telegram webhook ----------------------------------------------------
app.post('/api/telegram', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately so Telegram doesn't retry
  if (!telegram.enabled()) return;
  try { await telegram.handleUpdate(req.body); }
  catch (e) { console.error('Telegram handler error:', e.message); }
});

// One-time setup: registers the webhook URL with Telegram.
// Visit /api/telegram/setup in a browser after deploying.
app.get('/api/telegram/setup', async (req, res) => {
  if (!telegram.enabled()) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${proto}://${host}/api/telegram`;
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
  });
  const data = await r.json();
  res.json({ webhookUrl, telegram: data });
});

// --- Static frontend -----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload error' });
  next();
});

// Only listen when run directly (local dev). On Vercel the app is imported.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Bill Tracker running:  http://localhost:${PORT}`);
    console.log(`  Entry password:   ${ENTRY_PASSWORD}`);
    console.log(`  Finance password: ${FINANCE_PASSWORD}`);
    console.log(`  Database:          ${process.env.DATABASE_URL ? 'configured' : 'NOT SET (DATABASE_URL)'}`);
    console.log(`  File storage:      ${storage.enabled() ? 'Supabase Storage' : 'NOT SET (SUPABASE_URL + SUPABASE_SERVICE_KEY)'}`);
    console.log(`  Google Sheet sync: ${sheets.enabled() ? 'ON' : 'off'}\n`);
  });
}

module.exports = app;
