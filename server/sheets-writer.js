// Two-way sync: writes changes made in the app back to the linked Google Sheets tabs.
//
// Changed rows carry sheet_dirty > 0 (a counter, so a change made while a push is running is
// not lost). Rows deleted in the app are queued in sheet_deletes. A push finds each record's
// row by its key (SKU for books, the "App ID" column for sales and expenses), updates only the
// cells that changed, appends new rows, deletes removed ones, and adds missing key columns.
// Other columns, formatting and formulas in the sheet are left alone.
import crypto from 'node:crypto';
import { tx } from './db.js';
import {
  DEFAULT_HEADERS, mapColumns, openTab, parseDate, parseMoney, parseSheetUrl,
} from './sheets.js';

export const TABLE = { inventory: 'books', sales: 'sales', expenses: 'expenses' };
export const newKey = () => crypto.randomBytes(5).toString('hex');

const CHANNEL_LABEL = { ebay: 'eBay', whatnot: 'Whatnot', amazon: 'Amazon', other: 'In person' };
const dollars = (c) => ((c || 0) / 100).toFixed(2);
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_LABEL = Object.fromEntries(Object.entries(DEFAULT_HEADERS).map(([sec, cols]) => [sec, Object.fromEntries(cols)]));

/** Keeps user text as text: no formulas, and long digit strings (ISBNs, listing IDs) stay exact. */
function text(v) {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) || /^\d{8,}$/.test(s.replace(/[\s-]/g, '')) ? `'${s}` : s;
}

const MONEY = new Set(['cost', 'list_price', 'sale_price', 'shipping_charged', 'platform_fees', 'shipping_cost', 'amount']);
const DATES = new Set(['acquired_date', 'sale_date', 'expense_date']);

/** The value to write for each field of a record. */
function cellValues(section, r, ctx) {
  if (section === 'inventory') {
    const listed = (ch) => (r[`${ch}_listed`] ? (r[`${ch}_ref`] ? text(r[`${ch}_ref`]) : 'Yes') : '');
    return {
      sku: text(r.sku), title: text(r.title), author: text(r.author), isbn: text(r.isbn), publisher: text(r.publisher),
      pub_year: r.pub_year, edition: text(r.edition), binding: text(r.binding), condition: text(r.condition),
      description: text(r.description), location: text(r.location), quantity: r.quantity, cost: dollars(r.cost_cents),
      list_price: dollars(r.list_price_cents), acquired_date: r.acquired_date, source: text(r.source),
      ebay: listed('ebay'), whatnot: listed('whatnot'), amazon: listed('amazon'),
      listed_on: ['ebay', 'whatnot', 'amazon'].filter((ch) => r[`${ch}_listed`]).map((ch) => CHANNEL_LABEL[ch]).join(', '),
      status: ctx.soldColumn ? (r.quantity === 0 ? 'Yes' : 'No') : r.archived ? 'Archived' : r.quantity === 0 ? 'Sold' : 'In stock',
      notes: text(r.notes),
    };
  }
  if (section === 'sales') {
    return {
      sale_date: r.sale_date, channel: CHANNEL_LABEL[r.channel], sku: text(ctx.skuOf(r.book_id)), title: text(r.title), quantity: r.quantity,
      sale_price: dollars(r.sale_price_cents), shipping_charged: dollars(r.shipping_charged_cents), platform_fees: dollars(r.platform_fees_cents),
      shipping_cost: dollars(r.shipping_cost_cents), cost: dollars(r.cost_cents), order_ref: text(r.order_ref), notes: text(r.notes), app_id: r.sheet_key,
    };
  }
  return {
    expense_date: r.expense_date, category: text(r.category), vendor: text(r.vendor), amount: dollars(r.amount_cents), notes: text(r.notes), app_id: r.sheet_key,
  };
}

