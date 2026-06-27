'use strict';

// Groq API — parse bill text or images using Llama models.
// Set GROQ_API_KEY to enable. Get one free at console.groq.com.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function buildPrompt(tags) {
  const tagHint = tags && tags.length
    ? `Existing bill types in the system (prefer these exact names if they match): ${tags.join(', ')}.`
    : 'Use a sensible category like Electricity, Internet, Rent, Phone, Fuel, Grocery.';
  return `You are a bill/invoice parser. Extract structured data from the user's message or image.
Return ONLY a JSON object with exactly these fields (null for anything missing or unclear):
{
  "bill_type": "pick the best matching bill type",
  "vendor": "company or person name",
  "amount": 0.00,
  "bill_date": "YYYY-MM-DD",
  "note": "any extra relevant info or null"
}
${tagHint}
For bill_date, use today if not mentioned. Amount must be a number, no currency symbols.`;
}

function enabled() { return !!process.env.GROQ_API_KEY; }

async function callGroq(messages, model, tags) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: buildPrompt(tags) }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function parseBillText(text, tags) {
  return callGroq([{ role: 'user', content: text }], 'llama-3.1-8b-instant', tags);
}

async function parseBillImage(buffer, mime = 'image/jpeg', tags) {
  const b64 = buffer.toString('base64');
  return callGroq([{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      { type: 'text', text: 'Parse this bill or receipt and extract the details.' },
    ],
  }], 'llama-3.2-11b-vision-preview', tags);
}

async function transcribeAudio(buffer, mime = 'audio/ogg') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('language', 'en');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq Whisper ${res.status}: ${err}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { enabled, parseBillText, parseBillImage, transcribeAudio };
