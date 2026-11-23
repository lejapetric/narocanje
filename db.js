const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
require('fs').mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','provider','customer')),
  name TEXT, phone TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  slug TEXT UNIQUE NOT NULL, business_name TEXT NOT NULL, description TEXT DEFAULT '',
  address TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', cover_image TEXT,
  accent TEXT DEFAULT '#9a7452',
  slot_step INTEGER DEFAULT 15, buffer_min INTEGER DEFAULT 0,
  min_notice_hours INTEGER DEFAULT 2, max_days_ahead INTEGER DEFAULT 60,
  cancel_hours INTEGER DEFAULT 24,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  category TEXT DEFAULT '', name TEXT NOT NULL, description TEXT DEFAULT '',
  duration_min INTEGER NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0,
  image TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
  -- čakalni čas (npr. barva deluje): od processing_offset minut za processing_min minut je izvajalka prosta
  processing_offset INTEGER DEFAULT 0, processing_min INTEGER DEFAULT 0,
  gap_allowed TEXT DEFAULT '[]'  -- JSON seznam ID storitev, ki se lahko izvajajo med čakanjem ([] = katerakoli, ki se prilega)
);
CREATE TABLE IF NOT EXISTS weekly_hours (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL -- weekday 1=pon .. 7=ned
);
CREATE TABLE IF NOT EXISTS date_overrides (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  date TEXT NOT NULL, closed INTEGER DEFAULT 0, ranges TEXT DEFAULT '[]', note TEXT DEFAULT '',
  UNIQUE(provider_id, date)
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  start TEXT NOT NULL, end TEXT NOT NULL, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  customer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL, customer_email TEXT, customer_phone TEXT, note TEXT DEFAULT '',
  start TEXT NOT NULL, end TEXT NOT NULL, total_cents INTEGER DEFAULT 0,
  status TEXT DEFAULT 'confirmed', token TEXT UNIQUE, reminder_sent INTEGER DEFAULT 0,
  source TEXT DEFAULT 'online', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id INTEGER, name TEXT, start TEXT NOT NULL, end TEXT NOT NULL,
  gap_start TEXT, gap_end TEXT, gap_allowed TEXT DEFAULT '[]', price_cents INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, booking_id INTEGER, provider_id INTEGER, channel TEXT, recipient TEXT,
  subject TEXT, body TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now'))
);
`);

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verify(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
module.exports = { db, q, hash, verify };