/** True when the sheet cell already shows this value (so it isn't rewritten). */
function same(field, current, next) {
  const cur = String(current ?? '').trim();
  const nxt = String(next ?? '').replace(/^'/, '').trim();
  try {
    if (MONEY.has(field)) return parseMoney(cur) === parseMoney(nxt);
    if (DATES.has(field)) return (cur ? parseDate(cur) : '') === nxt;
  } catch { return false; }
  return cur === nxt;
}

/** Writes one section's pending changes to its tab. */
async function pushSection(db, section, url, opts) {
  const table = TABLE[section];
  const dirty = db.prepare(`SELECT * FROM ${table} WHERE sheet_dirty > 0`).all();
  const deletes = db.prepare('SELECT * FROM sheet_deletes WHERE section = ?').all(table);
  if (!dirty.length && !deletes.length) return { written: 0, appended: 0, deleted: 0 };

  const tab = await openTab(parseSheetUrl(url), opts);
  let rows = await tab.read();
  const cells = [];
  let m = mapColumns(section, rows);
  if (m.empty) {
    // Brand-new tab: write the column headings first.
    const headers = DEFAULT_HEADERS[section].map(([, label]) => label);
    headers.forEach((h, i) => cells.push({ row: 1, col: i + 1, value: h }));
    rows = [headers];
    m = mapColumns(section, rows);
  }
  const { map, headerIdx, matched } = m;
  const headerRow = headerIdx + 1;
  let width = rows[headerIdx].length;

  // Make sure the key column (and a couple of columns the app depends on) exists.
  const needed = section === 'inventory'
    ? ['sku', 'quantity', ...(dirty.some((b) => b.ebay_listed) && map.listed_on === undefined ? ['ebay'] : [])]
    : ['app_id'];
  for (const f of needed) {
    if (map[f] !== undefined) continue;
    map[f] = width++;
    cells.push({ row: headerRow, col: map[f] + 1, value: HEADER_LABEL[section][f] });
  }

  const keyField = section === 'inventory' ? 'sku' : 'app_id';
  const keyCol = map[keyField];
  const index = new Map();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const k = String(rows[i][keyCol] ?? '').trim().toLowerCase();
    if (k && !index.has(k)) index.set(k, i + 1);
  }
  const cell = (rowNum, f) => (map[f] === undefined ? '' : rows[rowNum - 1]?.[map[f]] ?? '');
  // A row imported before it had a key: trust its remembered row number only if it still looks like the same record.
  const looksLike = (rowNum, check) => {
    if (!rowNum || rowNum <= headerRow || rowNum > rows.length || String(cell(rowNum, keyField)).trim()) return false;
    if (section === 'inventory') return norm(cell(rowNum, 'title')) === norm(check);
    try { return parseDate(cell(rowNum, section === 'sales' ? 'sale_date' : 'expense_date')) === check; } catch { return false; }
  };

  const books = new Map(db.prepare('SELECT id, sku FROM books').all().map((b) => [b.id, b.sku]));
  const ctx = { soldColumn: norm(matched.status) === 'sold', skuOf: (id) => books.get(id) || '' };
  let next = rows.length + 1;
  const done = [];
  let appended = 0;
  for (const r of dirty) {
    if (section !== 'inventory' && !r.sheet_key) {
      r.sheet_key = newKey();
      db.prepare(`UPDATE ${table} SET sheet_key = ? WHERE id = ?`).run(r.sheet_key, r.id);
    }
    const key = (section === 'inventory' ? r.sku : r.sheet_key).toLowerCase();
    const check = section === 'inventory' ? r.title : r.sale_date || r.expense_date;
    let rowNum = index.get(key) || (r.origin === 'sheet' && looksLike(r.sheet_row, check) ? r.sheet_row : 0);
    const values = cellValues(section, r, ctx);
    if (rowNum) {
      for (const [f, col] of Object.entries(map)) {
        if (f in values && !same(f, cell(rowNum, f), values[f])) cells.push({ row: rowNum, col: col + 1, value: values[f] });
      }
    } else {
      rowNum = next++;
      appended++;
      for (const [f, col] of Object.entries(map)) if (f in values && values[f] !== '') cells.push({ row: rowNum, col: col + 1, value: values[f] });
    }
    index.set(key, rowNum);
    done.push({ id: r.id, version: r.sheet_dirty, rowNum });
  }

  const toDelete = [];
  for (const d of deletes) {
    const rowNum = index.get(d.key.toLowerCase()) || (looksLike(d.sheet_row, d.check_text) ? d.sheet_row : 0);
    if (rowNum) toDelete.push(rowNum);
  }

  await tab.writeCells(cells);
  await tab.deleteRows(toDelete);

  tx(db, () => {
    const clear = db.prepare(`UPDATE ${table} SET sheet_dirty = 0, origin = 'sheet', sheet_row = ? WHERE id = ? AND sheet_dirty = ?`);
    for (const d of done) clear.run(d.rowNum, d.id, d.version);
    const del = db.prepare('DELETE FROM sheet_deletes WHERE id = ?');
    for (const d of deletes) del.run(d.id);
  });
  return { written: done.length - appended, appended, deleted: toDelete.length };
}

/** Pushes every linked section; one failing section doesn't stop the others. */
export async function pushAll(db, urls, opts) {
  const result = { at: new Date().toISOString(), sections: {} };
  for (const section of Object.keys(TABLE)) {
    if (!urls[section]) continue;
    try {
      result.sections[section] = { ok: true, ...(await pushSection(db, section, urls[section], opts)) };
    } catch (err) {
      result.sections[section] = { ok: false, error: err.message };
    }
  }
  result.ok = Object.values(result.sections).every((s) => s.ok);
  return result;
}

/** How many app changes are waiting to be written, per section. */
export function pendingCounts(db) {
  const out = {};
  for (const [section, table] of Object.entries(TABLE)) {
    out[section] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sheet_dirty > 0`).get().n
      + db.prepare('SELECT COUNT(*) AS n FROM sheet_deletes WHERE section = ?').get(table).n;
  }
  return out;
}
