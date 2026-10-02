import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import {
  importExpenses, importInventory, importSales, parseCsv, parseDate, parseMoney, parseSheetUrl, syncAll,
} from '../server/sheets.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const url = (gid) => `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=${gid}`;

const INVENTORY = `Item #,Book Title,Author,Qty,Cost,Asking Price,Shelf,eBay,Whatnot,Amazon ASIN,Status,Random
ARB-1,"Dune, First Edition",Frank Herbert,1,$12.50,"$1,200.00",A1,123456789,,B000TEST,,x
ARB-2,The Hobbit,Tolkien,2,4,25,A2,yes,yes,,,
,Untitled Pamphlet,,,,5,,,,,,
,,,,,,,,,,,
ARB-4,,Nobody,1,1,1,,,,,,
ARB-5,Beloved,Toni Morrison,,8,40,B1,,,,Sold,
`;
const SALES = `Date,Platform,SKU,Title,Sold For,Shipping Charged,Fees,Postage,Order #
9/28/2026,eBay,ARB-1,,"$1,150.00",$5.00,$152.38,$8.10,11-2233
2026-09-29,whatnot,,The Hobbit,22,,2.10,4.50,
"Sep 30, 2026",In person,,Garage find,10,,,,
not a date,eBay,,Bad row,10,,,,
`;
const EXPENSES = `Date,Category,Vendor,Amount,Notes
9/27/26,Postage,USPS,$42.10,Labels
09/28/2026,Inventory purchases,Estate sale,(150.00),Box lot
9/29/2026,,Uline,25,
`;

test('parses sheet links, money, dates and CSV', () => {
  assert.deepEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=42`), { id: ID, gid: '42', url: url(42) });
  assert.equal(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`).gid, '0');
  assert.equal(parseSheetUrl(''), null);
  assert.throws(() => parseSheetUrl('https://example.com/nope'));
  assert.equal(parseMoney('$1,234.56'), 123456);
  assert.equal(parseMoney('(10.00)'), -1000);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseDate('9/28/2026'), '2026-09-28');
  assert.equal(parseDate('9/28/26'), '2026-09-28');
  assert.equal(parseDate('2026-09-28'), '2026-09-28');
  assert.equal(parseDate('Sep 28, 2026'), '2026-09-28');
  assert.equal(parseDate('Monday, September 28, 2026'), '2026-09-28');
  assert.equal(parseDate('28-Sep-2026'), '2026-09-28');
  assert.equal(parseDate('46293'), '2026-09-28');
  assert.throws(() => parseDate('2/30/2026'));
  assert.deepEqual(parseCsv('a,"b ""q"", c"\r\n1,2\n'), [['a', 'b "q", c'], ['1', '2']]);
});

