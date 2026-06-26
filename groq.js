'use strict';

// Groq API — parse bill text or images using Llama models.
// Set GROQ_API_KEY to enable. Get one free at console.groq.com.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a bill/invoice parser. Extract structured data from the user's message or image.
Return ONLY a JSON object with exactly these fields (null for anything missing or unclear):
{
  "bill_type": "category e.g. Electricity, Internet, Rent, Phone, Fuel, Grocery, Water, Insurance",
  "vendor": "company or person name",
  "amount": 0.00,
  "bill_date": "YYYY-MM-DD",
  "note": "any extra relevant info or null"
}
For bill_date, use today if not mentioned. Amount must be a number, no currency symbols.`;

function enabled() { return !!process.env.GROQ_API_KEY; }

async function callGroq(messages, model) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
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

async function parseBillText(text) {
  return callGroq([{ role: 'user', content: text }], 'llama-3.1-8b-instant');
}

async function parseBillImage(buffer, mime = 'image/jpeg') {
  const b64 = buffer.toString('base64');
  return callGroq([{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      { type: 'text', text: 'Parse this bill or receipt and extract the details.' },
    ],
  }], 'llama-3.2-11b-vision-preview');
}

module.exports = { enabled, parseBillText, parseBillImage };
