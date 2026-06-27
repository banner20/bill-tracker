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

const MAIN_MENU = {
  keyboard: [
    [{ text: '📷 Add photo bill' }, { text: '📝 Type a bill' }],
    [{ text: '📋 Recent' }, { text: '💰 Unpaid' }, { text: '📊 Summary' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: MAIN_MENU, ...extra });
}

async function downloadFile(fileId) {
  const r = await (await fetch(TG(`getFile?file_id=${fileId}`))).json();
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${r.result.file_path}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()) };
}

function isAllowed(chatId) {
  if (!ALLOWED_CHATS.length) return true;
  return ALLOWED_CHATS.includes(String(chatId));
}

// ── Formatting ──────────────────────────────────────────────────────────────
function money(n) {
  if (n == null) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function statusEmoji(s) { return s === 'paid' ? '✅' : s === 'reviewed' ? '🔍' : '⏳'; }

function formatBillCard(b) {
  const type = (b.tags && b.tags.length) ? b.tags.join(', ') : (b.bill_type || '—');
  return [`*${type}*${b.vendor ? ` · ${b.vendor}` : ''}`, `${money(b.amount)} · 📅 ${b.bill_date || '—'}`, `${statusEmoji(b.status)} ${b.status}`].join('\n');
}

function formatParsed(p) {
  return [
    `📋 *Bill details:*`,
    `• Type: ${p.bill_type || '—'}`,
    `• Vendor: ${p.vendor || '—'}`,
    `• Amount: ${p.amount != null ? money(p.amount) : '—'}`,
    `• Date: ${p.bill_date || 'today'}`,
    p.note ? `• Note: ${p.note}` : null,
  ].filter(Boolean).join('\n');
}

function statusButtons(billId, currentStatus) {
  const b = [];
  if (currentStatus !== 'paid')     b.push({ text: '✅ Paid',     callback_data: `ss:${billId}:paid` });
  if (currentStatus !== 'reviewed') b.push({ text: '🔍 Reviewed', callback_data: `ss:${billId}:reviewed` });
  if (currentStatus !== 'unpaid')   b.push({ text: '⏳ Unpaid',   callback_data: `ss:${billId}:unpaid` });
  return b;
}

function confirmKeyboard(pendingId, hasPhoto = false) {
  return {
    inline_keyboard: [
      [{ text: '✅ Save', callback_data: `save:${pendingId}` }, { text: '❌ Cancel', callback_data: `cancel:${pendingId}` }],
      [
        { text: hasPhoto ? '🖼 Replace photo' : '📎 Attach photo', callback_data: `aphoto:${pendingId}` },
        { text: '🏷 Change type', callback_data: `picktag:${pendingId}` },
      ],
    ],
  };
}

// ── Session helpers ─────────────────────────────────────────────────────────
async function getSession(chatId) {
  const r = await db.query('SELECT * FROM tg_sessions WHERE chat_id = $1', [chatId]);
  return r.rows[0] || null;
}
async function setSession(chatId, step, data) {
  await db.query(`
    INSERT INTO tg_sessions (chat_id, step, data, updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (chat_id) DO UPDATE SET step=$2, data=$3, updated_at=now()
  `, [chatId, step, JSON.stringify(data)]);
}
async function clearSession(chatId) {
  await db.query('DELETE FROM tg_sessions WHERE chat_id = $1', [chatId]);
}

// ── DB helpers ──────────────────────────────────────────────────────────────
const BILL_SELECT = `
  SELECT b.id, b.bill_type, b.vendor, b.amount::float8 AS amount, b.bill_date, b.status,
    COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
  FROM bills b LEFT JOIN bill_tags bt ON bt.bill_id=b.id LEFT JOIN tags t ON t.id=bt.tag_id`;

async function getBill(id) {
  const r = await db.query(`${BILL_SELECT} WHERE b.id=$1 GROUP BY b.id`, [id]);
  return r.rows[0] || null;
}
async function getRecentBills(limit = 5) {
  const r = await db.query(`${BILL_SELECT} GROUP BY b.id ORDER BY b.created_at DESC NULLS LAST LIMIT $1`, [limit]);
  return r.rows;
}
async function getUnpaidBills() {
  const r = await db.query(`${BILL_SELECT} WHERE b.status='unpaid' GROUP BY b.id ORDER BY b.bill_date ASC NULLS LAST`);
  return r.rows;
}
async function getSummaryRows() {
  const r = await db.query(`SELECT bill_type, status, COUNT(*)::int AS count, COALESCE(SUM(amount)::float8,0) AS total FROM bills GROUP BY bill_type, status ORDER BY bill_type, status`);
  return r.rows;
}

// ── Tag picker (used by both manual and AI confirm flows) ───────────────────
async function showTagPicker(chatId, pendingId, messageId) {
  const tags = await db.query('SELECT name FROM tags ORDER BY pinned DESC, name ASC');
  const names = tags.rows.map((t) => t.name);
  const rows = [];
  for (let i = 0; i < names.length; i += 3) {
    rows.push(names.slice(i, i + 3).map((name) => ({
      text: name,
      // prefix differs: mtag for manual flow, settag for AI confirm flow
      callback_data: (pendingId ? `settag:${pendingId}:${name}` : `mtag:${name}`).slice(0, 64),
    })));
  }
  rows.push([{ text: '➕ New type', callback_data: pendingId ? `newtype:${pendingId}` : 'mnew' }]);
  if (pendingId) rows.push([{ text: '← Back', callback_data: `back:${pendingId}` }]);
  else           rows.push([{ text: '❌ Cancel', callback_data: 'mcancel' }]);

  const payload = { chat_id: chatId, text: '🏷 *Pick a bill type:*', parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) return tgPost('editMessageText', { ...payload, message_id: messageId });
  return tgPost('sendMessage', payload);
}

// ── Manual flow steps ───────────────────────────────────────────────────────
const SKIP_BTN = { inline_keyboard: [[{ text: '⏭ Skip', callback_data: 'mskip' }]] };

async function askAmount(chatId) {
  return tgPost('sendMessage', { chat_id: chatId, text: '💰 *Amount?* (type a number)', parse_mode: 'Markdown', reply_markup: SKIP_BTN });
}
async function askVendor(chatId) {
  return tgPost('sendMessage', { chat_id: chatId, text: '🏪 *Vendor?* (who is this bill from)', parse_mode: 'Markdown', reply_markup: SKIP_BTN });
}
async function askDate(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  return tgPost('sendMessage', { chat_id: chatId, text: `📅 *Date?* (today is ${today})`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `⏭ Skip (use today)`, callback_data: 'mskip' }]] } });
}
async function askNote(chatId) {
  return tgPost('sendMessage', { chat_id: chatId, text: '📝 *Note?* (optional extra info)', parse_mode: 'Markdown', reply_markup: SKIP_BTN });
}

