'use strict';

const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');
const groq = require('./groq');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHATS = (process.env.TELEGRAM_ALLOWED_CHATS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const enabled = () => !!TOKEN;
const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tgPost(method, body) {
  const res = await fetch(TG(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Persistent bottom keyboard — always visible
const MAIN_MENU = {
  keyboard: [
    [{ text: '📷 Add photo bill' }, { text: '📝 Type a bill' }],
    [{ text: '📋 Recent' }, { text: '💰 Unpaid' }, { text: '📊 Summary' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: MAIN_MENU,
    ...extra,
  });
}

async function downloadFile(fileId) {
  const r = await (await fetch(TG(`getFile?file_id=${fileId}`))).json();
  const filePath = r.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()) };
}

function isAllowed(chatId) {
  if (!ALLOWED_CHATS.length) return true;
  return ALLOWED_CHATS.includes(String(chatId));
}

// ── Formatting ─────────────────────────────────────────────────────────────
function money(n) {
  if (n == null) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function statusEmoji(s) {
  return s === 'paid' ? '✅' : s === 'reviewed' ? '🔍' : '⏳';
}

function formatBillCard(b) {
  const type = (b.tags && b.tags.length) ? b.tags.join(', ') : (b.bill_type || '—');
  return [
    `*${type}*${b.vendor ? ` · ${b.vendor}` : ''}`,
    `${money(b.amount)} · 📅 ${b.bill_date || '—'}`,
    `${statusEmoji(b.status)} ${b.status}`,
  ].join('\n');
}

function statusButtons(billId, currentStatus) {
  const btns = [];
  if (currentStatus !== 'paid')     btns.push({ text: '✅ Paid',     callback_data: `ss:${billId}:paid` });
  if (currentStatus !== 'reviewed') btns.push({ text: '🔍 Reviewed', callback_data: `ss:${billId}:reviewed` });
  if (currentStatus !== 'unpaid')   btns.push({ text: '⏳ Unpaid',   callback_data: `ss:${billId}:unpaid` });
  return btns;
}

// ── DB helpers ─────────────────────────────────────────────────────────────
const BILL_SELECT = `
  SELECT b.id, b.bill_type, b.vendor, b.amount::float8 AS amount, b.bill_date, b.status,
    COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
  FROM bills b
  LEFT JOIN bill_tags bt ON bt.bill_id = b.id
  LEFT JOIN tags t ON t.id = bt.tag_id`;

async function getBill(id) {
  const r = await db.query(`${BILL_SELECT} WHERE b.id = $1 GROUP BY b.id`, [id]);
  return r.rows[0] || null;
}

async function getRecentBills(limit = 5) {
  const r = await db.query(`${BILL_SELECT} GROUP BY b.id ORDER BY b.created_at DESC NULLS LAST LIMIT $1`, [limit]);
  return r.rows;
}

async function getUnpaidBills() {
  const r = await db.query(`${BILL_SELECT} WHERE b.status = 'unpaid' GROUP BY b.id ORDER BY b.bill_date ASC NULLS LAST`);
  return r.rows;
}

async function getSummaryRows() {
  const r = await db.query(`
    SELECT bill_type, status, COUNT(*)::int AS count, COALESCE(SUM(amount)::float8, 0) AS total
    FROM bills GROUP BY bill_type, status ORDER BY bill_type, status
  `);
  return r.rows;
}

// ── Commands ───────────────────────────────────────────────────────────────
async function showRecent(chatId) {
  const bills = await getRecentBills(5);
  if (!bills.length) { await sendMessage(chatId, '📋 No bills yet.'); return; }
  await sendMessage(chatId, `📋 *Last ${bills.length} bill${bills.length === 1 ? '' : 's'}:*`);
  for (const b of bills) {
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: formatBillCard(b),
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [statusButtons(b.id, b.status)] },
    });
  }
}

async function showUnpaid(chatId) {
  const bills = await getUnpaidBills();
  if (!bills.length) { await sendMessage(chatId, '🎉 No unpaid bills — you\'re all clear!'); return; }
  const total = bills.reduce((s, b) => s + (b.amount || 0), 0);
  await sendMessage(chatId, `💰 *${bills.length} unpaid · ${money(total)} total:*`);
  for (const b of bills) {
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: formatBillCard(b),
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [statusButtons(b.id, b.status)] },
    });
  }
}

