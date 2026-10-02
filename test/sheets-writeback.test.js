import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { importInventory, parseCsv } from '../server/sheets.js';
import { columnLetter } from '../server/sheets.js';

const ID = '1WriteBackSheetIdForTests0123456789';
const url = (gid) => `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=${gid}`;

/** In-memory Google Sheets: tabs by gid, each a grid of strings. Implements the calls the app makes. */
const tabs = {
  1: { title: 'Inventory', rows: [['Title', 'Author', 'Qty', 'Price', 'My notes'], ['Dune', 'Frank Herbert', '1', '$45.00', 'keep me'], ['Beloved', 'Toni Morrison', '2', '$20.00', '']] },
  2: { title: 'Sales', rows: [] },
  3: { title: "Bob's Expenses", rows: [['Date', 'Category', 'Amount'], ['9/27/2026', 'Postage', '$12.00']] },
};
const writes = [];
const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
function setCell(grid, row, col, value) {
  while (grid.length < row) grid.push([]);
  const r = grid[row - 1];
  while (r.length < col) r.push('');
  r[col - 1] = String(value).replace(/^'/, ''); // USER_ENTERED: a leading apostrophe means "text"
}
const trimmed = (grid) => {
  const rows = grid.map((r) => { const c = [...r]; while (c.length && c.at(-1) === '') c.pop(); return c; });
  while (rows.length && !rows.at(-1).length) rows.pop();
  return rows;
};
async function sheetsFetch(u, opts = {}) {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') return json({ access_token: 'tok', expires_in: 3600 });
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  const { pathname, search } = new URL(u);
  const base = `/v4/spreadsheets/${ID}`;
  if (pathname === base && search.startsWith('?fields=')) {
    return json({ sheets: Object.entries(tabs).map(([gid, t]) => ({ properties: { sheetId: Number(gid), title: t.title } })) });
  }
  if (pathname.startsWith(`${base}/values/`) && !opts.method) {
    const title = decodeURIComponent(pathname.slice(`${base}/values/`.length)).replace(/^'|'$/g, '').replace(/''/g, "'");
    const tab = Object.values(tabs).find((t) => t.title === title);
    return json({ values: trimmed(tab.rows) });
  }
  if (pathname === `${base}/values:batchUpdate`) {
    const body = JSON.parse(opts.body);
    assert.equal(body.valueInputOption, 'USER_ENTERED');
    for (const d of body.data) {
      writes.push(d);
      const m = /^'(.+)'!([A-Z]+)(\d+)$/.exec(d.range);
      const tab = Object.values(tabs).find((t) => t.title === m[1].replace(/''/g, "'"));
      setCell(tab.rows, Number(m[3]), colIndex(m[2]), d.values[0][0]);
    }
    return json({});
  }
  if (pathname === `${base}:batchUpdate`) {
    for (const r of JSON.parse(opts.body).requests) {
      const { sheetId, startIndex, endIndex } = r.deleteDimension.range;
      tabs[sheetId].rows.splice(startIndex, endIndex - startIndex);
    }
    return json({});
  }
  return json({ error: { message: `unexpected ${opts.method || 'GET'} ${u}` } }, 400);
}

let server;
let base;
let cookie = '';
let app;
let photosDir;
async function call(p, method = 'GET', body) {
  const res = await fetch(base + p, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
  return { status: res.status, data: await res.json() };
}
const header = (gid) => tabs[gid].rows[0];
const col = (gid, name) => header(gid).indexOf(name);
const findRow = (gid, colName, value) => tabs[gid].rows.find((r) => r[col(gid, colName)] === value);
const sync = async () => {
  const r = await call('/api/sheets/sync', 'POST', {});
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  return r.data;
};

before(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'books@shop.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  app = createApp(openDb(':memory:'), { fetchImpl: sheetsFetch, env: { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, photosDir });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  await call('/api/setup', 'POST', { name: 'Owner', username: 'owner', password: 'password123' });
  const put = await call('/api/sheets', 'PUT', { urls: { inventory: url(1), sales: url(2), expenses: url(3) }, writeBack: true });
  assert.equal(put.data.sheets.writeBack, true);
  await sync();
});
after(() => { server.close(); fs.rmSync(photosDir, { recursive: true, force: true }); });

test('column letters', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
  assert.equal(columnLetter(53), 'BA');
});

test('editing a book in the app updates only the changed cells and adds a SKU column', async () => {
  const dune = (await call('/api/books?status=all')).data.books.find((b) => b.title === 'Dune');
  writes.length = 0;
  await call(`/api/books/${dune.id}`, 'PUT', { ...dune, list_price_cents: 5500, location: 'Shelf A1' });
  await sync();
  assert.equal(header(1).at(-1), 'SKU');
  const row = findRow(1, 'Title', 'Dune');
  assert.equal(row[col(1, 'Price')], '55.00');
  assert.equal(row[col(1, 'My notes')], 'keep me');
  assert.equal(row[col(1, 'SKU')], dune.sku);
  assert.ok(!writes.some((w) => /!B2$/.test(w.range)), 'unchanged Author cell is not rewritten');
  // The next pull keys the book by its SKU and keeps the shelf, which the sheet has no column for.
  const after1 = (await call(`/api/books/${dune.id}`)).data.book;
  assert.equal(after1.location, 'Shelf A1');
  assert.equal(after1.list_price_cents, 5500);
  assert.equal(after1.sheet_dirty, 0);
});