async function advanceManual(chatId, step, data) {
  await setSession(chatId, step, data);
  if (step === 'enter_amount')  await askAmount(chatId);
  else if (step === 'enter_vendor') await askVendor(chatId);
  else if (step === 'enter_date')   await askDate(chatId);
  else if (step === 'enter_note')   await askNote(chatId);
  else if (step === 'confirm')      await showManualConfirm(chatId, data);
}

async function showManualConfirm(chatId, data) {
  await clearSession(chatId);
  const pendingId = crypto.randomBytes(8).toString('hex');
  await db.query(`INSERT INTO tg_pending (id,chat_id,data,url,public_id,mime) VALUES ($1,$2,$3,null,null,null)`,
    [pendingId, chatId, JSON.stringify(data)]);
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: formatParsed(data) + '\n\nSave this to the dashboard?',
    parse_mode: 'Markdown',
    reply_markup: confirmKeyboard(pendingId),
  });
}

async function handleSessionText(chatId, text, session) {
  const data = session.data || {};

  if (session.step === 'new_tag') {
    const tagName = text.trim();
    if (!tagName) { await sendMessage(chatId, '❌ Name cannot be empty. Type the bill type name:'); return; }
    await db.query(`INSERT INTO tags (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name=tags.name`, [tagName]);
    await advanceManual(chatId, 'enter_amount', { ...data, bill_type: tagName });
    return;
  }
  if (session.step === 'enter_amount') {
    const amount = parseFloat(text.replace(/[₹,\s]/g, ''));
    if (isNaN(amount)) { await sendMessage(chatId, '❌ Enter a number (e.g. 1500):'); return; }
    await advanceManual(chatId, 'enter_vendor', { ...data, amount });
    return;
  }
  if (session.step === 'enter_vendor') {
    await advanceManual(chatId, 'enter_date', { ...data, vendor: text.trim() || null });
    return;
  }
  if (session.step === 'enter_date') {
    let bill_date = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) bill_date = text.trim();
    else { const d = new Date(text.trim()); if (!isNaN(d)) bill_date = d.toISOString().slice(0, 10); }
    if (!bill_date) { await sendMessage(chatId, '❌ Use YYYY-MM-DD format (e.g. 2026-06-27):'); return; }
    await advanceManual(chatId, 'enter_note', { ...data, bill_date });
    return;
  }
  if (session.step === 'enter_note') {
    await showManualConfirm(chatId, { ...data, note: text.trim() || null });
    return;
  }
}

