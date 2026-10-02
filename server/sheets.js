// Reads inventory, sales and expenses from Google Sheets tabs into the database.
//
// Two ways to reach a sheet:
//  - Private (recommended): a Google service account. Set GOOGLE_SERVICE_ACCOUNT_FILE (path to
//    its JSON key) or GOOGLE_SERVICE_ACCOUNT_JSON, then share the sheet with the account's email.
//  - Link sharing: with no service account configured, the tab is downloaded as CSV, which only
//    works when the sheet is shared as "Anyone with the link can view".
//
// The sheet is the source of truth: rows imported from it are marked origin = 'sheet' and are
// replaced on every sync. Rows entered in the app (origin = 'app') are left alone.
// With two-way sync on (service account with Editor access), changes made in the app are
// marked sheet_dirty = 1 and written to the sheet first (see sheets-writer.js); a sync never
// overwrites a row that still has unsent changes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { tx } from './db.js';
import { isValidDate } from './payroll.js';

export const SECTIONS = ['inventory', 'sales', 'expenses'];

// ---- sheet URLs -----------------------------------------------------------------

/** Accepts a Google Sheets link (ideally copied while the tab is open, so it has #gid=…). */
export function parseSheetUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s)?.[1];
  if (!id) throw new Error('That doesn\'t look like a Google Sheets link');
  const gid = /[#?&]gid=(\d+)/.exec(s)?.[1] || '0';
  return { id, gid, url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}` };
}

// ---- fetching ----------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function serviceAccount(env = process.env) {
  try {
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || (env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    if (!raw) return null;
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) throw new Error('missing client_email or private_key');
    return sa;
  } catch (err) {
    return { error: `Google service account key couldn't be read: ${err.message}` };
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
let cachedToken = null;

export async function accessToken(sa, fetchImpl) {
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    // Full scope so two-way sync can write; access is still limited to sheets shared with the account.
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), sa.private_key));
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in for the service account failed: ${data.error_description || data.error || res.status}`);
  cachedToken = { email: sa.client_email, token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

/**
 * A connection to one tab through the Sheets API (service account only).
 * read() -> rows; writeCells([{ row, col, value }]) (1-based); deleteRows([rowNums]).
 */
export async function openTab(ref, { fetchImpl = fetch, sa }) {
  const token = await accessToken(sa, fetchImpl);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}`;
  const call = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 404) {
      const write = init.method === 'POST';
      throw new Error(write
        ? `The app can't edit the sheet. Share it with ${sa.client_email} as an Editor (not Viewer).`
        : `The sheet isn't shared with ${sa.client_email}. Open the sheet, click Share, and add that email.`);
    }
    if (!res.ok) throw new Error(`Google Sheets error: ${data.error?.message || res.status}`);
    return data;
  };
  const meta = await call(`${base}?fields=sheets.properties(sheetId,title)`);
  const tab = meta.sheets?.find((t) => String(t.properties.sheetId) === ref.gid);
  if (!tab) throw new Error('That tab no longer exists in the sheet (check the link\'s #gid=)');
  const quoted = `'${tab.properties.title.replace(/'/g, "''")}'`;
  return {
    title: tab.properties.title,
    async read() {
      const vals = await call(`${base}/values/${encodeURIComponent(quoted)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
      return (vals.values || []).map((r) => r.map((c) => String(c ?? '')));
    },
    async writeCells(cells) {
      if (!cells.length) return;
      await call(`${base}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: cells.map((c) => ({ range: `${quoted}!${columnLetter(c.col)}${c.row}`, values: [[c.value]] })),
        }),
      });
    },
    async deleteRows(rowNums) {
      if (!rowNums.length) return;
      const requests = [...new Set(rowNums)].sort((a, b) => b - a).map((r) => ({
        deleteDimension: { range: { sheetId: Number(ref.gid), dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
      }));
      await call(`${base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    },
  };
}

/** 1 -> A, 27 -> AA */
export function columnLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Returns the tab as an array of rows (arrays of strings). */
export async function fetchTab(ref, { fetchImpl = fetch, sa = serviceAccount() } = {}) {
  if (sa?.error) throw new Error(sa.error);
  if (sa) return (await openTab(ref, { fetchImpl, sa })).read();
  const res = await fetchImpl(`https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`, { redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('csv')) {
    throw new Error('Couldn\'t read the sheet. Either share it as "Anyone with the link can view", or set up a Google service account (see README).');
  }
  return parseCsv(await res.text());
}

// ---- cell parsing ---------------------------------------------------------------------

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseMoney(v) {
  let s = String(v ?? '').trim();
  if (!s || s === '-' || s === '—') return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`"${v}" isn't a dollar amount`);
  return Math.round(n * 100) * (neg ? -1 : 1);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const p2 = (n) => String(n).padStart(2, '0');

export function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let y; let m; let d; let r;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s))) [m, d, y] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(s))) [m, d, y] = [MONTHS.indexOf(r[1].toLowerCase()) + 1, +r[2], +r[3]];
  else if ((r = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*\.?[\s-](\d{2,4})/i.exec(s))) [d, m, y] = [+r[1], MONTHS.indexOf(r[2].toLowerCase()) + 1, +r[3]];
  else if (/^\d{5}(\.\d+)?$/.test(s)) { // spreadsheet serial number
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  }
  if (y !== undefined && y < 100) y += 2000;
  const out = y ? `${y}-${p2(m)}-${p2(d)}` : '';
  if (!isValidDate(out)) throw new Error(`"${s}" isn't a date`);
  return out;
}