let newBookId;
test('a book added in the app is appended to the sheet', async () => {
  const r = await call('/api/books', 'POST', { sku: 'ARB-00100', title: '=HYPERLINK("http://x","click")', author: 'Anon', quantity: 1, list_price_cents: 1000, isbn: '9780441013593' });
  assert.equal(r.status, 201);
  newBookId = r.data.book.id;
  await sync();
  const row = findRow(1, 'SKU', 'ARB-00100');
  assert.ok(row);
  assert.equal(row[col(1, 'Title')], '=HYPERLINK("http://x","click")');
  assert.ok(writes.some((w) => w.values[0][0] === `'=HYPERLINK("http://x","click")`), 'formulas are written as text');
  assert.equal((await call(`/api/books/${newBookId}`)).data.book.origin, 'sheet');
});

test('recording a sale writes the sale (into a blank tab) and the new stock count', async () => {
  const r = await call('/api/sales', 'POST', { book_id: newBookId, channel: 'ebay', sale_date: '2026-09-30', sale_price_cents: 2500, platform_fees_cents: 330 });
  assert.equal(r.status, 201);
  await sync();
  assert.deepEqual(header(2).slice(0, 4), ['Date', 'Platform', 'SKU', 'Title']);
  const sale = tabs[2].rows[1];
  assert.equal(sale[col(2, 'Platform')], 'eBay');
  assert.equal(sale[col(2, 'SKU')], 'ARB-00100');
  assert.equal(sale[col(2, 'Sale Price')], '25.00');
  assert.match(sale[col(2, 'App ID')], /^[0-9a-f]{10}$/);
  assert.equal(findRow(1, 'SKU', 'ARB-00100')[col(1, 'Qty')], '0');
  // Pulled back with the same App ID, so there's exactly one copy.
  const sales = (await call('/api/sales?from=2026-09-01&to=2026-10-31')).data.sales;
  assert.equal(sales.length, 1);
  assert.equal(sales[0].sheet_key, sale[col(2, 'App ID')]);
});

test('expenses: add, edit and delete flow to the sheet (tab names with quotes work)', async () => {
  const add = await call('/api/expenses', 'POST', { expense_date: '2026-09-29', category: 'Supplies', amount_cents: 1999 });
  assert.equal(add.status, 201);
  await sync();
  assert.equal(header(3).at(-1), 'App ID');
  assert.equal(tabs[3].rows.length, 3);
  const exps = (await call('/api/expenses?from=2026-09-01&to=2026-10-31')).data.expenses;
  const original = exps.find((e) => e.category === 'Postage');
  await call(`/api/expenses/${original.id}`, 'PUT', { ...original, amount_cents: 1500 });
  await sync();
  assert.equal(findRow(3, 'Category', 'Postage')[col(3, 'Amount')], '15.00');
  const postage = (await call('/api/expenses?from=2026-09-01&to=2026-10-31')).data.expenses.find((e) => e.category === 'Postage');
  assert.equal((await call(`/api/expenses/${postage.id}`, 'DELETE', {})).status, 200);
  await sync();
  assert.equal(findRow(3, 'Category', 'Postage'), undefined);
  assert.ok(findRow(3, 'Category', 'Supplies'));
});

test('changes made in the sheet still flow into the app', async () => {
  const row = findRow(1, 'Title', 'Beloved');
  row[col(1, 'Qty')] = '5';
  await sync();
  const beloved = (await call('/api/books?status=all')).data.books.find((b) => b.title === 'Beloved');
  assert.equal(beloved.quantity, 5);
});

test('a sync never overwrites a book with unsent app changes', () => {
  const db = openDb(':memory:');
  importInventory(db, parseCsv('SKU,Title,Qty\nA1,Book,1\n'));
  db.prepare(`UPDATE books SET quantity = 7, sheet_dirty = 1 WHERE sku = 'A1'`).run();
  importInventory(db, parseCsv('SKU,Title,Qty\nA1,Book,3\n'));
  assert.equal(db.prepare(`SELECT quantity FROM books WHERE sku = 'A1'`).get().quantity, 7);
  importInventory(db, parseCsv('SKU,Title,Qty\n'));
  assert.ok(db.prepare(`SELECT 1 FROM books WHERE sku = 'A1'`).get(), 'dirty book is not removed');
});

test('copying app-entered records into a linked sheet', async () => {
  await call('/api/sheets', 'PUT', { urls: { expenses: '' } });
  await call('/api/expenses', 'POST', { expense_date: '2026-09-15', category: 'Marketing', amount_cents: 500 });
  await call('/api/sheets', 'PUT', { urls: { expenses: url(3) } });
  assert.equal((await call('/api/sheets')).data.appRows.expenses, 1);
  const r = await call('/api/sheets/export', 'POST', { section: 'expenses' });
  assert.equal(r.data.queued, 1);
  assert.ok(findRow(3, 'Category', 'Marketing'));
  assert.equal((await call('/api/sheets')).data.appRows.expenses, 0);
});

test('two-way sync needs a service account', async () => {
  const plain = createApp(openDb(':memory:'), { fetchImpl: sheetsFetch, env: {}, photosDir });
  const s2 = plain.listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = `http://localhost:${s2.address().port}`;
  let c2 = '';
  const go = async (p, method, body) => {
    const res = await fetch(b2 + p, { method, headers: { cookie: c2, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    c2 = res.headers.get('set-cookie')?.split(';')[0] || c2;
    return res.status;
  };
  await go('/api/setup', 'POST', { name: 'O', username: 'o', password: 'password123' });
  assert.equal(await go('/api/sheets', 'PUT', { writeBack: true }), 400);
  s2.close();
});
