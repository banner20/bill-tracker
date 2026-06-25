'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

// --- Load .env (tiny parser, no dependency) ------------------------------
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
const sheets = require('./sheets');

const ENTRY_PASSWORD = process.env.ENTRY_PASSWORD || 'bills123';
const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || 'finance123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const CURRENCY = process.env.CURRENCY || '₹';
const PORT = process.env.PORT || 3000;

// Default "anchor" company tag(s) — always present, shown first, not deletable.
// Change this (or set DEFAULT_TAGS="3061,3060 Consultancy") to seed your own.
const DEFAULT_TAGS = (process.env.DEFAULT_TAGS || '3061')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const name of DEFAULT_TAGS) {
  db.prepare('INSERT INTO tags (name, pinned) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET pinned = 1').run(name);
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

function roleOf(req) {
  return verify(req.cookies && req.cookies.auth);
}
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

// --- Login / session -----------------------------------------------------
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  let role = null;
  if (password && password === FINANCE_PASSWORD) role = 'finance';
  else if (password && password === ENTRY_PASSWORD) role = 'entry';
  if (!role) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('auth', sign(role), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ role: roleOf(req), currency: CURRENCY });
});

// --- Tags ----------------------------------------------------------------
app.get('/api/tags', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.name AS name, t.pinned AS pinned, COUNT(bt.bill_id) AS count
    FROM tags t
    LEFT JOIN bill_tags bt ON bt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.pinned DESC, count DESC, t.name ASC
  `).all();
  res.json(rows.map((r) => ({ ...r, pinned: !!r.pinned })));
});

// Add a tag to the library (so it persists as a suggestion)
app.post('/api/tags', requireAuth, (req, res) => {
  const name = req.body && req.body.name ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Tag name required' });
  upsertTag(name);
  res.json({ name });
});

// Remove a tag from the library. Pinned/anchor tags cannot be removed.
app.delete('/api/tags/:name', requireAuth, (req, res) => {
  const tag = db.prepare('SELECT id, pinned FROM tags WHERE name = ? COLLATE NOCASE').get(req.params.name);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  if (tag.pinned) return res.status(400).json({ error: 'Default company tag cannot be removed' });
  db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id); // cascades to bill_tags
  res.json({ ok: true });
});

function upsertTag(name) {
  const clean = String(name).trim();
  if (!clean) return null;
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(clean);
  return db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(clean).id;
}

// --- File uploads --------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype) || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only images or PDF allowed'));
  },
});

// --- Create a bill -------------------------------------------------------
app.post('/api/bills', requireAuth, upload.array('screenshots', 8), (req, res) => {
  try {
    const b = req.body || {};

    // Bill type(s) come from the chip selector (sent as `tags`). They are the
    // primary categorisation now — at least one is required.
    let tags = [];
    if (b.tags) {
      try { tags = JSON.parse(b.tags); } catch { tags = String(b.tags).split(','); }
    }
    tags = tags.map((t) => String(t).trim()).filter(Boolean);
    const billType = (b.bill_type && String(b.bill_type).trim()) || tags.join(', ');
    if (!billType) {
      return res.status(400).json({ error: 'Pick at least one bill type' });
    }

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO bills (bill_type, vendor, amount, currency, bill_date, due_date, status, note, created_at, created_by)
      VALUES (@bill_type, @vendor, @amount, @currency, @bill_date, @due_date, @status, @note, @created_at, @created_by)
    `).run({
      bill_type: billType,
      vendor: b.vendor ? String(b.vendor).trim() : null,
      amount: b.amount ? Number(b.amount) : null,
      currency: CURRENCY,
      bill_date: b.bill_date || now.slice(0, 10),
      due_date: b.due_date || null,
      status: ['unpaid', 'paid', 'reviewed'].includes(b.status) ? b.status : 'unpaid',
      note: b.note ? String(b.note).trim() : null,
      created_at: now,
      created_by: req.role,
    });
    const billId = info.lastInsertRowid;

    const link = db.prepare('INSERT OR IGNORE INTO bill_tags (bill_id, tag_id) VALUES (?, ?)');
    for (const name of tags) {
      const tagId = upsertTag(name);
      if (tagId) link.run(billId, tagId);
    }

    // attachments
    const addAtt = db.prepare(`
      INSERT INTO attachments (bill_id, filename, original_name, mime, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const f of req.files || []) {
      addAtt.run(billId, f.filename, f.originalname, f.mimetype, f.size, now);
    }

    // Mirror to Google Sheet (no-op if not configured). Fire-and-forget.
    sheets.syncBill(billId);

    res.json({ id: billId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to save bill' });
  }
});

// --- List bills with filters --------------------------------------------
app.get('/api/bills', requireAuth, (req, res) => {
  const { tag, type, status, q, from, to } = req.query;
  const where = [];
  const params = {};

  if (type) { where.push('b.bill_type = @type'); params.type = type; }
  if (status) { where.push('b.status = @status'); params.status = status; }
  if (from) { where.push('b.bill_date >= @from'); params.from = from; }
  if (to) { where.push('b.bill_date <= @to'); params.to = to; }
  if (q) {
    where.push('(b.bill_type LIKE @q OR b.vendor LIKE @q OR b.note LIKE @q)');
    params.q = `%${q}%`;
  }
  if (tag) {
    where.push(`b.id IN (
      SELECT bt.bill_id FROM bill_tags bt
      JOIN tags t ON t.id = bt.tag_id
      WHERE t.name = @tag COLLATE NOCASE
    )`);
    params.tag = tag;
  }

  const sql = `
    SELECT b.* FROM bills b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.bill_date DESC, b.id DESC
    LIMIT 1000
  `;
  const bills = db.prepare(sql).all(params);

  const tagStmt = db.prepare(`
    SELECT t.name FROM tags t JOIN bill_tags bt ON bt.tag_id = t.id
    WHERE bt.bill_id = ? ORDER BY t.name
  `);
  const attStmt = db.prepare('SELECT id, filename, mime, original_name FROM attachments WHERE bill_id = ?');
  for (const bill of bills) {
    bill.tags = tagStmt.all(bill.id).map((r) => r.name);
    bill.attachments = attStmt.all(bill.id);
  }

  // summary
  const total = bills.reduce((s, x) => s + (x.amount || 0), 0);
  res.json({ bills, count: bills.length, total, currency: CURRENCY });
});

app.get('/api/bills/:id', requireAuth, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  bill.tags = db.prepare(`
    SELECT t.name FROM tags t JOIN bill_tags bt ON bt.tag_id = t.id WHERE bt.bill_id = ?
  `).all(bill.id).map((r) => r.name);
  bill.attachments = db.prepare('SELECT id, filename, mime, original_name FROM attachments WHERE bill_id = ?').all(bill.id);
  res.json(bill);
});

// --- Update status (finance) --------------------------------------------
app.patch('/api/bills/:id', requireAuth, requireFinance, (req, res) => {
  const { status } = req.body || {};
  if (!['unpaid', 'paid', 'reviewed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const info = db.prepare('UPDATE bills SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  sheets.syncBill(req.params.id);
  res.json({ ok: true });
});

// --- Delete (finance) ----------------------------------------------------
app.delete('/api/bills/:id', requireAuth, requireFinance, (req, res) => {
  const atts = db.prepare('SELECT filename FROM attachments WHERE bill_id = ?').all(req.params.id);
  db.prepare('DELETE FROM bills WHERE id = ?').run(req.params.id);
  for (const a of atts) {
    fs.unlink(path.join(UPLOAD_DIR, a.filename), () => {});
  }
  sheets.deleteBill(req.params.id);
  res.json({ ok: true });
});

// --- CSV export (finance) ------------------------------------------------
app.get('/api/export.csv', requireAuth, requireFinance, (req, res) => {
  const bills = db.prepare('SELECT * FROM bills ORDER BY bill_date DESC, id DESC').all();
  const tagStmt = db.prepare(`
    SELECT t.name FROM tags t JOIN bill_tags bt ON bt.tag_id = t.id WHERE bt.bill_id = ?
  `);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['id', 'date', 'type', 'vendor', 'amount', 'currency', 'status', 'due_date', 'tags', 'note', 'created_at'];
  const lines = [header.join(',')];
  for (const b of bills) {
    const tags = tagStmt.all(b.id).map((r) => r.name).join('; ');
    lines.push([b.id, b.bill_date, b.bill_type, b.vendor, b.amount, b.currency, b.status, b.due_date, tags, b.note, b.created_at].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// --- Serve attachments (auth-protected) ---------------------------------
app.get('/uploads/:file', requireAuth, (req, res) => {
  const safe = path.basename(req.params.file);
  res.sendFile(path.join(UPLOAD_DIR, safe), (err) => {
    if (err) res.status(404).end();
  });
});

// --- Static frontend -----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Multer / error handler
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload error' });
  next();
});

app.listen(PORT, () => {
  console.log(`\n  Bill Tracker running:  http://localhost:${PORT}`);
  console.log(`  Entry (phone) page:    http://localhost:${PORT}/`);
  console.log(`  Finance dashboard:     http://localhost:${PORT}/dashboard.html`);
  console.log(`\n  Entry password:   ${ENTRY_PASSWORD}`);
  console.log(`  Finance password: ${FINANCE_PASSWORD}`);
  console.log(`  Google Sheet sync: ${sheets.enabled() ? 'ON' : 'off (set SHEETS_WEBHOOK_URL to enable)'}\n`);
});