function parseQty(v, fallback = 1) {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${v}" isn't a quantity`);
  return Math.round(n);
}

const NO = new Set(['', 'no', 'n', 'false', '0', '-', '—', 'none', 'not listed', 'unlisted', 'x no']);
const YES = new Set(['yes', 'y', 'true', 'x', '1', '✓', '✔', 'listed', 'active']);
function listing(v) {
  const s = String(v ?? '').trim();
  if (NO.has(s.toLowerCase())) return { listed: 0, ref: '' };
  return { listed: 1, ref: YES.has(s.toLowerCase()) ? '' : s.slice(0, 300) };
}

export function parseChannel(v) {
  const s = norm(v);
  if (s.includes('ebay')) return 'ebay';
  if (s.includes('whatnot')) return 'whatnot';
  if (s.includes('amazon') || s === 'amz' || s.includes('abebooks')) return 'amazon';
  return 'other';
}

// ---- column mapping ----------------------------------------------------------------------

export const COLUMNS = {
  inventory: {
    title: ['title', 'booktitle', 'book', 'itemtitle', 'name', 'item'],
    sku: ['sku', 'customlabel', 'itemnumber', 'itemno', 'itemid', 'stocknumber', 'inventorynumber', 'id', 'item'],
    author: ['author', 'authors', 'by'],
    isbn: ['isbn', 'isbn13', 'isbn10', 'upc', 'ean'],
    publisher: ['publisher', 'pub'],
    pub_year: ['year', 'pubyear', 'publicationyear', 'yearpublished', 'published'],
    edition: ['edition', 'printing', 'editionprinting', 'ed'],
    binding: ['binding', 'format', 'cover', 'type'],
    condition: ['condition', 'grade'],
    description: ['description', 'desc', 'details'],
    location: ['location', 'shelf', 'bin', 'box', 'storage', 'shelflocation'],
    quantity: ['quantity', 'qty', 'stock', 'onhand', 'qtyonhand', 'instock', 'count'],
    cost: ['cost', 'paid', 'purchaseprice', 'pricepaid', 'costbasis', 'buyprice', 'mycost', 'cogs'],
    list_price: ['listprice', 'price', 'askingprice', 'asking', 'listedprice', 'retailprice', 'sellprice', 'listingprice'],
    acquired_date: ['acquired', 'dateacquired', 'acquireddate', 'purchasedate', 'datepurchased', 'datebought', 'dateadded'],
    source: ['source', 'purchasedfrom', 'acquiredfrom', 'boughtfrom', 'from'],
    ebay: ['ebay', 'ebaylisting', 'ebayid', 'ebayitemnumber', 'ebayurl', 'ebaylink', 'onebay', 'listedonebay'],
    whatnot: ['whatnot', 'whatnotlisting', 'whatnotid', 'whatnoturl', 'onwhatnot', 'listedonwhatnot'],
    amazon: ['amazon', 'asin', 'amazonsku', 'amazonlisting', 'amazonurl', 'onamazon', 'listedonamazon'],
    listed_on: ['listedon', 'platforms', 'channels', 'listed', 'wherelisted', 'marketplaces'],
    status: ['status', 'sold'],
    notes: ['notes', 'note', 'comments', 'comment'],
  },
  sales: {
    sale_date: ['date', 'saledate', 'solddate', 'datesold', 'orderdate', 'datepaid'],
    channel: ['platform', 'channel', 'marketplace', 'soldon', 'site', 'venue', 'where', 'wheresold'],
    sku: ['sku', 'customlabel', 'itemnumber', 'itemno', 'itemid', 'id'],
    title: ['title', 'booktitle', 'book', 'item', 'itemtitle', 'description', 'name'],
    quantity: ['quantity', 'qty'],
    sale_price: ['saleprice', 'soldfor', 'soldprice', 'price', 'itemprice', 'salesprice', 'amount', 'sale', 'revenue', 'total', 'gross'],
    shipping_charged: ['shippingcharged', 'shippingpaidbybuyer', 'buyershipping', 'shippingincome', 'shippingcollected', 'shippingreceived'],
    platform_fees: ['fees', 'fee', 'platformfees', 'sellingfees', 'ebayfees', 'amazonfees', 'whatnotfees', 'finalvaluefee', 'commission', 'transactionfees'],
    shipping_cost: ['shippingcost', 'postage', 'postagecost', 'label', 'labelcost', 'shippinglabel', 'shipping'],
    cost: ['cost', 'cogs', 'costofgoods', 'bookcost', 'paid', 'purchaseprice', 'mycost'],
    order_ref: ['ordernumber', 'order', 'orderid', 'orderno', 'transactionid'],
    notes: ['notes', 'note', 'comments', 'comment', 'buyer'],
    app_id: ['appid', 'appkey', 'recordid'],
  },
  expenses: {
    expense_date: ['date', 'expensedate', 'datepaid', 'purchasedate', 'transactiondate'],
    category: ['category', 'type', 'expensetype', 'account'],
    vendor: ['vendor', 'payee', 'store', 'merchant', 'paidto', 'company', 'where', 'from'],
    amount: ['amount', 'total', 'cost', 'price', 'paid', 'amountpaid'],
    notes: ['notes', 'description', 'memo', 'item', 'details', 'for', 'note', 'comments'],
    app_id: ['appid', 'appkey', 'recordid'],
  },
};

