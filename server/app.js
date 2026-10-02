import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, tx, DEFAULT_SETTINGS } from './db.js';
import { COOKIE, createSession, hashPassword, sessionUser, verifyPassword } from './auth.js';
import {
  addDays, computePay, entryHours, isValidDate, isValidTimestamp, nowLocal, todayLocal, weekStartOf,
} from './payroll.js';
import { SECTIONS, parseSheetUrl, serviceAccount, syncAll } from './sheets.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const CHANNELS = ['ebay', 'whatnot', 'amazon', 'other'];
const SECTION_TABLE = { inventory: 'books', sales: 'sales', expenses: 'expenses' };

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new ApiError(400, msg);

// ---- input helpers --------------------------------------------------------

function str(body, key, { required = false, max = 2000 } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${key} is required`);
    return '';
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${key} must be text`);
  const s = String(v).trim();
  if (required && !s) throw bad(`${key} is required`);
  if (s.length > max) throw bad(`${key} is too long`);
  return s;
}

function int(body, key, { min = 0, max = 1e10, fallback = 0 } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${key} must be a whole number${min === 0 ? ' (0 or more)' : ''}`);
  return n;
}

const bool = (body, key) => (body[key] ? 1 : 0);

function date(body, key, { required = true } = {}) {
  const v = body[key];
  if (!v && !required) return '';
  if (!isValidDate(v)) throw bad(`${key} must be a date (YYYY-MM-DD)`);
  return v;
}

function timestamp(body, key, { required = true } = {}) {
  const v = body[key];
  if (!v && !required) return null;
  if (!isValidTimestamp(v)) throw bad(`${key} must be a date and time`);
  return v;
}

function range(query) {
  const today = todayLocal();
  const from = isValidDate(query.from) ? query.from : addDays(today, -29);
  const to = isValidDate(query.to) ? query.to : today;
  if (from > to) throw bad('from must be on or before to');
  return { from, to };
}

function csv(rows, columns) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => c.label).join(','), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(','))].join('\r\n') + '\r\n';
}

const dollars = (cents) => (cents / 100).toFixed(2);

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// ---- app ------------------------------------------------------------------

export function createApp(db, { fetchImpl, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  function setSessionCookie(req, res, userId) {
    const { token, maxAge } = createSession(db, userId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge, secure: req.secure, path: '/' });
  }

  const auth = (req, res, next) => {
    req.user = sessionUser(db, req);
    if (!req.user) return next(new ApiError(401, 'Please sign in'));
    next();
  };
  const ownerOnly = (req, res, next) => {
    if (req.user?.role !== 'owner') return next(new ApiError(403, 'Only the owner can do that'));
    next();
  };

  // ---- Google Sheets links ------------------------------------------------

  const linked = (section, settings = getSettings(db)) => !!settings[`sheets_${section}_url`];
  const LINKED_MSG = {
    inventory: 'Inventory comes from your Google Sheet. Make this change in the sheet, then sync.',
    sales: 'Sales come from your Google Sheet. Make this change in the sheet, then sync.',
    expenses: 'Expenses come from your Google Sheet. Make this change in the sheet, then sync.',
  };
  const fromSheet = (section, row) => {
    if (row?.origin === 'sheet') throw new ApiError(409, LINKED_MSG[section]);
  };
  const notLinked = (section) => {
    if (linked(section)) throw new ApiError(409, LINKED_MSG[section]);
  };

  function lastSync(settings) {
    try { return JSON.parse(settings.sheets_last_result || 'null'); } catch { return null; }
  }

  function sheetsStatus(settings, isOwnerUser) {
    const last = lastSync(settings);
    const out = { lastSyncAt: last?.at || null, lastOk: last ? last.ok : null };
    for (const sec of SECTIONS) {
      out[sec] = linked(sec, settings);
      if (isOwnerUser && out[sec]) out[`${sec}Url`] = settings[`sheets_${sec}_url`];
    }
    return out;
  }

  let syncing = null;
  /** Runs one sync at a time; concurrent callers share the in-flight run. */
  function syncSheets() {
    if (syncing) return syncing;
    const settings = getSettings(db);
    const urls = Object.fromEntries(SECTIONS.map((sec) => [sec, settings[`sheets_${sec}_url`]]));
    syncing = syncAll(db, urls, { ...(fetchImpl && { fetchImpl }), sa: serviceAccount(env) })
      .then((result) => {
        db.prepare(`UPDATE settings SET value = ? WHERE key = 'sheets_last_result'`).run(JSON.stringify(result));
        return result;
      })
      .finally(() => { syncing = null; });
    return syncing;
  }
  app.locals.syncSheets = syncSheets;
  app.locals.sheetsLinked = () => SECTIONS.some((sec) => linked(sec));

  // Reject cross-site form posts: every mutating API call must be JSON.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      return next(new ApiError(415, 'Requests must be JSON'));
    }
    req.body ??= {};
    next();
  });

  // ---- session ------------------------------------------------------------

  app.get('/api/status', (req, res) => {
    const user = sessionUser(db, req);
    const settings = getSettings(db);
    res.json({
      needsSetup: userCount() === 0,
      user: user && { id: user.id, name: user.name, username: user.username, role: user.role },
      businessName: settings.business_name,
      weekStart: Number(settings.week_start),
      today: todayLocal(),
      sheets: user ? sheetsStatus(settings, user.role === 'owner') : null,
    });
  });

  app.post('/api/setup', (req, res) => {
    const name = str(req.body, 'name', { required: true, max: 100 });
    const username = str(req.body, 'username', { required: true, max: 50 });
    const password = str(req.body, 'password', { required: true, max: 200 });
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    const id = tx(db, () => {
      if (userCount() > 0) throw new ApiError(409, 'Setup has already been completed');
      return db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'owner')`)
        .run(name, username, hashPassword(password)).lastInsertRowid;
    });
    if (req.body.business_name) {
      db.prepare(`UPDATE settings SET value = ? WHERE key = 'business_name'`).run(str(req.body, 'business_name', { max: 100 }));
    }
    setSessionCookie(req, res, Number(id));
    res.status(201).json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const username = str(req.body, 'username', { required: true });
    const password = str(req.body, 'password', { required: true });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      throw new ApiError(401, 'Wrong username or password');
    }
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
    setSessionCookie(req, res, user.id);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const user = sessionUser(db, req);
    if (user) db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.post('/api/me/password', auth, (req, res) => {
    const current = str(req.body, 'current_password', { required: true });
    const next = str(req.body, 'new_password', { required: true, max: 200 });
    if (next.length < 8) throw bad('New password must be at least 8 characters');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, row.password_hash)) throw bad('Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.user.token);
    res.json({ ok: true });
  });

  // ---- inventory ----------------------------------------------------------

  const BOOK_TEXT = ['title', 'author', 'isbn', 'publisher', 'pub_year', 'edition', 'binding', 'condition',
    'description', 'location', 'acquired_date', 'source', 'ebay_ref', 'whatnot_ref', 'amazon_ref', 'notes'];

  function readBook(body) {
    const b = { sku: str(body, 'sku', { required: true, max: 60 }) };
    for (const k of BOOK_TEXT) b[k] = str(body, k, { required: k === 'title', max: k === 'description' || k === 'notes' ? 5000 : 300 });
    if (b.acquired_date && !isValidDate(b.acquired_date)) throw bad('acquired_date must be a date (YYYY-MM-DD)');
    b.quantity = int(body, 'quantity', { max: 100000, fallback: 1 });
    b.cost_cents = int(body, 'cost_cents');
    b.list_price_cents = int(body, 'list_price_cents');
    for (const ch of ['ebay', 'whatnot', 'amazon']) b[`${ch}_listed`] = bool(body, `${ch}_listed`);
    b.archived = bool(body, 'archived');
    return b;
  }

  function nextSku() {
    const rows = db.prepare(`SELECT sku FROM books WHERE sku LIKE 'ARB-%'`).all();
    const max = rows.reduce((m, r) => Math.max(m, Number(r.sku.slice(4)) || 0), 0);
    return `ARB-${String(max + 1).padStart(5, '0')}`;
  }

  function uniqueSku(fn) {
    try {
      return fn();
    } catch (err) {
      if (String(err.message).includes('UNIQUE') && String(err.message).includes('sku')) throw new ApiError(409, 'That SKU is already used by another book');
      throw err;
    }
  }

  app.get('/api/books/next-sku', auth, (req, res) => res.json({ sku: nextSku() }));

  app.get('/api/books', auth, (req, res) => {
    const where = [];
    const params = [];
    const status = req.query.status || 'active';
    if (status === 'active') where.push('archived = 0 AND quantity > 0');
    else if (status === 'soldout') where.push('archived = 0 AND quantity = 0');
    else if (status === 'stale') where.push('archived = 0 AND quantity = 0 AND (ebay_listed + whatnot_listed + amazon_listed) > 0');
    else if (status === 'archived') where.push('archived = 1');
    const channel = req.query.channel;
    if (['ebay', 'whatnot', 'amazon'].includes(channel)) where.push(`${channel}_listed = 1`);
    else if (channel === 'unlisted') where.push('(ebay_listed + whatnot_listed + amazon_listed) = 0');
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push(`(title LIKE ? OR author LIKE ? OR sku LIKE ? OR isbn LIKE ? OR location LIKE ? OR publisher LIKE ?)`);
      params.push(...Array(6).fill(`%${q}%`));
    }
    const sql = `SELECT * FROM books ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT 2000`;
    const counts = db.prepare(`SELECT
        SUM(archived = 0 AND quantity > 0) AS active,
        SUM(archived = 0 AND quantity = 0) AS soldout,
        SUM(archived = 0 AND quantity = 0 AND (ebay_listed + whatnot_listed + amazon_listed) > 0) AS stale,
        SUM(archived = 1) AS archived, COUNT(*) AS total FROM books`).get();
    res.json({ books: db.prepare(sql).all(...params), counts });
  });

  app.get('/api/books/:id', auth, (req, res) => {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
    if (!book) throw new ApiError(404, 'Book not found');
    const sales = req.user.role === 'owner'
      ? db.prepare('SELECT * FROM sales WHERE book_id = ? ORDER BY sale_date DESC').all(book.id)
      : [];
    res.json({ book, sales });
  });

  app.post('/api/books', auth, (req, res) => {
    notLinked('inventory');
    const b = readBook(req.body);
    const cols = Object.keys(b);
    const id = uniqueSku(() => db.prepare(`INSERT INTO books (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => b[c])).lastInsertRowid);
    res.status(201).json({ book: db.prepare('SELECT * FROM books WHERE id = ?').get(id) });
  });

  app.put('/api/books/:id', auth, (req, res) => {
    const existing = db.prepare('SELECT id, origin FROM books WHERE id = ?').get(req.params.id);
    if (!existing) throw new ApiError(404, 'Book not found');
    fromSheet('inventory', existing);
    const b = readBook(req.body);
    const cols = Object.keys(b);
    uniqueSku(() => db.prepare(`UPDATE books SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => b[c]), req.params.id));
    res.json({ book: db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) });
  });

  app.delete('/api/books/:id', auth, ownerOnly, (req, res) => {
    fromSheet('inventory', db.prepare('SELECT origin FROM books WHERE id = ?').get(req.params.id));
    const used = db.prepare('SELECT COUNT(*) AS n FROM sales WHERE book_id = ?').get(req.params.id).n;
    if (used) {
      db.prepare(`UPDATE books SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
      return res.json({ archived: true });
    }
    const r = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
    if (!r.changes) throw new ApiError(404, 'Book not found');
    res.json({ deleted: true });
  });

  // ---- sales --------------------------------------------------------------

  function readSaleMoney(body) {
    const channel = str(body, 'channel', { required: true });
    if (!CHANNELS.includes(channel)) throw bad('channel must be eBay, Whatnot, Amazon or Other');
    return {
      channel,
      sale_date: date(body, 'sale_date'),
      sale_price_cents: int(body, 'sale_price_cents'),
      shipping_charged_cents: int(body, 'shipping_charged_cents'),
      platform_fees_cents: int(body, 'platform_fees_cents'),
      shipping_cost_cents: int(body, 'shipping_cost_cents'),
      order_ref: str(body, 'order_ref', { max: 200 }),
      notes: str(body, 'notes', { max: 2000 }),
    };
  }

  app.get('/api/sales', auth, ownerOnly, (req, res) => {
    const { from, to } = range(req.query);
    const params = [from, to];
    let extra = '';
    if (CHANNELS.includes(req.query.channel)) {
      extra = ' AND s.channel = ?';
      params.push(req.query.channel);
    }
    const sales = db.prepare(`SELECT s.*, b.sku, u.name AS created_by_name FROM sales s
      LEFT JOIN books b ON b.id = s.book_id LEFT JOIN users u ON u.id = s.created_by
      WHERE s.sale_date BETWEEN ? AND ?${extra} ORDER BY s.sale_date DESC, s.id DESC`).all(...params);
    res.json({ from, to, sales });
  });

  app.post('/api/sales', auth, (req, res) => {
    notLinked('sales');
    const s = readSaleMoney(req.body);
    const quantity = int(req.body, 'quantity', { min: 1, max: 10000, fallback: 1 });
    const bookId = req.body.book_id ? int(req.body, 'book_id', { min: 1 }) : null;
    const id = tx(db, () => {
      let title = str(req.body, 'title', { max: 300 });
      let cost = int(req.body, 'cost_cents');
      if (bookId) {
        const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
        if (!book) throw new ApiError(404, 'Book not found');
        if (book.quantity < quantity) throw bad(`Only ${book.quantity} in stock for "${book.title}"`);
        db.prepare(`UPDATE books SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?`).run(quantity, bookId);
        title = book.title;
        cost = book.cost_cents * quantity;
      } else if (!title) {
        throw bad('Pick a book from inventory or type a title');
      }
      return db.prepare(`INSERT INTO sales (book_id, title, channel, sale_date, quantity, sale_price_cents,
        shipping_charged_cents, platform_fees_cents, shipping_cost_cents, cost_cents, order_ref, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(bookId, title, s.channel, s.sale_date, quantity, s.sale_price_cents,
        s.shipping_charged_cents, s.platform_fees_cents, s.shipping_cost_cents, cost, s.order_ref, s.notes, req.user.id).lastInsertRowid;
    });
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    const book = bookId ? db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) : null;
    // Selling the last copy on one channel means the other listings must come down.
    const stillListed = book && book.quantity === 0
      ? ['ebay', 'whatnot', 'amazon'].filter((ch) => book[`${ch}_listed`])
      : [];
    res.status(201).json({ sale, stillListed });
  });

  app.put('/api/sales/:id', auth, ownerOnly, (req, res) => {
    const existing = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    if (!existing) throw new ApiError(404, 'Sale not found');
    fromSheet('sales', existing);
    const s = readSaleMoney(req.body);
    const cost = req.body.cost_cents === undefined ? existing.cost_cents : int(req.body, 'cost_cents');
    const title = existing.book_id ? existing.title : str(req.body, 'title', { required: true, max: 300 });
    db.prepare(`UPDATE sales SET channel=?, sale_date=?, sale_price_cents=?, shipping_charged_cents=?, platform_fees_cents=?,
      shipping_cost_cents=?, cost_cents=?, order_ref=?, notes=?, title=? WHERE id = ?`).run(s.channel, s.sale_date, s.sale_price_cents,
      s.shipping_charged_cents, s.platform_fees_cents, s.shipping_cost_cents, cost, s.order_ref, s.notes, title, req.params.id);
    res.json({ sale: db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id) });
  });

  app.delete('/api/sales/:id', auth, ownerOnly, (req, res) => {
    tx(db, () => {
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) throw new ApiError(404, 'Sale not found');
      fromSheet('sales', sale);
      if (sale.book_id && req.body?.restock !== false) {
        db.prepare(`UPDATE books SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(sale.quantity, sale.book_id);
      }
      db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);
    });
    res.json({ deleted: true });
  });

  // ---- expenses -----------------------------------------------------------

  function readExpense(body) {
    return {
      expense_date: date(body, 'expense_date'),
      category: str(body, 'category', { required: true, max: 100 }),
      vendor: str(body, 'vendor', { max: 200 }),
      amount_cents: int(body, 'amount_cents'),
      notes: str(body, 'notes', { max: 2000 }),
    };
  }

  app.get('/api/expenses', auth, ownerOnly, (req, res) => {
    const { from, to } = range(req.query);
    const expenses = db.prepare(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC`).all(from, to);
    res.json({ from, to, expenses });
  });

  app.post('/api/expenses', auth, ownerOnly, (req, res) => {
    notLinked('expenses');
    const e = readExpense(req.body);
    const id = db.prepare(`INSERT INTO expenses (expense_date, category, vendor, amount_cents, notes, created_by) VALUES (?,?,?,?,?,?)`)
      .run(e.expense_date, e.category, e.vendor, e.amount_cents, e.notes, req.user.id).lastInsertRowid;
    res.status(201).json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) });
  });

  app.put('/api/expenses/:id', auth, ownerOnly, (req, res) => {
    fromSheet('expenses', db.prepare('SELECT origin FROM expenses WHERE id = ?').get(req.params.id));
    const e = readExpense(req.body);
    const r = db.prepare(`UPDATE expenses SET expense_date=?, category=?, vendor=?, amount_cents=?, notes=? WHERE id = ?`)
      .run(e.expense_date, e.category, e.vendor, e.amount_cents, e.notes, req.params.id);
    if (!r.changes) throw new ApiError(404, 'Expense not found');
    res.json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id) });
  });

  app.delete('/api/expenses/:id', auth, ownerOnly, (req, res) => {
    fromSheet('expenses', db.prepare('SELECT origin FROM expenses WHERE id = ?').get(req.params.id));
    const r = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    if (!r.changes) throw new ApiError(404, 'Expense not found');
    res.json({ deleted: true });
  });

  // ---- time clock ---------------------------------------------------------

  const openEntry = (userId) => db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1').get(userId);

  app.get('/api/time/me', auth, (req, res) => {
    const settings = getSettings(db);
    const today = todayLocal();
    const weekFrom = weekStartOf(today, Number(settings.week_start));
    const weekTo = addDays(weekFrom, 6);
    const entries = db.prepare(`SELECT * FROM time_entries WHERE user_id = ? AND substr(clock_in, 1, 10) BETWEEN ? AND ? ORDER BY clock_in DESC`)
      .all(req.user.id, weekFrom, weekTo);
    const pay = computePay(entries, settings)[req.user.id];
    const open = openEntry(req.user.id);
    res.json({
      now: nowLocal(),
      open: open ? { ...open, hours_so_far: Math.round(entryHours(open, nowLocal()) * 100) / 100 } : null,
      week: { from: weekFrom, to: weekTo },
      entries: entries.map((e) => ({ ...e, hours: Math.round(entryHours(e) * 100) / 100 })),
      totals: pay || { regular_hours: 0, overtime_hours: 0, total_hours: 0, gross_cents: 0 },
      rate_cents: req.user.hourly_rate_cents,
    });
  });

  app.post('/api/time/clock-in', auth, (req, res) => {
    const id = tx(db, () => {
      if (openEntry(req.user.id)) throw new ApiError(409, 'You are already clocked in');
      return db.prepare('INSERT INTO time_entries (user_id, clock_in, hourly_rate_cents, notes) VALUES (?, ?, ?, ?)')
        .run(req.user.id, nowLocal(), req.user.hourly_rate_cents, str(req.body, 'notes', { max: 500 })).lastInsertRowid;
    });
    res.status(201).json({ entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) });
  });

  app.post('/api/time/clock-out', auth, (req, res) => {
    const open = openEntry(req.user.id);
    if (!open) throw new ApiError(409, 'You are not clocked in');
    const breakMin = int(req.body, 'break_minutes', { max: 1440 });
    const notes = str(req.body, 'notes', { max: 500 });
    let out = nowLocal();
    if (out < open.clock_in) out = open.clock_in;
    db.prepare('UPDATE time_entries SET clock_out = ?, break_minutes = ?, notes = ? WHERE id = ?')
      .run(out, breakMin, [open.notes, notes].filter(Boolean).join(' — '), open.id);
    res.json({ entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id) });
  });

  app.get('/api/time/entries', auth, (req, res) => {
    const { from, to } = range(req.query);
    const params = [from, to];
    let filter = '';
    if (req.user.role !== 'owner') {
      filter = ' AND t.user_id = ?';
      params.push(req.user.id);
    } else if (req.query.user_id) {
      filter = ' AND t.user_id = ?';
      params.push(Number(req.query.user_id));
    }
    const entries = db.prepare(`SELECT t.*, u.name FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE substr(t.clock_in, 1, 10) BETWEEN ? AND ?${filter} ORDER BY t.clock_in DESC`).all(...params);
    res.json({ from, to, entries: entries.map((e) => ({ ...e, hours: Math.round(entryHours(e) * 100) / 100 })) });
  });

  function readEntry(body) {
    const clock_in = timestamp(body, 'clock_in');
    const clock_out = timestamp(body, 'clock_out', { required: false });
    if (clock_out && clock_out < clock_in) throw bad('Clock-out must be after clock-in');
    return { clock_in, clock_out, break_minutes: int(body, 'break_minutes', { max: 1440 }), notes: str(body, 'notes', { max: 500 }) };
  }

  app.post('/api/time/entries', auth, ownerOnly, (req, res) => {
    const e = readEntry(req.body);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(int(req.body, 'user_id', { min: 1 }));
    if (!user) throw bad('Pick a team member');
    const rate = req.body.hourly_rate_cents === undefined || req.body.hourly_rate_cents === '' ? user.hourly_rate_cents : int(req.body, 'hourly_rate_cents');
    if (!e.clock_out && openEntry(user.id)) throw bad(`${user.name} already has an open shift`);
    const id = db.prepare(`INSERT INTO time_entries (user_id, clock_in, clock_out, break_minutes, hourly_rate_cents, notes, edited_by_owner)
      VALUES (?,?,?,?,?,?,1)`).run(user.id, e.clock_in, e.clock_out, e.break_minutes, rate, e.notes).lastInsertRowid;
    res.status(201).json({ entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) });
  });

  app.put('/api/time/entries/:id', auth, ownerOnly, (req, res) => {
    const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
    if (!existing) throw new ApiError(404, 'Time entry not found');
    const e = readEntry(req.body);
    const rate = req.body.hourly_rate_cents === undefined || req.body.hourly_rate_cents === '' ? existing.hourly_rate_cents : int(req.body, 'hourly_rate_cents');
    db.prepare(`UPDATE time_entries SET clock_in=?, clock_out=?, break_minutes=?, hourly_rate_cents=?, notes=?, edited_by_owner=1 WHERE id = ?`)
      .run(e.clock_in, e.clock_out, e.break_minutes, rate, e.notes, req.params.id);
    res.json({ entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id) });
  });

  app.delete('/api/time/entries/:id', auth, ownerOnly, (req, res) => {
    const r = db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
    if (!r.changes) throw new ApiError(404, 'Time entry not found');
    res.json({ deleted: true });
  });

  // ---- payroll ------------------------------------------------------------

  function payrollForWeek(week) {
    const settings = getSettings(db);
    const from = weekStartOf(isValidDate(week) ? week : todayLocal(), Number(settings.week_start));
    const to = addDays(from, 6);
    const entries = db.prepare(`SELECT * FROM time_entries WHERE substr(clock_in, 1, 10) BETWEEN ? AND ?`).all(from, to);
    const pay = computePay(entries, settings);
    const open = new Set(entries.filter((e) => !e.clock_out).map((e) => e.user_id));
    const users = db.prepare(`SELECT id, name, role, hourly_rate_cents, active FROM users ORDER BY active DESC, name`).all();
    const rows = users
      .filter((u) => pay[u.id] || (u.active && u.role === 'employee'))
      .map((u) => ({
        user_id: u.id, name: u.name, role: u.role, active: u.active, hourly_rate_cents: u.hourly_rate_cents,
        regular_hours: 0, overtime_hours: 0, total_hours: 0, gross_cents: 0, entries: 0, days: {},
        ...pay[u.id], open_shift: open.has(u.id),
      }));
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const totals = rows.reduce((t, r) => ({
      total_hours: Math.round((t.total_hours + r.total_hours) * 100) / 100,
      overtime_hours: Math.round((t.overtime_hours + r.overtime_hours) * 100) / 100,
      gross_cents: t.gross_cents + r.gross_cents,
    }), { total_hours: 0, overtime_hours: 0, gross_cents: 0 });
    return { from, to, days, rows, totals, settings: { overtime_enabled: settings.overtime_enabled === '1', overtime_threshold_hours: Number(settings.overtime_threshold_hours), overtime_multiplier: Number(settings.overtime_multiplier) } };
  }

  app.get('/api/payroll', auth, ownerOnly, (req, res) => res.json(payrollForWeek(req.query.week)));

  app.get('/api/payroll.csv', auth, ownerOnly, (req, res) => {
    const p = payrollForWeek(req.query.week);
    const rows = p.rows.filter((r) => r.entries > 0);
    sendCsv(res, `payroll-${p.from}.csv`, csv(rows, [
      { label: 'Week start', value: () => p.from },
      { label: 'Week end', value: () => p.to },
      { label: 'Name', value: (r) => r.name },
      ...p.days.map((d) => ({ label: d, value: (r) => r.days[d] || 0 })),
      { label: 'Regular hours', value: (r) => r.regular_hours },
      { label: 'Overtime hours', value: (r) => r.overtime_hours },
      { label: 'Current rate', value: (r) => dollars(r.hourly_rate_cents) },
      { label: 'Gross pay', value: (r) => dollars(r.gross_cents) },
    ]));
  });

  // ---- team ---------------------------------------------------------------

  app.get('/api/users', auth, ownerOnly, (req, res) => {
    const users = db.prepare(`SELECT u.id, u.name, u.username, u.role, u.hourly_rate_cents, u.active, u.created_at,
      (SELECT clock_in FROM time_entries t WHERE t.user_id = u.id AND t.clock_out IS NULL LIMIT 1) AS clocked_in_since
      FROM users u ORDER BY u.active DESC, u.name`).all();
    res.json({ users });
  });

  function ownersLeft(excludingId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id != ?`).get(excludingId).n;
  }

  function uniqueUsername(fn) {
    try {
      return fn();
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new ApiError(409, 'That username is taken');
      throw err;
    }
  }

  app.post('/api/users', auth, ownerOnly, (req, res) => {
    const name = str(req.body, 'name', { required: true, max: 100 });
    const username = str(req.body, 'username', { required: true, max: 50 });
    const password = str(req.body, 'password', { required: true, max: 200 });
    if (password.length < 8) throw bad('Password must be at least 8 characters');
    const role = req.body.role === 'owner' ? 'owner' : 'employee';
    const rate = int(req.body, 'hourly_rate_cents', { max: 100000 });
    const id = uniqueUsername(() => db.prepare(`INSERT INTO users (name, username, password_hash, role, hourly_rate_cents) VALUES (?,?,?,?,?)`)
      .run(name, username, hashPassword(password), role, rate).lastInsertRowid);
    res.status(201).json({ id: Number(id) });
  });

  app.put('/api/users/:id', auth, ownerOnly, (req, res) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError(404, 'Team member not found');
    const name = str(req.body, 'name', { required: true, max: 100 });
    const username = str(req.body, 'username', { required: true, max: 50 });
    const role = req.body.role === 'owner' ? 'owner' : 'employee';
    const active = bool(req.body, 'active');
    const rate = int(req.body, 'hourly_rate_cents', { max: 100000 });
    if (user.role === 'owner' && (role !== 'owner' || !active) && ownersLeft(id) === 0) {
      throw bad('There must always be at least one active owner');
    }
    const password = str(req.body, 'password', { max: 200 });
    if (password && password.length < 8) throw bad('Password must be at least 8 characters');
    uniqueUsername(() => tx(db, () => {
      db.prepare('UPDATE users SET name=?, username=?, role=?, active=?, hourly_rate_cents=? WHERE id = ?').run(name, username, role, active, rate, id);
      if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
      if (password || !active) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(id, req.user.token);
      // A raise applies to the shift in progress too.
      db.prepare('UPDATE time_entries SET hourly_rate_cents = ? WHERE user_id = ? AND clock_out IS NULL').run(rate, id);
    }));
    res.json({ ok: true });
  });

  // ---- settings -----------------------------------------------------------

  app.get('/api/settings', auth, ownerOnly, (req, res) => res.json({ settings: getSettings(db) }));

  app.put('/api/settings', auth, ownerOnly, (req, res) => {
    const s = req.body.settings || {};
    const out = {};
    if ('business_name' in s) out.business_name = str(s, 'business_name', { required: true, max: 100 });
    if ('week_start' in s) out.week_start = String(int(s, 'week_start', { max: 6 }));
    if ('overtime_enabled' in s) out.overtime_enabled = s.overtime_enabled ? '1' : '0';
    if ('overtime_threshold_hours' in s) {
      const n = Number(s.overtime_threshold_hours);
      if (!(n > 0 && n <= 168)) throw bad('Overtime threshold must be between 1 and 168 hours');
      out.overtime_threshold_hours = String(n);
    }
    if ('overtime_multiplier' in s) {
      const n = Number(s.overtime_multiplier);
      if (!(n >= 1 && n <= 5)) throw bad('Overtime multiplier must be between 1 and 5');
      out.overtime_multiplier = String(n);
    }
    if ('expense_categories' in s) {
      const cats = String(s.expense_categories).split(',').map((c) => c.trim()).filter(Boolean);
      out.expense_categories = (cats.length ? cats : DEFAULT_SETTINGS.expense_categories.split(',')).join(',');
    }
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(db, () => Object.entries(out).forEach(([k, v]) => upd.run(k, v)));
    res.json({ settings: getSettings(db) });
  });

  app.get('/api/expense-categories', auth, (req, res) => {
    res.json({ categories: getSettings(db).expense_categories.split(',') });
  });

  // ---- google sheets ------------------------------------------------------

  app.get('/api/sheets', auth, ownerOnly, (req, res) => {
    const settings = getSettings(db);
    const sa = serviceAccount(env);
    res.json({
      urls: Object.fromEntries(SECTIONS.map((sec) => [sec, settings[`sheets_${sec}_url`]])),
      autoMinutes: Number(settings.sheets_auto_minutes),
      serviceAccountEmail: sa && !sa.error ? sa.client_email : null,
      serviceAccountError: sa?.error || null,
      last: lastSync(settings),
      // Rows entered in the app that sit alongside a linked tab (they'd be counted twice
      // if the sheet holds the same history).
      appRows: Object.fromEntries(SECTIONS.filter((sec) => linked(sec, settings))
        .map((sec) => [sec, db.prepare(`SELECT COUNT(*) AS n FROM ${SECTION_TABLE[sec]} WHERE origin = 'app'`).get().n])),
    });
  });

  app.post('/api/sheets/clear-app', auth, ownerOnly, (req, res) => {
    const sec = req.body.section;
    if (!SECTIONS.includes(sec)) throw bad('Unknown section');
    if (!linked(sec)) throw bad('Only sections linked to a sheet can be cleared');
    const r = db.prepare(`DELETE FROM ${SECTION_TABLE[sec]} WHERE origin = 'app'`).run();
    res.json({ deleted: r.changes });
  });

  app.put('/api/sheets', auth, ownerOnly, (req, res) => {
    const urls = req.body.urls || {};
    const out = {};
    for (const sec of SECTIONS) {
      if (!(sec in urls)) continue;
      try {
        out[`sheets_${sec}_url`] = parseSheetUrl(urls[sec])?.url || '';
      } catch (err) {
        throw bad(`${sec[0].toUpperCase()}${sec.slice(1)} link: ${err.message}`);
      }
    }
    if ('autoMinutes' in req.body) out.sheets_auto_minutes = String(int(req.body, 'autoMinutes', { max: 1440 }));
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(db, () => Object.entries(out).forEach(([k, v]) => upd.run(k, v)));
    res.json({ ok: true, sheets: sheetsStatus(getSettings(db), true) });
  });

  app.post('/api/sheets/sync', auth, ownerOnly, async (req, res) => {
    if (!SECTIONS.some((sec) => linked(sec))) throw bad('Add at least one Google Sheets link first');
    res.json(await syncSheets());
  });

  // ---- dashboard ----------------------------------------------------------

  app.get('/api/dashboard', auth, ownerOnly, (req, res) => {
    const { from, to } = range(req.query);
    const settings = getSettings(db);
    const weekStart = Number(settings.week_start);

    const sales = db.prepare('SELECT * FROM sales WHERE sale_date BETWEEN ? AND ?').all(from, to);
    const expenses = db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ?').all(from, to);
    const entries = db.prepare('SELECT * FROM time_entries WHERE substr(clock_in, 1, 10) BETWEEN ? AND ?').all(from, to);

    const blank = () => ({ orders: 0, items: 0, revenue_cents: 0, shipping_charged_cents: 0, fees_cents: 0, shipping_cost_cents: 0, cogs_cents: 0, net_cents: 0 });
    const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, blank()]));
    const salesTotal = blank();
    for (const s of sales) {
      for (const t of [byChannel[s.channel], salesTotal]) {
        t.orders += 1;
        t.items += s.quantity;
        t.revenue_cents += s.sale_price_cents;
        t.shipping_charged_cents += s.shipping_charged_cents;
        t.fees_cents += s.platform_fees_cents;
        t.shipping_cost_cents += s.shipping_cost_cents;
        t.cogs_cents += s.cost_cents;
        t.net_cents += s.sale_price_cents + s.shipping_charged_cents - s.platform_fees_cents - s.shipping_cost_cents - s.cost_cents;
      }
    }

    const expenseByCat = {};
    let expenseTotal = 0;
    for (const e of expenses) {
      expenseByCat[e.category] = (expenseByCat[e.category] || 0) + e.amount_cents;
      expenseTotal += e.amount_cents;
    }

    const pay = computePay(entries, settings);
    const labor = Object.values(pay).reduce((t, p) => ({ hours: t.hours + p.total_hours, cents: t.cents + p.gross_cents }), { hours: 0, cents: 0 });

    // Weekly revenue by channel across the range.
    const weeks = [];
    for (let w = weekStartOf(from, weekStart); w <= to; w = addDays(w, 7)) {
      weeks.push({ week: w, ...Object.fromEntries(CHANNELS.map((c) => [c, 0])), expenses: 0, labor: 0 });
    }
    const weekIdx = new Map(weeks.map((w, i) => [w.week, i]));
    for (const s of sales) weeks[weekIdx.get(weekStartOf(s.sale_date, weekStart))][s.channel] += s.sale_price_cents + s.shipping_charged_cents;
    for (const e of expenses) weeks[weekIdx.get(weekStartOf(e.expense_date, weekStart))].expenses += e.amount_cents;

    // This week's team: hours, rate and pay so far, plus who is on the clock.
    const thisWeek = payrollForWeek(todayLocal());
    const users = db.prepare(`SELECT u.id, (SELECT clock_in FROM time_entries t WHERE t.user_id = u.id AND t.clock_out IS NULL LIMIT 1) AS since FROM users u`).all();
    const since = Object.fromEntries(users.map((u) => [u.id, u.since]));
    const team = thisWeek.rows.map((r) => ({ ...r, clocked_in_since: since[r.user_id] || null }));

    const inventory = db.prepare(`SELECT
        COUNT(*) AS titles, COALESCE(SUM(quantity), 0) AS units,
        COALESCE(SUM(quantity * cost_cents), 0) AS cost_value_cents,
        COALESCE(SUM(quantity * list_price_cents), 0) AS list_value_cents,
        COALESCE(SUM(ebay_listed), 0) AS ebay, COALESCE(SUM(whatnot_listed), 0) AS whatnot, COALESCE(SUM(amazon_listed), 0) AS amazon,
        COALESCE(SUM((ebay_listed + whatnot_listed + amazon_listed) = 0), 0) AS unlisted
      FROM books WHERE archived = 0 AND quantity > 0`).get();
    inventory.stale = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE archived = 0 AND quantity = 0 AND (ebay_listed + whatnot_listed + amazon_listed) > 0`).get().n;

    const recentSales = db.prepare(`SELECT * FROM sales ORDER BY sale_date DESC, id DESC LIMIT 8`).all();
    const grossIn = salesTotal.revenue_cents + salesTotal.shipping_charged_cents;

    res.json({
      from, to,
      totals: {
        gross_sales_cents: grossIn,
        orders: salesTotal.orders,
        items: salesTotal.items,
        fees_cents: salesTotal.fees_cents,
        shipping_cost_cents: salesTotal.shipping_cost_cents,
        cogs_cents: salesTotal.cogs_cents,
        sales_net_cents: salesTotal.net_cents,
        expenses_cents: expenseTotal,
        labor_cents: labor.cents,
        labor_hours: Math.round(labor.hours * 100) / 100,
        net_profit_cents: salesTotal.net_cents - expenseTotal - labor.cents,
      },
      byChannel,
      expensesByCategory: Object.entries(expenseByCat).map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
      weeks,
      team,
      teamWeek: { from: thisWeek.from, to: thisWeek.to, totals: thisWeek.totals },
      inventory,
      recentSales,
      sheets: sheetsStatus(settings, true),
    });
  });

  // ---- exports ------------------------------------------------------------

  app.get('/api/export/books.csv', auth, ownerOnly, (req, res) => {
    const rows = db.prepare('SELECT * FROM books ORDER BY sku').all();
    sendCsv(res, 'inventory.csv', csv(rows, [
      'sku', 'title', 'author', 'isbn', 'publisher', 'pub_year', 'edition', 'binding', 'condition', 'location', 'quantity',
    ].map((k) => ({ label: k, value: (r) => r[k] })).concat([
      { label: 'cost', value: (r) => dollars(r.cost_cents) },
      { label: 'list_price', value: (r) => dollars(r.list_price_cents) },
      { label: 'ebay', value: (r) => (r.ebay_listed ? r.ebay_ref || 'yes' : '') },
      { label: 'whatnot', value: (r) => (r.whatnot_listed ? r.whatnot_ref || 'yes' : '') },
      { label: 'amazon', value: (r) => (r.amazon_listed ? r.amazon_ref || 'yes' : '') },
      { label: 'acquired_date', value: (r) => r.acquired_date },
      { label: 'source', value: (r) => r.source },
      { label: 'archived', value: (r) => (r.archived ? 'yes' : '') },
      { label: 'notes', value: (r) => r.notes },
    ])));
  });

  app.get('/api/export/sales.csv', auth, ownerOnly, (req, res) => {
    const { from, to } = range(req.query);
    const rows = db.prepare('SELECT s.*, b.sku FROM sales s LEFT JOIN books b ON b.id = s.book_id WHERE sale_date BETWEEN ? AND ? ORDER BY sale_date').all(from, to);
    sendCsv(res, `sales-${from}-to-${to}.csv`, csv(rows, [
      { label: 'date', value: (r) => r.sale_date },
      { label: 'channel', value: (r) => r.channel },
      { label: 'order_ref', value: (r) => r.order_ref },
      { label: 'sku', value: (r) => r.sku },
      { label: 'title', value: (r) => r.title },
      { label: 'quantity', value: (r) => r.quantity },
      { label: 'sale_price', value: (r) => dollars(r.sale_price_cents) },
      { label: 'shipping_charged', value: (r) => dollars(r.shipping_charged_cents) },
      { label: 'platform_fees', value: (r) => dollars(r.platform_fees_cents) },
      { label: 'shipping_cost', value: (r) => dollars(r.shipping_cost_cents) },
      { label: 'cost_of_goods', value: (r) => dollars(r.cost_cents) },
      { label: 'net', value: (r) => dollars(r.sale_price_cents + r.shipping_charged_cents - r.platform_fees_cents - r.shipping_cost_cents - r.cost_cents) },
      { label: 'notes', value: (r) => r.notes },
    ]));
  });

  app.get('/api/export/expenses.csv', auth, ownerOnly, (req, res) => {
    const { from, to } = range(req.query);
    const rows = db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date').all(from, to);
    sendCsv(res, `expenses-${from}-to-${to}.csv`, csv(rows, [
      { label: 'date', value: (r) => r.expense_date },
      { label: 'category', value: (r) => r.category },
      { label: 'vendor', value: (r) => r.vendor },
      { label: 'amount', value: (r) => dollars(r.amount_cents) },
      { label: 'notes', value: (r) => r.notes },
    ]));
  });

  // ---- static + errors ----------------------------------------------------

  app.use('/api', (req, res, next) => next(new ApiError(404, 'Not found')));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });

  return app;
}