async function showSummary(chatId) {
  const rows = await getSummaryRows();
  if (!rows.length) { await sendMessage(chatId, '📊 No bills yet.'); return; }
  const grouped = {};
  for (const r of rows) {
    (grouped[r.bill_type || '(other)'] = grouped[r.bill_type || '(other)'] || []).push(r);
  }
  let unpaidTotal = 0;
  let text = '📊 *Summary by bill type:*\n\n';
  for (const [type, entries] of Object.entries(grouped)) {
    text += `*${type}*\n`;
    for (const e of entries) {
      text += `  ${statusEmoji(e.status)} ${e.status}: ${e.count} bill${e.count === 1 ? '' : 's'} · ${money(e.total)}\n`;
      if (e.status === 'unpaid') unpaidTotal += e.total;
    }
    text += '\n';
  }
  text += `💰 *Total unpaid: ${money(unpaidTotal)}*`;
  await sendMessage(chatId, text);
}

// ── Pending confirm flow ────────────────────────────────────────────────────
function formatParsed(p) {
  return [
    `📋 *Parsed bill:*`,
    `• Type: ${p.bill_type || '—'}`,
    `• Vendor: ${p.vendor || '—'}`,
    `• Amount: ${p.amount != null ? money(p.amount) : '—'}`,
    `• Date: ${p.bill_date || 'today'}`,
    p.note ? `• Note: ${p.note}` : null,
  ].filter(Boolean).join('\n');
}

async function savePendingAndAsk(chatId, parsed, url, publicId, mime) {
  const pendingId = crypto.randomBytes(8).toString('hex');
  await db.query(
    `INSERT INTO tg_pending (id, chat_id, data, url, public_id, mime) VALUES ($1,$2,$3,$4,$5,$6)`,
    [pendingId, chatId, JSON.stringify(parsed), url || null, publicId || null, mime || null],
  );
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: formatParsed(parsed) + '\n\nSave this to the dashboard?',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Save', callback_data: `save:${pendingId}` },
        { text: '❌ Cancel', callback_data: `cancel:${pendingId}` },
      ]],
    },
  });
}