/** Column headings the app writes into an empty tab (two-way sync). */
export const DEFAULT_HEADERS = {
  inventory: [['sku', 'SKU'], ['title', 'Title'], ['author', 'Author'], ['isbn', 'ISBN'], ['publisher', 'Publisher'], ['pub_year', 'Year'],
    ['edition', 'Edition'], ['binding', 'Binding'], ['condition', 'Condition'], ['location', 'Shelf'], ['quantity', 'Qty'], ['cost', 'Cost'],
    ['list_price', 'Price'], ['acquired_date', 'Acquired'], ['source', 'Source'], ['ebay', 'eBay'], ['whatnot', 'Whatnot'], ['amazon', 'Amazon'],
    ['status', 'Status'], ['description', 'Description'], ['notes', 'Notes']],
  sales: [['sale_date', 'Date'], ['channel', 'Platform'], ['sku', 'SKU'], ['title', 'Title'], ['quantity', 'Qty'], ['sale_price', 'Sale Price'],
    ['shipping_charged', 'Shipping Charged'], ['platform_fees', 'Fees'], ['shipping_cost', 'Postage'], ['cost', 'Cost'], ['order_ref', 'Order #'],
    ['notes', 'Notes'], ['app_id', 'App ID']],
  expenses: [['expense_date', 'Date'], ['category', 'Category'], ['vendor', 'Vendor'], ['amount', 'Amount'], ['notes', 'Notes'], ['app_id', 'App ID']],
};
const REQUIRED = { inventory: ['title'], sales: ['sale_date', 'sale_price'], expenses: ['expense_date', 'amount'] };
const LABELS = {
  title: 'Title', sale_date: 'Date', sale_price: 'Sale price', expense_date: 'Date', amount: 'Amount',
};