// ── Commands ────────────────────────────────────────────────────────────────
async function showRecent(chatId) {
  const bills = await getRecentBills(5);
  if (!bills.length) { await sendMessage(chatId, '📋 No bills yet.'); return; }
  await sendMessage(chatId, `📋 *Last ${bills.length} bill${bills.length === 1 ? '' : 's'}:*`);
  for (const b of bills) {
    await tgPost('sendMessage', { chat_id: chatId, text: formatBillCard(b), parse_mode: 'Markdown', reply_markup: { inline_keyboard: [statusButtons(b.id, b.status)] } });
  }
}
async function showUnpaid(chatId) {
  const bills = await getUnpaidBills();
  if (!bills.length) { await sendMessage(chatId, '🎉 No unpaid bills — you\'re all clear!'); return; }
  const total = bills.reduce((s, b) => s + (b.amount || 0), 0);
  await sendMessage(chatId, `💰 *${bills.length} unpaid · ${money(total)} total:*`);
  for (const b of bills) {
    await tgPost('sendMessage', { chat_id: chatId, text: formatBillCard(b), parse_mode: 'Markdown', reply_markup: { inline_keyboard: [statusButtons(b.id, b.status)] } });
  }
}
async function showSummary(chatId) {
  const rows = await getSummaryRows();
  if (!rows.length) { await sendMessage(chatId, '📊 No bills yet.'); return; }
  const grouped = {};
  for (const r of rows) (grouped[r.bill_type || '(other)'] = grouped[r.bill_type || '(other)'] || []).push(r);
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

// ── Save a confirmed pending bill ───────────────────────────────────────────
async function savePending(chatId, pending) {
  const d = pending.data;
  const ins = await db.query(`
    INSERT INTO bills (bill_type,vendor,amount,currency,bill_date,status,note,created_by)
    VALUES ($1,$2,$3,'₹',$4,'unpaid',$5,'telegram') RETURNING id
  `, [d.bill_type || 'Other', d.vendor || null, d.amount != null ? Number(d.amount) : null,
      d.bill_date || new Date().toISOString().slice(0, 10), d.note || null]);
  const billId = ins.rows[0].id;
  if (d.bill_type) {
    const tag = await db.query(`INSERT INTO tags (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name=tags.name RETURNING id`, [d.bill_type]);
    await db.query('INSERT INTO bill_tags (bill_id,tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [billId, tag.rows[0].id]);
  }
  if (pending.url) {
    await db.query(`INSERT INTO attachments (bill_id,url,public_id,mime) VALUES ($1,$2,$3,$4)`,
      [billId, pending.url, pending.public_id, pending.mime]);
  }
  await db.query('DELETE FROM tg_pending WHERE id=$1', [pending.id]);
  return billId;
}

async function savePendingAndAsk(chatId, parsed, url, publicId, mime) {
  const pendingId = crypto.randomBytes(8).toString('hex');
  await db.query(`INSERT INTO tg_pending (id,chat_id,data,url,public_id,mime) VALUES ($1,$2,$3,$4,$5,$6)`,
    [pendingId, chatId, JSON.stringify(parsed), url || null, publicId || null, mime || null]);
  await tgPost('sendMessage', {
    chat_id: chatId,
    text: formatParsed(parsed) + '\n\nSave this to the dashboard?',
    parse_mode: 'Markdown',
    reply_markup: confirmKeyboard(pendingId, !!url),
  });
}

// ── Main handler ────────────────────────────────────────────────────────────
async function handleUpdate(update) {
  // ── Callback queries ────────────────────────────────────────────────────
  if (update.callback_query) {
    const { id, data, message } = update.callback_query;
    const chatId = message.chat.id;
    await tgPost('answerCallbackQuery', { callback_query_id: id });

    // Status update on saved bill
    if (data.startsWith('ss:')) {
      const [, billId, newStatus] = data.split(':');
      await db.query('UPDATE bills SET status=$1 WHERE id=$2', [newStatus, billId]);
      const bill = await getBill(billId);
      if (bill) {
        await tgPost('editMessageText', {
          chat_id: chatId, message_id: message.message_id,
          text: formatBillCard(bill) + '\n\n_Updated ✓_', parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [statusButtons(bill.id, bill.status)] },
        });
      }
      return;
    }

    // ── AI confirm flow tag picker ──────────────────────────────────────
    if (data.startsWith('picktag:')) {
      await showTagPicker(chatId, data.slice(8), message.message_id);
      return;
    }
    if (data.startsWith('settag:')) {
      const parts = data.split(':'); const pendingId = parts[1]; const tagName = parts.slice(2).join(':');
      const r = await db.query('SELECT * FROM tg_pending WHERE id=$1', [pendingId]);
      if (!r.rows.length) { await sendMessage(chatId, '⏱ Expired. Send the bill again.'); return; }
      const newData = { ...r.rows[0].data, bill_type: tagName };
      await db.query('UPDATE tg_pending SET data=$1 WHERE id=$2', [JSON.stringify(newData), pendingId]);
      await tgPost('editMessageText', {
        chat_id: chatId, message_id: message.message_id,
        text: formatParsed(newData) + '\n\nSave this to the dashboard?',
        parse_mode: 'Markdown', reply_markup: confirmKeyboard(pendingId),
      });
      return;
    }
    if (data.startsWith('newtype:')) {
      // "New type" from AI confirm tag picker
      const pendingId = data.slice(8);
      await db.query('UPDATE tg_pending SET data=data WHERE id=$1', [pendingId]); // keep alive
      await setSession(chatId, 'new_tag_for_pending', { pendingId });
      await sendMessage(chatId, '✏️ Type the new bill type name:');
      return;
    }
    if (data.startsWith('back:')) {
      const pendingId = data.slice(5);
      const r = await db.query('SELECT * FROM tg_pending WHERE id=$1', [pendingId]);
      if (!r.rows.length) { await sendMessage(chatId, '⏱ Expired. Send the bill again.'); return; }
      await tgPost('editMessageText', {
        chat_id: chatId, message_id: message.message_id,
        text: formatParsed(r.rows[0].data) + '\n\nSave this to the dashboard?',
        parse_mode: 'Markdown', reply_markup: confirmKeyboard(pendingId),
      });
      return;
    }

    // Attach / replace photo on a pending bill
    if (data.startsWith('aphoto:')) {
      const pendingId = data.slice(7);
      const r = await db.query('SELECT id FROM tg_pending WHERE id=$1', [pendingId]);
      if (!r.rows.length) { await sendMessage(chatId, '⏱ Expired. Send the bill again.'); return; }
      await setSession(chatId, 'attach_photo', { pendingId });
      await tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
      await sendMessage(chatId, '📷 Send the photo or screenshot to attach:');
      return;
    }

    // ── Manual flow callbacks ───────────────────────────────────────────
    if (data === 'mcancel') { await clearSession(chatId); await sendMessage(chatId, '❌ Cancelled.'); return; }

    if (data === 'mnew') {
      const session = await getSession(chatId);
      await setSession(chatId, 'new_tag', session?.data || {});
      await sendMessage(chatId, '✏️ Type the new bill type name:');
      return;
    }

    if (data.startsWith('mtag:')) {
      const tagName = data.slice(5);
      const session = await getSession(chatId);
      await tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
      await advanceManual(chatId, 'enter_amount', { ...(session?.data || {}), bill_type: tagName });
      return;
    }

    if (data === 'mskip') {
      const session = await getSession(chatId);
      if (!session) { await sendMessage(chatId, '⏱ Session expired. Use the menu to start again.'); return; }
      const d = session.data || {};
      const today = new Date().toISOString().slice(0, 10);
      if (session.step === 'enter_amount')  await advanceManual(chatId, 'enter_vendor', { ...d, amount: null });
      else if (session.step === 'enter_vendor') await advanceManual(chatId, 'enter_date',   { ...d, vendor: null });
      else if (session.step === 'enter_date')   await advanceManual(chatId, 'enter_note',   { ...d, bill_date: today });
      else if (session.step === 'enter_note')   await showManualConfirm(chatId, { ...d, note: null });
      return;
    }

    // ── Save / cancel pending ───────────────────────────────────────────
    const [action, pendingId] = data.split(':');
    const r = await db.query('SELECT * FROM tg_pending WHERE id=$1', [pendingId]);
    if (!r.rows.length) { await sendMessage(chatId, '⏱ Confirmation expired. Send the bill again.'); return; }
    const pending = r.rows[0];

    if (action === 'cancel') {
      if (pending.public_id && storage.enabled()) await storage.destroy(pending.public_id);
      await db.query('DELETE FROM tg_pending WHERE id=$1', [pendingId]);
      await sendMessage(chatId, '❌ Cancelled.');
      return;
    }
    if (action === 'save') {
      const billId = await savePending(chatId, pending);
      await tgPost('sendMessage', {
        chat_id: chatId,
        text: `✅ *Saved!* Bill #${billId} is on the dashboard.\n\nMark it right away?`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Mark paid', callback_data: `ss:${billId}:paid` }, { text: '🔍 Mark reviewed', callback_data: `ss:${billId}:reviewed` }]] },
      });
    }
    return;
  }

  // ── Regular messages ────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) {
    await tgPost('sendMessage', { chat_id: chatId, text: `🔒 Not authorised. Ask admin to add your chat ID:\n\`${chatId}\``, parse_mode: 'Markdown' });
    return;
  }

  const text = msg.text || '';

  // /start
  if (text.startsWith('/start')) {
    await clearSession(chatId);
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: `👋 *Bill Tracker Bot*\n\nUse the menu below:\n• *📝 Type a bill* — step-by-step manual entry\n• *📷 Add photo bill* — send a photo, AI reads it\n• *📋 Recent / 💰 Unpaid / 📊 Summary* — view your bills\n\nYour chat ID: \`${chatId}\``,
      parse_mode: 'Markdown',
      reply_markup: MAIN_MENU,
    });
    return;
  }

  // Check for active manual session first (before handling menu buttons)
  const session = await getSession(chatId);

  // Special case: "new type" from the AI confirm flow
  if (session && session.step === 'new_tag_for_pending') {
    const tagName = text.trim();
    const { pendingId } = session.data;
    if (!tagName) { await sendMessage(chatId, '❌ Name cannot be empty:'); return; }
    await db.query(`INSERT INTO tags (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name=tags.name`, [tagName]);
    const r = await db.query('SELECT * FROM tg_pending WHERE id=$1', [pendingId]);
    if (!r.rows.length) { await clearSession(chatId); await sendMessage(chatId, '⏱ Pending expired. Send the bill again.'); return; }
    const newData = { ...r.rows[0].data, bill_type: tagName };
    await db.query('UPDATE tg_pending SET data=$1 WHERE id=$2', [JSON.stringify(newData), pendingId]);
    await clearSession(chatId);
    await tgPost('sendMessage', {
      chat_id: chatId,
      text: formatParsed(newData) + '\n\nSave this to the dashboard?',
      parse_mode: 'Markdown', reply_markup: confirmKeyboard(pendingId),
    });
    return;
  }

  // Menu buttons — these always cancel any active session and start fresh
  const MENU_BUTTONS = ['📷 Add photo bill', '📝 Type a bill', '📋 Recent', '💰 Unpaid', '📊 Summary'];
  if (MENU_BUTTONS.includes(text) && session) await clearSession(chatId);

  if (text === '📝 Type a bill' || text.startsWith('/add')) {
    await setSession(chatId, 'pick_tag', {});
    await showTagPicker(chatId, null, null);
    return;
  }
  if (text === '📷 Add photo bill') { await sendMessage(chatId, '📷 Send me a photo or screenshot of the bill now.'); return; }
  if (text === '📋 Recent'  || text.startsWith('/recent'))  { await showRecent(chatId); return; }
  if (text === '💰 Unpaid'  || text.startsWith('/unpaid'))  { await showUnpaid(chatId); return; }
  if (text === '📊 Summary' || text.startsWith('/summary')) { await showSummary(chatId); return; }

  // Active manual session — route text to the current step (photos handled below)
  if (session && session.step !== 'pick_tag' && session.step !== 'attach_photo' && text) {
    await handleSessionText(chatId, text, session);
    return;
  }

  // Helper: fetch tag names for Groq context
  async function getTags() {
    const r = await db.query('SELECT name FROM tags ORDER BY pinned DESC, name ASC');
    return r.rows.map((t) => t.name);
  }

  // Voice message → transcribe → AI parse
  if (msg.voice || msg.audio) {
    if (session) await clearSession(chatId);
    await sendMessage(chatId, '🎙 Transcribing…');
    const fileId = (msg.voice || msg.audio).file_id;
    const mime = msg.voice ? 'audio/ogg' : (msg.audio?.mime_type || 'audio/mpeg');
    const { buffer } = await downloadFile(fileId);
    let transcript = '';
    if (groq.enabled()) {
      try { transcript = await groq.transcribeAudio(buffer, mime); }
      catch (e) { console.error('Whisper error:', e.message); }
    }
    if (!transcript) {
      await sendMessage(chatId, '❌ Could not transcribe. Try typing the bill details instead.');
      return;
    }
    await sendMessage(chatId, `🗣 _"${transcript}"_\n\nParsing…`);
    let parsed = {};
    if (groq.enabled()) {
      try { parsed = await groq.parseBillText(transcript, await getTags()); }
      catch (e) { console.error('Groq parse error:', e.message); }
    }
    await savePendingAndAsk(chatId, parsed, null, null, null);
    return;
  }

  // Photo / document
  if (msg.photo || msg.document) {
    let fileId, mime;
    if (msg.photo) { fileId = msg.photo[msg.photo.length - 1].file_id; mime = 'image/jpeg'; }
    else           { fileId = msg.document.file_id; mime = msg.document.mime_type || 'application/octet-stream'; }
    const { buffer } = await downloadFile(fileId);

    // Attach photo to an existing pending bill
    if (session && session.step === 'attach_photo') {
      const { pendingId } = session.data;
      await clearSession(chatId);
      const r = await db.query('SELECT * FROM tg_pending WHERE id=$1', [pendingId]);
      if (!r.rows.length) { await sendMessage(chatId, '⏱ Expired. Send the bill again.'); return; }
      const pending = r.rows[0];
      if (pending.public_id && storage.enabled()) {
        try { await storage.destroy(pending.public_id); } catch (_) {}
      }
      let url = null, publicId = null;
      if (storage.enabled()) {
        try { const up = await storage.upload(buffer, { mime, folder: 'telegram' }); url = up.url; publicId = up.public_id; }
        catch (e) { console.error('Storage error:', e.message); }
      }
      await db.query('UPDATE tg_pending SET url=$1, public_id=$2, mime=$3 WHERE id=$4', [url, publicId, mime, pendingId]);
      await tgPost('sendMessage', {
        chat_id: chatId,
        text: formatParsed(pending.data) + '\n\n📎 _Photo attached._\n\nSave this to the dashboard?',
        parse_mode: 'Markdown',
        reply_markup: confirmKeyboard(pendingId, true),
      });
      return;
    }

    // New bill via AI photo parse
    if (session) await clearSession(chatId);
    await sendMessage(chatId, '🔍 Reading your bill…');
    let url = null, publicId = null;
    if (storage.enabled()) {
      try { const up = await storage.upload(buffer, { mime, folder: 'telegram' }); url = up.url; publicId = up.public_id; }
      catch (e) { console.error('Storage error:', e.message); }
    }
    let parsed = {};
    if (groq.enabled()) {
      try { parsed = await groq.parseBillImage(buffer, mime, await getTags()); }
      catch (e) { console.error('Groq image error:', e.message); }
    }
    await savePendingAndAsk(chatId, parsed, url, publicId, mime);
    return;
  }

  // Plain text (not a command, not a menu button, no active session) → AI parse
  if (text && !text.startsWith('/')) {
    await sendMessage(chatId, '🔍 Parsing with AI…');
    let parsed = {};
    if (groq.enabled()) {
      try { parsed = await groq.parseBillText(text, await getTags()); }
      catch (e) { console.error('Groq text error:', e.message); }
    }
    await savePendingAndAsk(chatId, parsed, null, null, null);
  }
}

module.exports = { enabled, handleUpdate };