// ── Main handler ────────────────────────────────────────────────────────────
async function handleUpdate(update) {
  // ── Callback queries (inline button taps) ────────────────────────────────
  if (update.callback_query) {
    const { id, data, message } = update.callback_query;
    const chatId = message.chat.id;
    await tgPost('answerCallbackQuery', { callback_query_id: id });

    // Status update on an existing saved bill
    if (data.startsWith('ss:')) {
      const [, billId, newStatus] = data.split(':');
      await db.query('UPDATE bills SET status = $1 WHERE id = $2', [newStatus, billId]);
      const bill = await getBill(billId);
      if (bill) {
        await tgPost('editMessageText', {
          chat_id: chatId,
          message_id: message.message_id,
          text: formatBillCard(bill) + '\n\n_Updated ✓_',
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [statusButtons(bill.id, bill.status)] },
        });
      }
      return;
    }

    // Save / cancel pending parse
    const [action, pendingId] = data.split(':');
    const r = await db.query('SELECT * FROM tg_pending WHERE id = $1', [pendingId]);
    if (!r.rows.length) {
      await sendMessage(chatId, '⏱ Confirmation expired. Send the bill again.');
      return;
    }
    const pending = r.rows[0];

    if (action === 'cancel') {
      if (pending.public_id && storage.enabled()) await storage.destroy(pending.public_id);
      await db.query('DELETE FROM tg_pending WHERE id = $1', [pendingId]);
      await sendMessage(chatId, '❌ Cancelled. Send it again with more detail if you like.');
      return;
    }

    if (action === 'save') {
      const d = pending.data;
      const ins = await db.query(`
        INSERT INTO bills (bill_type, vendor, amount, currency, bill_date, status, note, created_by)
        VALUES ($1,$2,$3,'₹',$4,'unpaid',$5,'telegram') RETURNING id
      `, [d.bill_type || 'Other', d.vendor || null, d.amount != null ? Number(d.amount) : null,
          d.bill_date || new Date().toISOString().slice(0, 10), d.note || null]);
      const billId = ins.rows[0].id;

      if (d.bill_type) {
        const tag = await db.query(
          `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name RETURNING id`,
          [d.bill_type],
        );
        await db.query('INSERT INTO bill_tags (bill_id,tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [billId, tag.rows[0].id]);
      }
      if (pending.url) {
        await db.query(`INSERT INTO attachments (bill_id,url,public_id,mime) VALUES ($1,$2,$3,$4)`,
          [billId, pending.url, pending.public_id, pending.mime]);
      }
      await db.query('DELETE FROM tg_pending WHERE id = $1', [pendingId]);

      await tgPost('sendMessage', {
        chat_id: chatId,
        text: `✅ *Saved!* Bill #${billId} is on the dashboard.\n\nMark it right away?`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Mark paid', callback_data: `ss:${billId}:paid` },
            { text: '🔍 Mark reviewed', callback_data: `ss:${billId}:reviewed` },
          ]],
        },
      });
    }
    return;
  }

  // ── Regular messages ─────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) {
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: `🔒 Not authorised. Ask admin to add your chat ID to *TELEGRAM\\_ALLOWED\\_CHATS*:\n\`${chatId}\``,
      parse_mode: 'Markdown',
    });
    return;
  }

  const text = msg.text || '';

  if (text.startsWith('/start')) {
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: `👋 *Bill Tracker Bot*\n\nUse the menu below or:\n• Send a *photo* of a bill or receipt\n• *Type* a description: _"Airtel ₹999 June"_\n\nI'll parse it with AI and let you confirm before saving.\n\nYour chat ID: \`${chatId}\``,
      parse_mode: 'Markdown',
      reply_markup: MAIN_MENU,
    });
    return;
  }

  if (text === '📷 Add photo bill') { await sendMessage(chatId, '📷 Send me a photo or screenshot of the bill now.'); return; }
  if (text === '📝 Type a bill')    { await sendMessage(chatId, '📝 Type the bill — e.g. _"Airtel broadband ₹999 June 26"_'); return; }
  if (text === '📋 Recent'   || text.startsWith('/recent'))  { await showRecent(chatId); return; }
  if (text === '💰 Unpaid'   || text.startsWith('/unpaid'))  { await showUnpaid(chatId); return; }
  if (text === '📊 Summary'  || text.startsWith('/summary')) { await showSummary(chatId); return; }

  // Photo or document
  if (msg.photo || msg.document) {
    await sendMessage(chatId, '🔍 Reading your bill…');
    let fileId, mime;
    if (msg.photo) { fileId = msg.photo[msg.photo.length - 1].file_id; mime = 'image/jpeg'; }
    else           { fileId = msg.document.file_id; mime = msg.document.mime_type || 'application/octet-stream'; }

    const { buffer } = await downloadFile(fileId);
    let url = null, publicId = null;
    if (storage.enabled()) {
      try { const up = await storage.upload(buffer, { mime, folder: 'telegram' }); url = up.url; publicId = up.public_id; }
      catch (e) { console.error('Storage error:', e.message); }
    }
    let parsed = {};
    if (groq.enabled()) {
      try { parsed = await groq.parseBillImage(buffer, mime); }
      catch (e) { console.error('Groq image error:', e.message); }
    }
    await savePendingAndAsk(chatId, parsed, url, publicId, mime);
    return;
  }

  // Plain text bill entry
  if (text && !text.startsWith('/')) {
    await sendMessage(chatId, '🔍 Parsing…');
    let parsed = {};
    if (groq.enabled()) {
      try { parsed = await groq.parseBillText(text); }
      catch (e) { console.error('Groq text error:', e.message); }
    }
    await savePendingAndAsk(chatId, parsed, null, null, null);
  }
}

module.exports = { enabled, handleUpdate };