/** Finds the header row and maps our fields to column indexes. */
export function mapColumns(section, rows) {
  const headerIdx = rows.findIndex((r) => r.some((c) => String(c).trim()));
  if (headerIdx < 0) return { empty: true, headerIdx: -1, map: {}, matched: {}, ignored: [] };
  const headers = rows[headerIdx].map(norm);
  const used = new Set();
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMNS[section])) {
    for (const a of aliases.map(norm)) {
      const i = headers.findIndex((h, idx) => h === a && !used.has(idx));
      if (i >= 0) { map[field] = i; used.add(i); break; }
    }
  }
  // Second pass: a heading that merely mentions a platform ("Amazon ASIN", "eBay Item ID").
  for (const ch of ['ebay', 'whatnot', 'amazon']) {
    if (!(ch in COLUMNS[section]) || map[ch] !== undefined) continue;
    const i = headers.findIndex((h, idx) => h.includes(ch) && !used.has(idx));
    if (i >= 0) { map[ch] = i; used.add(i); }
  }
  const missing = REQUIRED[section].filter((f) => map[f] === undefined);
  if (missing.length) {
    throw new Error(`Couldn't find a ${missing.map((f) => `"${LABELS[f]}"`).join(' or ')} column in the header row. Headers found: ${rows[headerIdx].filter(Boolean).join(', ')}`);
  }
  return {
    headerIdx,
    map,
    matched: Object.fromEntries(Object.entries(map).map(([f, i]) => [f, rows[headerIdx][i]])),
    ignored: rows[headerIdx].filter((h, i) => String(h).trim() && !used.has(i)),
  };
}

function* dataRows(rows, headerIdx, map) {
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const get = (f) => (map[f] === undefined ? undefined : String(r[map[f]] ?? '').trim());
    yield { rowNum: i + 1, get };
  }
}

// ---- importers ----------------------------------------------------------------------------

const has = (v) => v !== undefined && v !== '';

