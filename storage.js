'use strict';

// File storage via Supabase Storage. Configured via SUPABASE_URL + SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'attachments';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const enabled = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

async function initBucket() {
  const client = getClient();
  if (!client) return;
  const { data: buckets } = await client.storage.listBuckets();
  if (!buckets || !buckets.find((b) => b.name === BUCKET)) {
    const { error } = await client.storage.createBucket(BUCKET, { public: true });
    if (error) throw error;
  }
}

async function upload(buffer, { mime = '', folder = 'bills' } = {}) {
  const client = getClient();
  const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] || 'bin');
  const filePath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { data, error } = await client.storage
    .from(BUCKET)
    .upload(filePath, buffer, { contentType: mime, upsert: false });

  if (error) throw error;

  const { data: { publicUrl } } = client.storage.from(BUCKET).getPublicUrl(data.path);
  return { url: publicUrl, public_id: data.path };
}

async function destroy(publicId) {
  try {
    const client = getClient();
    if (!client || !publicId) return;
    await client.storage.from(BUCKET).remove([publicId]);
  } catch {}
}

module.exports = { enabled, upload, destroy, initBucket };
