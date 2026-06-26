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

function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function downloadFile(fileId) {
  const r = await (await fetch(TG(`getFile?file_id=${fileId}`))).json();
  const filePath = r.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), filePath };
}

function isAllowed(chatId) {
  if (!ALLOWED_CHATS.length) return true;
  return ALLOWED_CHATS.includes(String(chatId));
}

function formatParsed(p) {
  return [
    `📋 *Bill parsed:*`,
    `• Type: ${p.bill_type || '—'}`,
    `• Vendor: ${p.vendor || '—'}`,
    `• Amount: ${p.amount != null ? '₹' + Number(p.amount).toLocaleString('en-IN') : '—'}`,
    `• Date: ${p.bill_date || 'today'}`,
    p.note ? `• Note: ${p.note}` : null,
  ].filter(Boolean).join('\n');
}

async function savePendingAndAsk(chatId, parsed, url, publicId, mime) {
  const pendingId = crypto.randomBytes(8).toString('hex');
  await db.query(
    `INSERT INTO tg_pending (id, chat_id, data, url, public_id, mime)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [pendingId, chatId, JSON.stringify(parsed), url || null, publicId || null, mime || null],
  );

  await tgPost('sendMessage', {
    chat_id: chatId,
    text: formatParsed(parsed) + '\n\nSave this to the dashboard?',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Save', callback_data: `save:${pendingId}` },
        { text: '✏️ Wrong? Retype', callback_data: `cancel:${pendingId}` },
      ]],
    },
  });
}

async function handleUpdate(update) {
  // ── Callback query (button tap) ──────────────────────────────────────────
  if (update.callback_query) {
    const { id, data, message } = update.callback_query;
    const chatId = message.chat.id;
    await tgPost('answerCallbackQuery', { callback_query_id: id });

    const [action, pendingId] = data.split(':');
    const r = await db.query('SELECT * FROM tg_pending WHERE id = $1', [pendingId]);
    if (!r.rows.length) {
      await sendMessage(chatId, '⏱ This confirmation expired. Send the bill again.');
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
      const d = pending.data; // pg auto-parses JSONB to object
      const ins = await db.query(`
        INSERT INTO bills (bill_type, vendor, amount, currency, bill_date, status, note, created_by)
        VALUES ($1, $2, $3, '₹', $4, 'unpaid', $5, 'telegram') RETURNING id
      `, [
        d.bill_type || 'Other',
        d.vendor || null,
        d.amount != null ? Number(d.amount) : null,
        d.bill_date || new Date().toISOString().slice(0, 10),
        d.note || null,
      ]);
      const billId = ins.rows[0].id;

      // Create / link tag
      if (d.bill_type) {
        const tag = await db.query(
          `INSERT INTO tags (name) VALUES ($1)
           ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name RETURNING id`,
          [d.bill_type],
        );
        await db.query(
          'INSERT INTO bill_tags (bill_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [billId, tag.rows[0].id],
        );
      }

      // Link attachment if we uploaded one
      if (pending.url) {
        await db.query(
          `INSERT INTO attachments (bill_id, url, public_id, mime) VALUES ($1, $2, $3, $4)`,
          [billId, pending.url, pending.public_id, pending.mime],
        );
      }

      await db.query('DELETE FROM tg_pending WHERE id = $1', [pendingId]);
      await sendMessage(chatId, `✅ *Saved!* Bill #${billId} is on the dashboard now.`);
    }
    return;
  }

  // ── Regular message ───────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) {
    await sendMessage(chatId,
      `🔒 Not authorised.\nAsk admin to add your chat ID to *TELEGRAM\\_ALLOWED\\_CHATS*:\n\`${chatId}\``);
    return;
  }

  // /start
  if (msg.text && msg.text.startsWith('/start')) {
    await sendMessage(chatId,
      `👋 *Bill Tracker Bot*\n\n` +
      `Send me:\n• A *photo* of a bill or receipt\n• Or *type* it: _"Airtel ₹999 June"_\n\n` +
      `I'll parse it with AI and let you confirm before saving.\n\n` +
      `Your chat ID: \`${chatId}\``);
    return;
  }

  // Photo or document
  if (msg.photo || msg.document) {
    const typing = sendMessage(chatId, '🔍 Reading your bill...');

    let fileId, mime;
    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
      mime = 'image/jpeg';
    } else {
      fileId = msg.document.file_id;
      mime = msg.document.mime_type || 'application/octet-stream';
    }

    await typing;
    const { buffer } = await downloadFile(fileId);

    // Upload to storage first so we have the URL regardless of parse result
    let url = null, publicId = null;
    if (storage.enabled()) {
      try {
        const up = await storage.upload(buffer, { mime, folder: 'telegram' });
        url = up.url;
        publicId = up.public_id;
      } catch (e) {
        console.error('Storage upload error:', e.message);
      }
    }

    let parsed = {};
    if (groq.enabled()) {
      try {
        parsed = await groq.parseBillImage(buffer, mime);
      } catch (e) {
        console.error('Groq image error:', e.message);
        await sendMessage(chatId, '⚠️ Could not auto-parse — fill in what I got:');
      }
    }

    await savePendingAndAsk(chatId, parsed, url, publicId, mime);
    return;
  }

  // Text message
  if (msg.text) {
    await sendMessage(chatId, '🔍 Parsing...');
    let parsed = {};
    if (groq.enabled()) {
      try {
        parsed = await groq.parseBillText(msg.text);
      } catch (e) {
        console.error('Groq text error:', e.message);
      }
    }
    await savePendingAndAsk(chatId, parsed, null, null, null);
    return;
  }
}

module.exports = { enabled, handleUpdate };