export function importInventory(db, rows) {
  const { headerIdx, map, matched, ignored, empty } = mapColumns('inventory', rows);
  if (empty) return { imported: 0, removed: 0, skipped: [], matched, ignored, empty: true };
  const soldColumn = norm(matched.status) === 'sold'; // a yes/no "Sold" column rather than a status
  const skipped = [];
  const books = [];
  const seen = new Map();
  for (const { rowNum, get } of dataRows(rows, headerIdx, map)) {
    try {
      const title = get('title');
      if (!title) throw new Error('no title');
      const status = (get('status') || '').toLowerCase();
      const flags = {};
      for (const ch of ['ebay', 'whatnot', 'amazon']) flags[ch] = has(get(ch)) ? listing(get(ch)) : { listed: 0, ref: '' };
      const listedOn = norm(get('listed_on'));
      for (const ch of ['ebay', 'whatnot', 'amazon']) {
        if (listedOn.includes(ch) || (ch === 'amazon' && listedOn.includes('amz'))) flags[ch].listed = 1;
      }
      const sold = soldColumn ? YES.has(status) : /sold|gone/.test(status);
      let quantity = parseQty(get('quantity'), 1);
      if (!has(get('quantity')) && sold) quantity = 0;
      let sku = get('sku');
      if (!sku) {
        const base = `SHEET-${crypto.createHash('sha1').update([title, get('author'), get('isbn'), get('edition')].join('|').toLowerCase()).digest('hex').slice(0, 8).toUpperCase()}`;
        sku = base;
        for (let n = 2; seen.has(sku.toLowerCase()); n++) sku = `${base}-${n}`;
      }
      if (seen.has(sku.toLowerCase())) throw new Error(`SKU ${sku} is also on row ${seen.get(sku.toLowerCase())}`);
      seen.set(sku.toLowerCase(), rowNum);
      const acquired = get('acquired_date');
      books.push({
        sku: sku.slice(0, 60), title: title.slice(0, 300),
        author: get('author') || '', isbn: get('isbn') || '', publisher: get('publisher') || '', pub_year: get('pub_year') || '',
        edition: get('edition') || '', binding: get('binding') || '', condition: get('condition') || '', description: get('description') || '',
        location: get('location') || '', quantity, cost_cents: parseMoney(get('cost')), list_price_cents: parseMoney(get('list_price')),
        acquired_date: has(acquired) ? parseDate(acquired) : '', source: get('source') || '',
        ebay_listed: flags.ebay.listed, ebay_ref: flags.ebay.ref, whatnot_listed: flags.whatnot.listed, whatnot_ref: flags.whatnot.ref,
        amazon_listed: flags.amazon.listed, amazon_ref: flags.amazon.ref,
        archived: /archiv|remov|donat|discard/.test(status) ? 1 : 0, notes: get('notes') || '', sheet_row: rowNum,
      });
    } catch (err) {
      skipped.push({ row: rowNum, reason: err.message });
    }
  }

  const cols = Object.keys(books[0] || { sku: 1 });
  // On existing books, only overwrite what the sheet actually has a column for, so details kept
  // only in the app (photos aside: eBay listing IDs, shelf, etc.) survive a sync.
  const FIELD_COLUMNS = {
    author: 'author', isbn: 'isbn', publisher: 'publisher', pub_year: 'pub_year', edition: 'edition', binding: 'binding',
    condition: 'condition', description: 'description', location: 'location', cost_cents: 'cost', list_price_cents: 'list_price',
    acquired_date: 'acquired_date', source: 'source', notes: 'notes',
    ebay_listed: ['ebay', 'listed_on'], ebay_ref: 'ebay', whatnot_listed: ['whatnot', 'listed_on'], whatnot_ref: 'whatnot',
    amazon_listed: ['amazon', 'listed_on'], amazon_ref: 'amazon', quantity: ['quantity', 'status'], archived: 'status',
  };
  const present = (c) => {
    if (['sku', 'title', 'sheet_row'].includes(c)) return true;
    const f = FIELD_COLUMNS[c];
    return [].concat(f || []).some((x) => map[x] !== undefined);
  };
  const updCols = cols.filter(present);
  let removed = 0;
  tx(db, () => {
    const find = db.prepare('SELECT id, sheet_dirty FROM books WHERE sku = ?');
    const ins = db.prepare(`INSERT INTO books (${cols.join(',')}, origin) VALUES (${cols.map(() => '?').join(',')}, 'sheet')`);
    const upd = db.prepare(`UPDATE books SET ${updCols.map((c) => `${c} = ?`).join(', ')}, origin = 'sheet', updated_at = datetime('now') WHERE id = ?`);
    for (const b of books) {
      const existing = find.get(b.sku);
      if (existing?.sheet_dirty) continue; // has unsent app changes; the next push wins
      if (existing) upd.run(...updCols.map((c) => b[c]), existing.id);
      else ins.run(...cols.map((c) => b[c]));
    }
    // Books that were removed from the sheet: delete, or archive if sales point at them.
    const keep = new Set(books.map((b) => b.sku.toLowerCase()));
    for (const old of db.prepare(`SELECT id, sku FROM books WHERE origin = 'sheet' AND sheet_dirty = 0`).all()) {
      if (keep.has(old.sku.toLowerCase())) continue;
      const used = db.prepare('SELECT 1 FROM sales WHERE book_id = ? LIMIT 1').get(old.id);
      if (used) db.prepare(`UPDATE books SET archived = 1, quantity = 0, updated_at = datetime('now') WHERE id = ?`).run(old.id);
      else db.prepare('DELETE FROM books WHERE id = ?').run(old.id);
      removed++;
    }
  });
  return { imported: books.length, removed, skipped, matched, ignored };
}

export function importSales(db, rows) {
  const { headerIdx, map, matched, ignored, empty } = mapColumns('sales', rows);
  if (empty) return replaceRows(db, 'sales', [], { matched, ignored, empty });
  const skipped = [];
  const sales = [];
  const bySku = db.prepare('SELECT id, title, cost_cents FROM books WHERE sku = ?');
  const byTitle = db.prepare('SELECT id, title, cost_cents FROM books WHERE title = ? COLLATE NOCASE');
  for (const { rowNum, get } of dataRows(rows, headerIdx, map)) {
    try {
      const sale_date = parseDate(get('sale_date'));
      if (!sale_date) throw new Error('no date');
      let book = has(get('sku')) ? bySku.get(get('sku')) : null;
      if (!book && has(get('title'))) {
        const matches = byTitle.all(get('title'));
        if (matches.length === 1) [book] = matches;
      }
      const title = get('title') || book?.title || get('sku');
      if (!title) throw new Error('no title or SKU');
      const quantity = Math.max(1, parseQty(get('quantity'), 1));
      const cost = has(get('cost')) ? parseMoney(get('cost')) : (book ? book.cost_cents * quantity : 0);
      sales.push([book?.id ?? null, title.slice(0, 300), parseChannel(get('channel')), sale_date, quantity,
        parseMoney(get('sale_price')), parseMoney(get('shipping_charged')), Math.abs(parseMoney(get('platform_fees'))),
        Math.abs(parseMoney(get('shipping_cost'))), cost, (get('order_ref') || '').slice(0, 200), (get('notes') || '').slice(0, 2000), rowNum,
        (get('app_id') || '').slice(0, 40)]);
    } catch (err) {
      skipped.push({ row: rowNum, reason: err.message });
    }
  }
  return replaceRows(db, 'sales', sales, { skipped, matched, ignored });
}