test('imports inventory with flexible headers and skips bad rows', () => {
  const db = openDb(':memory:');
  const r = importInventory(db, parseCsv(INVENTORY));
  assert.equal(r.imported, 4);
  assert.deepEqual(r.skipped, [{ row: 6, reason: 'no title' }]);
  assert.ok(r.ignored.includes('Random'));
  const dune = db.prepare(`SELECT * FROM books WHERE sku = 'ARB-1'`).get();
  assert.equal(dune.title, 'Dune, First Edition');
  assert.equal(dune.cost_cents, 1250);
  assert.equal(dune.list_price_cents, 120000);
  assert.equal(dune.ebay_listed, 1);
  assert.equal(dune.ebay_ref, '123456789');
  assert.equal(dune.amazon_ref, 'B000TEST');
  assert.equal(dune.whatnot_listed, 0);
  assert.equal(dune.origin, 'sheet');
  const hobbit = db.prepare(`SELECT * FROM books WHERE sku = 'ARB-2'`).get();
  assert.equal(hobbit.ebay_ref, '');
  assert.equal(hobbit.whatnot_listed, 1);
  assert.equal(db.prepare(`SELECT quantity FROM books WHERE sku = 'ARB-5'`).get().quantity, 0);
  assert.match(db.prepare(`SELECT sku FROM books WHERE title = 'Untitled Pamphlet'`).get().sku, /^SHEET-[0-9A-F]{8}$/);

  // Re-sync keeps ids stable, and books removed from the sheet go away.
  const id = dune.id;
  const again = importInventory(db, parseCsv(INVENTORY.split('\n').filter((l) => !l.startsWith('ARB-2')).join('\n')));
  assert.equal(again.removed, 1);
  assert.equal(db.prepare(`SELECT id FROM books WHERE sku = 'ARB-1'`).get().id, id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM books WHERE sku = 'ARB-2'`).get().n, 0);
});

test('imports sales, matching books by SKU or title for cost', () => {
  const db = openDb(':memory:');
  importInventory(db, parseCsv(INVENTORY));
  const r = importSales(db, parseCsv(SALES));
  assert.equal(r.imported, 3);
  assert.equal(r.skipped[0].row, 5);
  const [a, b, c] = db.prepare('SELECT * FROM sales ORDER BY sale_date').all();
  assert.equal(a.channel, 'ebay');
  assert.equal(a.title, 'Dune, First Edition');
  assert.equal(a.sale_price_cents, 115000);
  assert.equal(a.shipping_charged_cents, 500);
  assert.equal(a.platform_fees_cents, 15238);
  assert.equal(a.shipping_cost_cents, 810);
  assert.equal(a.cost_cents, 1250);
  assert.equal(a.order_ref, '11-2233');
  assert.equal(b.channel, 'whatnot');
  assert.equal(b.cost_cents, 400); // matched "The Hobbit" by title
  assert.equal(c.channel, 'other');
  assert.equal(c.book_id, null);
  // A second sync replaces rather than duplicates.
  importSales(db, parseCsv(SALES));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 3);
});

test('imports expenses', () => {
  const db = openDb(':memory:');
  const r = importExpenses(db, parseCsv(EXPENSES));
  assert.equal(r.imported, 3);
  const rows = db.prepare('SELECT * FROM expenses ORDER BY expense_date').all();
  assert.deepEqual(rows.map((e) => e.amount_cents), [4210, 15000, 2500]);
  assert.equal(rows[2].category, 'Other');
});

test('a tab without the required column reports which headers it saw', () => {
  const db = openDb(':memory:');
  assert.throws(() => importExpenses(db, parseCsv('When,What\n1/1/2026,x\n')), /"Amount".*Headers found: When, What/);
});

function csvResponse(body, ok = true) {
  return new Response(body, { status: ok ? 200 : 401, headers: { 'content-type': ok ? 'text/csv' : 'text/html' } });
}

test('syncs over link sharing, keeping other tabs when one fails', async () => {
  const db = openDb(':memory:');
  const tabs = { 1: INVENTORY, 2: SALES };
  const fetchImpl = async (u) => {
    const gid = /gid=(\d+)/.exec(u)[1];
    return tabs[gid] ? csvResponse(tabs[gid]) : csvResponse('<html>sign in</html>', false);
  };
  const r = await syncAll(db, { inventory: url(1), sales: url(2), expenses: url(3) }, { fetchImpl, sa: null });
  assert.equal(r.ok, false);
  assert.equal(r.sections.inventory.imported, 4);
  assert.equal(r.sections.sales.imported, 3);
  assert.match(r.sections.expenses.error, /Anyone with the link/);
});

test('syncs privately with a service account', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'shop@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const fetchImpl = async (u, opts = {}) => {
    calls.push(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const jwt = new URLSearchParams(String(opts.body)).get('assertion').split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url')));
      assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets');
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    if (u.includes('?fields=')) return Response.json({ sheets: [{ properties: { sheetId: 7, title: "Bob's Expenses" } }] });
    assert.match(u, /values\/'Bob''s%20Expenses'|values\/%27Bob%27%27s%20Expenses%27/);
    return Response.json({ values: parseCsv(EXPENSES).filter((r) => r.length > 1) });
  };
  const db = openDb(':memory:');
  const r = await syncAll(db, { expenses: url(7) }, { fetchImpl, sa });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sections.expenses.imported, 3);
  const missing = await syncAll(db, { expenses: url(99) }, { fetchImpl, sa });
  assert.match(missing.sections.expenses.error, /tab no longer exists/);
  assert.ok(calls.filter((c) => c.includes('oauth2')).length === 1, 'token is cached');
});

test('API: link a sheet, sync, and block app edits to sheet rows', async () => {
  const fetchImpl = async (u) => csvResponse({ 1: INVENTORY, 2: SALES, 3: EXPENSES }[/gid=(\d+)/.exec(u)[1]]);
  const app = createApp(openDb(':memory:'), { fetchImpl, env: {} });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}/api`;
  let cookie = '';
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    return { status: res.status, data: await res.json() };
  };
  try {
    await call('/setup', 'POST', { name: 'O', username: 'o', password: 'password123' });
    assert.equal((await call('/sheets/sync', 'POST', {})).status, 400);
    assert.equal((await call('/sheets', 'PUT', { urls: { inventory: 'nope' } })).status, 400);
    const put = await call('/sheets', 'PUT', { urls: { inventory: url(1), sales: url(2), expenses: url(3) }, autoMinutes: 30 });
    assert.equal(put.status, 200);
    const sync = await call('/sheets/sync', 'POST', {});
    assert.equal(sync.data.ok, true);
    const status = (await call('/status')).data.sheets;
    assert.equal(status.inventory, true);
    assert.ok(status.lastSyncAt);

    const books = (await call('/books?status=all')).data.books;
    assert.equal(books.length, 4);
    assert.equal((await call(`/books/${books[0].id}`, 'PUT', { sku: 'Z', title: 'Z' })).status, 409);
    assert.equal((await call('/books', 'POST', { sku: 'NEW', title: 'New' })).status, 409);
    assert.equal((await call('/sales', 'POST', { channel: 'ebay', sale_date: '2026-09-30', title: 'x' })).status, 409);
    const exp = (await call('/expenses?from=2026-09-01&to=2026-09-30')).data.expenses;
    assert.equal((await call(`/expenses/${exp[0].id}`, 'DELETE', {})).status, 409);

    const dash = (await call('/dashboard?from=2026-09-27&to=2026-09-30')).data;
    assert.equal(dash.totals.gross_sales_cents, 115000 + 500 + 2200 + 1000);
    assert.equal(dash.totals.expenses_cents, 4210 + 15000 + 2500);

    const info = (await call('/sheets')).data;
    assert.deepEqual(info.appRows, { inventory: 0, sales: 0, expenses: 0 });

    // Unlinking a section lets the app manage it again; sheet rows stay but remain read-only.
    await call('/sheets', 'PUT', { urls: { expenses: '' } });
    assert.equal((await call('/expenses', 'POST', { expense_date: '2026-09-30', category: 'Other', amount_cents: 100 })).status, 201);
    assert.equal((await call('/sheets/clear-app', 'POST', { section: 'expenses' })).status, 400);
    await call('/sheets', 'PUT', { urls: { expenses: url(3) } });
    assert.equal((await call('/sheets')).data.appRows.expenses, 1);
    assert.equal((await call('/sheets/clear-app', 'POST', { section: 'expenses' })).data.deleted, 1);
  } finally {
    server.close();
  }
});
