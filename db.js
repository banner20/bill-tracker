'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS bills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_type   TEXT    NOT NULL,
    vendor      TEXT,
    amount      REAL,
    currency    TEXT    NOT NULL DEFAULT '₹',
    bill_date   TEXT,                      -- ISO date the bill is for / paid on
    due_date    TEXT,
    status      TEXT    NOT NULL DEFAULT 'unpaid',  -- unpaid | paid | reviewed
    note        TEXT,
    created_at  TEXT    NOT NULL,
    created_by  TEXT
  );

  CREATE TABLE IF NOT EXISTS tags (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pinned  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bill_tags (
    bill_id  INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (bill_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id       INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    original_name TEXT,
    mime          TEXT,
    size          INTEGER,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bill_tags_tag  ON bill_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_bill_tags_bill ON bill_tags(bill_id);
  CREATE INDEX IF NOT EXISTS idx_attach_bill    ON attachments(bill_id);
  CREATE INDEX IF NOT EXISTS idx_bills_status   ON bills(status);
`);

// --- Lightweight migrations (safe if columns already exist) --------------
const tagCols = db.prepare(`PRAGMA table_info(tags)`).all().map((c) => c.name);
if (!tagCols.includes('pinned')) {
  db.exec(`ALTER TABLE tags ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
}

module.exports = db;
