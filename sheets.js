'use strict';

// Optional one-way mirror of bills into a Google Sheet (including photos).
//
// It works by POSTing each bill to a Google Apps Script "web app" that you
// deploy from inside your own Google Sheet (see google-apps-script.gs and the
// README). If SHEETS_WEBHOOK_URL is not set, every function here is a no-op,
// so the app runs perfectly fine without Google Sheets.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.SHEETS_WEBHOOK_SECRET || '';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const enabled = () => !!WEBHOOK_URL;

function billPayload(billId) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return null;
  bill.tags = db.prepare(`
    SELECT t.name FROM tags t JOIN bill_tags bt ON bt.tag_id = t.id WHERE bt.bill_id = ?
  `).all(bill.id).map((r) => r.name);

  const atts = db.prepare('SELECT filename, original_name, mime FROM attachments WHERE bill_id = ?').all(bill.id);
  bill.photos = [];
  for (const a of atts) {
    try {
      const buf = fs.readFileSync(path.join(UPLOAD_DIR, a.filename));
      bill.photos.push({
        name: a.original_name || a.filename,
        mime: a.mime || 'application/octet-stream',
        data: buf.toString('base64'),
      });
    } catch { /* file missing — skip */ }
  }
  return bill;
}

async function post(body) {
  if (!enabled()) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, ...body }),
    });
    if (!res.ok) console.error('[sheets] webhook responded', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[sheets] sync failed:', err.message);
  }
}

// Create/update the row for a bill (with its photos).
async function syncBill(billId) {
  if (!enabled()) return;
  const bill = billPayload(billId);
  if (bill) post({ action: 'upsert', bill });
}

// Remove the row for a deleted bill.
async function deleteBill(billId) {
  if (!enabled()) return;
  post({ action: 'delete', id: billId });
}

module.exports = { enabled, syncBill, deleteBill };