const INSERT_SQL = {
  sales: `INSERT INTO sales (book_id, title, channel, sale_date, quantity, sale_price_cents, shipping_charged_cents,
    platform_fees_cents, shipping_cost_cents, cost_cents, order_ref, notes, sheet_row, sheet_key, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sheet')`,
  expenses: `INSERT INTO expenses (expense_date, category, vendor, amount_cents, notes, sheet_row, sheet_key, origin) VALUES (?,?,?,?,?,?,?,'sheet')`,
};

/**
 * Replaces the sheet-sourced rows of a table with what the sheet holds now. Rows with unsent
 * app changes (or pending deletes) are kept as they are, and the sheet's copy is skipped.
 */
function replaceRows(db, table, rows, info) {
  const keyIdx = table === 'sales' ? 13 : 6;
  tx(db, () => {
    const dirty = new Set(db.prepare(`SELECT sheet_key FROM ${table} WHERE sheet_dirty = 1 AND sheet_key != ''`).all().map((r) => r.sheet_key));
    for (const d of db.prepare(`SELECT key FROM sheet_deletes WHERE section = ?`).all(table)) dirty.add(d.key);
    db.prepare(`DELETE FROM ${table} WHERE origin = 'sheet' AND sheet_dirty = 0`).run();
    const ins = db.prepare(INSERT_SQL[table]);
    for (const r of rows) if (!(r[keyIdx] && dirty.has(r[keyIdx]))) ins.run(...r);
  });
  return { imported: rows.length, skipped: info.skipped || [], matched: info.matched, ignored: info.ignored, ...(info.empty && { empty: true }) };
}

export function importExpenses(db, rows) {
  const { headerIdx, map, matched, ignored, empty } = mapColumns('expenses', rows);
  if (empty) return replaceRows(db, 'expenses', [], { matched, ignored, empty });
  const skipped = [];
  const expenses = [];
  for (const { rowNum, get } of dataRows(rows, headerIdx, map)) {
    try {
      const date = parseDate(get('expense_date'));
      if (!date) throw new Error('no date');
      if (!has(get('amount'))) throw new Error('no amount');
      expenses.push([date, (get('category') || 'Other').slice(0, 100), (get('vendor') || '').slice(0, 200),
        Math.abs(parseMoney(get('amount'))), (get('notes') || '').slice(0, 2000), rowNum, (get('app_id') || '').slice(0, 40)]);
    } catch (err) {
      skipped.push({ row: rowNum, reason: err.message });
    }
  }
  return replaceRows(db, 'expenses', expenses, { skipped, matched, ignored });
}

const IMPORTERS = { inventory: importInventory, sales: importSales, expenses: importExpenses };

/**
 * Syncs every linked tab. Inventory goes first so sales can be matched to books by SKU.
 * One tab failing doesn't stop the others; its previously imported rows are kept.
 */
export async function syncAll(db, urls, opts = {}) {
  const result = { at: new Date().toISOString(), sections: {} };
  for (const section of SECTIONS) {
    if (!urls[section]) continue;
    try {
      const rows = await fetchTab(parseSheetUrl(urls[section]), opts);
      const r = IMPORTERS[section](db, rows);
      r.skipped = { count: r.skipped.length, rows: r.skipped.slice(0, 25) };
      result.sections[section] = { ok: true, ...r };
    } catch (err) {
      result.sections[section] = { ok: false, error: err.message };
    }
  }
  result.ok = Object.values(result.sections).every((s) => s.ok);
  return result;
}
