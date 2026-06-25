'use strict';

// Optional one-way mirror of bills into a Google Sheet (photos included).
// Posts to a Google Apps Script "web app" (see google-apps-script.gs + README).
// No-op when SHEETS_WEBHOOK_URL is not set.

const db = require('./db');

const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.SHEETS_WEBHOOK_SECRET || '';

const enabled = () => !!WEBHOOK_URL;

async function billPayload(billId) {
  const r = await db.query(`
    SELECT b.*, b.amount::float8 AS amount,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM bills b
    LEFT JOIN bill_tags bt ON bt.bill_id = b.id
    LEFT JOIN tags t ON t.id = bt.tag_id
    WHERE b.id = $1 GROUP BY b.id
  `, [billId]);
  if (!r.rows.length) return null;
  const bill = r.rows[0];
  if (bill.created_at) bill.created_at = new Date(bill.created_at).toISOString();
  const atts = await db.query('SELECT url, original_name, mime FROM attachments WHERE bill_id = $1', [billId]);
  bill.photos = atts.rows.map((a) => ({ url: a.url, name: a.original_name, mime: a.mime }));
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
    if (!res.ok) console.error('[sheets] webhook responded', res.status);
  } catch (err) {
    console.error('[sheets] sync failed:', err.message);
  }
}

async function syncBill(billId) {
  if (!enabled()) return;
  try {
    const bill = await billPayload(billId);
    if (bill) await post({ action: 'upsert', bill });
  } catch (err) { console.error('[sheets] syncBill error:', err.message); }
}

async function deleteBill(billId) {
  if (!enabled()) return;
  await post({ action: 'delete', id: billId });
}

module.exports = { enabled, syncBill, deleteBill };
