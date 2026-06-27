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

const XLSX = require('xlsx');
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

// --- Rate limiter (login brute-force) ------------------------------------
const loginAttempts = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (e && now < e.resetAt) {
    if (e.count >= 5) return false;
    e.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  return true;
}

// --- Login / session -----------------------------------------------------
app.post('/api/login', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes.' });
  const { password } = req.body || {};
  let role = null;
  if (password && password === FINANCE_PASSWORD) role = 'finance';
  else if (password && password === ENTRY_PASSWORD) role = 'entry';
  if (!role) return res.status(401).json({ error: 'Wrong password' });
  loginAttempts.delete(ip); // reset on success
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

// --- Update bill (finance) — status-only or full edit -------------------
app.patch('/api/bills/:id', requireAuth, requireFinance, async (req, res) => {
  const { status, bill_type, vendor, amount, bill_date, note } = req.body || {};
  const VALID_STATUS = ['unpaid', 'paid', 'reviewed'];

  // Full edit when more than just status is sent
  if (bill_type !== undefined || vendor !== undefined || amount !== undefined || bill_date !== undefined || note !== undefined) {
    if (!bill_type || !String(bill_type).trim()) return res.status(400).json({ error: 'Bill type required' });
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const newType = String(bill_type).trim();
    const r = await db.query(`
      UPDATE bills SET bill_type=$1, vendor=$2, amount=$3, bill_date=$4, note=$5
        ${status ? ', status=$6' : ''}
      WHERE id=${status ? '$7' : '$6'} RETURNING id`,
      status
        ? [newType, vendor || null, amount != null ? Number(amount) : null, bill_date || null, note || null, status, req.params.id]
        : [newType, vendor || null, amount != null ? Number(amount) : null, bill_date || null, note || null, req.params.id],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    // Re-sync tags: delete old links, upsert new ones from bill_type
    await db.query('DELETE FROM bill_tags WHERE bill_id = $1', [req.params.id]);
    for (const name of newType.split(',').map((s) => s.trim()).filter(Boolean)) {
      const tagId = await upsertTag(name);
      if (tagId) await db.query('INSERT INTO bill_tags (bill_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, tagId]);
    }
    return res.json({ ok: true });
  }

  // Status-only update (existing quick buttons)
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
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

// --- Export auth: finance cookie OR EXPORT_TOKEN query param -------------
function requireExportAuth(req, res, next) {
  const exportToken = process.env.EXPORT_TOKEN;
  if (exportToken && req.query.token === exportToken) return next();
  if (roleOf(req) !== 'finance') return res.status(403).json({ error: 'Finance access required' });
  next();
}

// Shared query for exports (includes attachment URLs)
async function fetchAllBills() {
  const r = await db.query(`
    SELECT b.*, b.amount::float8 AS amount,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags,
      COALESCE(
        (SELECT json_agg(json_build_object('url', a.url, 'mime', a.mime) ORDER BY a.id)
         FROM attachments a WHERE a.bill_id = b.id),
        '[]'::json
      ) AS attachments
    FROM bills b
    LEFT JOIN bill_tags bt ON bt.bill_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id
    GROUP BY b.id ORDER BY b.bill_date DESC NULLS LAST, b.id DESC
  `);
  return r.rows;
}

// --- CSV export ----------------------------------------------------------
app.get('/api/export.csv', requireExportAuth, async (req, res) => {
  const bills = await fetchAllBills();
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['id', 'date', 'type', 'vendor', 'amount', 'currency', 'status', 'due_date', 'tags', 'note', 'created_at', 'attachments'];
  const lines = [header.join(',')];
  for (const b of bills) {
    const attUrls = (b.attachments || []).map((a) => a.url).join('; ');
    lines.push([b.id, b.bill_date, b.bill_type, b.vendor, b.amount, b.currency, b.status, b.due_date,
      (b.tags || []).join('; '), b.note, b.created_at && new Date(b.created_at).toISOString(), attUrls].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// --- XLSX generation (shared) --------------------------------------------
function generateXlsx(bills) {
  const headers = ['ID', 'Date', 'Bill Type', 'Vendor', 'Amount', 'Currency', 'Status', 'Due Date', 'Tags', 'Note', 'Proof'];
  const rows = [
    headers,
    ...bills.map((b) => {
      const atts = b.attachments || [];
      return [
        b.id, b.bill_date || '', b.bill_type || '', b.vendor || '',
        b.amount != null ? Number(b.amount) : '',
        b.currency || '₹', b.status || '', b.due_date || '',
        (b.tags || []).join('; '), b.note || '',
        atts.length ? atts.map((a) => a.url).join('\n') : '',
      ];
    }),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [6, 12, 18, 20, 12, 8, 10, 12, 22, 30, 60].map((wch) => ({ wch }));
  bills.forEach((b, i) => {
    const atts = b.attachments || [];
    if (!atts.length) return;
    const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: 10 });
    if (ws[cellRef]) ws[cellRef].l = { Target: atts[0].url, Tooltip: 'Open proof' };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bills');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// --- XLSX export ---------------------------------------------------------
app.get('/api/export.xlsx', requireAuth, requireFinance, async (req, res) => {
  const buf = generateXlsx(await fetchAllBills());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

// --- Weekly cron: ping DB + send Excel backup to Telegram ----------------
app.get('/api/cron/weekly', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const isVercel = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const isManual = roleOf(req) === 'finance';
  if (!isVercel && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await db.query('SELECT 1'); // keep Supabase alive

    const backupChatId = process.env.TELEGRAM_BACKUP_CHAT_ID;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    if (backupChatId && tgToken) {
      const bills = await fetchAllBills();
      const buf = generateXlsx(bills);
      const date = new Date().toISOString().slice(0, 10);
      const form = new FormData();
      form.append('chat_id', backupChatId);
      form.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `bills-${date}.xlsx`);
      form.append('caption', `📊 Weekly backup — ${date}\n${bills.length} bill${bills.length === 1 ? '' : 's'} total`);
      await fetch(`https://api.telegram.org/bot${tgToken}/sendDocument`, { method: 'POST', body: form });
    }

    res.json({ ok: true, pingedAt: new Date().toISOString(), backupSent: !!(backupChatId && tgToken) });
  } catch (e) {
    console.error('Cron error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Google Sheets IMPORTDATA URL ----------------------------------------
app.get('/api/sheets-url', requireAuth, requireFinance, (req, res) => {
  const exportToken = process.env.EXPORT_TOKEN;
  if (!exportToken) return res.status(400).json({ error: 'Set EXPORT_TOKEN in your Vercel environment variables first' });
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const csvUrl = `${proto}://${req.headers.host}/api/export.csv?token=${exportToken}`;
  res.json({ formula: `=IMPORTDATA("${csvUrl}")`, csvUrl });
});

// --- Telegram webhook ----------------------------------------------------
app.post('/api/telegram', async (req, res) => {
  if (!telegram.enabled()) return res.sendStatus(200);
  try { await telegram.handleUpdate(req.body); }
  catch (e) { console.error('Telegram handler error:', e.message); }
  res.sendStatus(200); // respond after processing — Vercel kills the fn on response
});

// One-time setup: registers webhook + bot commands with Telegram.
// Visit /api/telegram/setup in a browser after deploying.
app.get('/api/telegram/setup', async (req, res) => {
  if (!telegram.enabled()) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${proto}://${req.headers.host}/api/telegram`;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const [webhookRes, commandsRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
    }).then((r) => r.json()),
    fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start',   description: 'Welcome + show menu' },
          { command: 'recent',  description: 'Last 5 bills' },
          { command: 'unpaid',  description: 'All unpaid bills' },
          { command: 'summary', description: 'Totals by bill type' },
        ],
      }),
    }).then((r) => r.json()),
  ]);

  res.json({ webhookUrl, webhook: webhookRes, commands: commandsRes });
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
