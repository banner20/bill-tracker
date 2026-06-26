'use strict';

// Postgres data layer (works with Supabase). Connection comes from DATABASE_URL.
// On Vercel/serverless, use the Supabase "Transaction pooler" connection string.

// Supabase's pooler uses a non-standard cert chain that Node rejects by default.
// Must be set before pg is loaded so it applies to all TLS connections.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n  ERROR: DATABASE_URL is not set. Point it at your Supabase Postgres connection string.\n');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  max: 5,
});

function query(text, params) {
  return pool.query(text, params);
}

// Create tables once per cold start (idempotent). Cached so concurrent
// requests in the same instance share a single init.
let initPromise = null;
function init() {
  if (!initPromise) {
    initPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id          SERIAL PRIMARY KEY,
        bill_type   TEXT NOT NULL,
        vendor      TEXT,
        amount      NUMERIC,
        currency    TEXT NOT NULL DEFAULT '₹',
        bill_date   TEXT,
        due_date    TEXT,
        status      TEXT NOT NULL DEFAULT 'unpaid',
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by  TEXT
      );

      CREATE TABLE IF NOT EXISTS tags (
        id      SERIAL PRIMARY KEY,
        name    TEXT NOT NULL,
        pinned  BOOLEAN NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags (lower(name));

      CREATE TABLE IF NOT EXISTS bill_tags (
        bill_id  INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
        tag_id   INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
        PRIMARY KEY (bill_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id            SERIAL PRIMARY KEY,
        bill_id       INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
        url           TEXT NOT NULL,
        public_id     TEXT,
        original_name TEXT,
        mime          TEXT,
        size          INTEGER,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_bill_tags_tag  ON bill_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_bill_tags_bill ON bill_tags(bill_id);
      CREATE INDEX IF NOT EXISTS idx_attach_bill    ON attachments(bill_id);
      CREATE INDEX IF NOT EXISTS idx_bills_status   ON bills(status);

      CREATE TABLE IF NOT EXISTS tg_pending (
        id         TEXT PRIMARY KEY,
        chat_id    BIGINT NOT NULL,
        data       JSONB NOT NULL,
        url        TEXT,
        public_id  TEXT,
        mime       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      DELETE FROM tg_pending WHERE created_at < now() - interval '1 day';
    `).catch((err) => {
      initPromise = null; // allow retry on next request
      throw err;
    });
  }
  return initPromise;
}

module.exports = { query, init, pool };
