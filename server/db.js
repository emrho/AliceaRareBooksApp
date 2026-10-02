import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'employee')),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  pub_year TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  binding TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  cost_cents INTEGER NOT NULL DEFAULT 0,
  list_price_cents INTEGER NOT NULL DEFAULT 0,
  acquired_date TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  ebay_listed INTEGER NOT NULL DEFAULT 0,
  ebay_ref TEXT NOT NULL DEFAULT '',
  whatnot_listed INTEGER NOT NULL DEFAULT 0,
  whatnot_ref TEXT NOT NULL DEFAULT '',
  amazon_listed INTEGER NOT NULL DEFAULT 0,
  amazon_ref TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('ebay', 'whatnot', 'amazon', 'other')),
  sale_date TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sale_price_cents INTEGER NOT NULL DEFAULT 0,
  shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
  platform_fees_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cost_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  order_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sales_date_idx ON sales(sale_date);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(expense_date);

-- clock_in / clock_out are local timestamps 'YYYY-MM-DDTHH:MM'.
-- The hourly rate is copied onto each entry so a raise never rewrites past pay.
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  edited_by_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS time_user_idx ON time_entries(user_id, clock_in);

-- Book photos (cover first). Files live in data/photos/<id>.jpg and <id>_t.jpg (thumbnail).
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  ebay_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_book_idx ON photos(book_id, position);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  business_name: 'Alicea Rare Books',
  week_start: '1', // 0 = Sunday, 1 = Monday
  overtime_enabled: '1',
  overtime_threshold_hours: '40',
  overtime_multiplier: '1.5',
  expense_categories: 'Inventory purchases,Shipping supplies,Postage,Platform subscriptions,Equipment,Software,Marketing,Travel,Other',
  // Google Sheets links (one per tab); empty = that section is managed in the app.
  sheets_inventory_url: '',
  sheets_sales_url: '',
  sheets_expenses_url: '',
  sheets_auto_minutes: '15',
  sheets_last_result: '',
  // eBay account connection and listing defaults (see server/ebay.js).
  ebay_refresh_token: '',
  ebay_refresh_expires: '',
  ebay_user: '',
  ebay_oauth_state: '',
  ebay_fulfillment_policy_id: '',
  ebay_payment_policy_id: '',
  ebay_return_policy_id: '',
  ebay_location_key: '',
};

// Columns added after the first release; ALTER TABLE them onto older databases.
const ADDED_COLUMNS = {
  // origin: 'app' (entered here) or 'sheet' (imported from Google Sheets)
  books: { origin: "TEXT NOT NULL DEFAULT 'app'", sheet_row: 'INTEGER', ebay_offer_id: "TEXT NOT NULL DEFAULT ''" },
  sales: { origin: "TEXT NOT NULL DEFAULT 'app'", sheet_row: 'INTEGER' },
  expenses: { origin: "TEXT NOT NULL DEFAULT 'app'", sheet_row: 'INTEGER' },
};

export const dataDir = (file = process.env.DB_PATH) => (file && file !== ':memory:' ? path.dirname(file) : path.join(process.cwd(), 'data'));

export function openDb(file = process.env.DB_PATH || path.join(process.cwd(), 'data', 'books.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
