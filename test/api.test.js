import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { computePay, weekStartOf } from '../server/payroll.js';

let server;
let base;

before(async () => {
  const app = createApp(openDb(':memory:'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie && { cookie }), ...(method !== 'GET' && { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const owner = client();
const emp = client();
let bookId;
let empId;

test('first run creates the owner, and only once', async () => {
  assert.equal((await owner('/status')).data.needsSetup, true);
  const r = await owner('/setup', { method: 'POST', body: { name: 'Alicea', username: 'alicea', password: 'password123' } });
  assert.equal(r.status, 201);
  const again = await client()('/setup', { method: 'POST', body: { name: 'X', username: 'x', password: 'password123' } });
  assert.equal(again.status, 409);
  assert.equal((await owner('/status')).data.user.role, 'owner');
});

test('owner adds an employee who can sign in but not see owner pages', async () => {
  const r = await owner('/users', { method: 'POST', body: { name: 'Jo', username: 'jo', password: 'password123', hourly_rate_cents: 2000 } });
  assert.equal(r.status, 201);
  empId = r.data.id;
  assert.equal((await emp('/login', { method: 'POST', body: { username: 'jo', password: 'nope' } })).status, 401);
  assert.equal((await emp('/login', { method: 'POST', body: { username: 'JO', password: 'password123' } })).status, 200);
  assert.equal((await emp('/dashboard')).status, 403);
  assert.equal((await emp('/sales')).status, 403);
  assert.equal((await emp('/users')).status, 403);
  assert.equal((await client()('/books')).status, 401);
});

test('non-JSON writes are rejected', async () => {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
  assert.equal(res.status, 415);
});

test('inventory: add, search, unique SKU', async () => {
  const sku = (await emp('/books/next-sku')).data.sku;
  assert.equal(sku, 'ARB-00001');
  const r = await emp('/books', { method: 'POST', body: { sku, title: 'Dune', author: 'Frank Herbert', quantity: 2, cost_cents: 1000, list_price_cents: 4500, ebay_listed: true, amazon_listed: true } });
  assert.equal(r.status, 201);
  bookId = r.data.book.id;
  assert.equal((await emp('/books', { method: 'POST', body: { sku: 'arb-00001', title: 'Dup' } })).status, 409);
  assert.equal((await emp('/books', { method: 'POST', body: { sku: 'X1', title: '' } })).status, 400);
  const found = await emp('/books?q=herbert');
  assert.equal(found.data.books.length, 1);
  assert.equal((await emp('/books?channel=whatnot')).data.books.length, 0);
});

test('sales decrement stock, flag stale listings, and restock on delete', async () => {
  const s1 = await emp('/sales', { method: 'POST', body: { book_id: bookId, channel: 'ebay', sale_date: '2026-09-28', sale_price_cents: 4500, shipping_charged_cents: 500, platform_fees_cents: 660, shipping_cost_cents: 450 } });
  assert.equal(s1.status, 201);
  assert.deepEqual(s1.data.stillListed, []);
  assert.equal(s1.data.sale.cost_cents, 1000);
  const tooMany = await emp('/sales', { method: 'POST', body: { book_id: bookId, channel: 'amazon', sale_date: '2026-09-29', quantity: 5, sale_price_cents: 1 } });
  assert.equal(tooMany.status, 400);
  const s2 = await emp('/sales', { method: 'POST', body: { book_id: bookId, channel: 'whatnot', sale_date: '2026-09-29', sale_price_cents: 4000 } });
  assert.deepEqual(s2.data.stillListed, ['ebay', 'amazon']);
  assert.equal((await emp('/books?status=stale')).data.books.length, 1);
  assert.equal((await emp(`/sales/${s2.data.sale.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await owner(`/sales/${s2.data.sale.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await owner(`/books/${bookId}`)).data.book.quantity, 1);
  const bad = await owner('/sales', { method: 'POST', body: { channel: 'etsy', sale_date: '2026-09-29', title: 'x' } });
  assert.equal(bad.status, 400);
});

test('deleting a book with sales archives it instead', async () => {
  const r = await owner(`/books/${bookId}`, { method: 'DELETE' });
  assert.deepEqual(r.data, { archived: true });
});

test('clock in / out and owner edits', async () => {
  assert.equal((await emp('/time/clock-in', { method: 'POST' })).status, 201);
  assert.equal((await emp('/time/clock-in', { method: 'POST' })).status, 409);
  assert.ok((await emp('/time/me')).data.open);
  assert.equal((await emp('/time/clock-out', { method: 'POST', body: { break_minutes: 0 } })).status, 200);
  assert.equal((await emp('/time/clock-out', { method: 'POST' })).status, 409);
  assert.equal((await emp('/time/entries', { method: 'POST', body: { user_id: empId, clock_in: '2026-09-28T09:00', clock_out: '2026-09-28T17:00' } })).status, 403);
  const add = await owner('/time/entries', { method: 'POST', body: { user_id: empId, clock_in: '2026-09-28T09:00', clock_out: '2026-09-28T17:30', break_minutes: 30 } });
  assert.equal(add.status, 201);
  assert.equal(add.data.entry.hourly_rate_cents, 2000);
  const backwards = await owner('/time/entries', { method: 'POST', body: { user_id: empId, clock_in: '2026-09-28T09:00', clock_out: '2026-09-28T08:00' } });
  assert.equal(backwards.status, 400);
  const own = await emp('/time/entries?from=2026-09-01&to=2026-12-31');
  assert.ok(own.data.entries.every((e) => e.user_id === empId));
});

test('payroll for a week includes hours, rate and pay', async () => {
  const p = await owner('/payroll?week=2026-09-30');
  assert.equal(p.data.from, '2026-09-28'); // Monday
  const jo = p.data.rows.find((r) => r.name === 'Jo');
  assert.ok(jo.total_hours >= 8);
  assert.equal(jo.days['2026-09-28'], 8);
  assert.ok(jo.gross_cents >= 16000);
  const csv = await owner('/payroll.csv?week=2026-09-30');
  assert.match(csv.data, /Gross pay/);
  assert.match(csv.data, /Jo/);
});

test('dashboard adds it all up', async () => {
  await owner('/expenses', { method: 'POST', body: { expense_date: '2026-09-29', category: 'Postage', amount_cents: 2500 } });
  const d = (await owner('/dashboard?from=2026-09-28&to=2026-10-04')).data;
  assert.equal(d.totals.gross_sales_cents, 5000);
  assert.equal(d.totals.sales_net_cents, 5000 - 660 - 450 - 1000);
  assert.equal(d.totals.expenses_cents, 2500);
  assert.equal(d.totals.net_profit_cents, d.totals.sales_net_cents - 2500 - d.totals.labor_cents);
  assert.equal(d.byChannel.ebay.orders, 1);
  assert.equal(d.weeks.length, 1);
});

test('the last active owner cannot be demoted', async () => {
  const me = (await owner('/users')).data.users.find((u) => u.role === 'owner');
  const r = await owner(`/users/${me.id}`, { method: 'PUT', body: { name: me.name, username: me.username, role: 'employee', active: true } });
  assert.equal(r.status, 400);
});

test('overtime: hours past the weekly threshold pay at the multiplier', () => {
  const settings = { week_start: '1', overtime_enabled: '1', overtime_threshold_hours: '40', overtime_multiplier: '1.5' };
  const entries = [];
  for (let d = 28; d <= 30; d++) entries.push({ user_id: 1, clock_in: `2026-09-${d}T06:00`, clock_out: `2026-09-${d}T20:00`, break_minutes: 0, hourly_rate_cents: 1000 });
  const p = computePay(entries, settings)[1]; // 3 x 14h = 42h
  assert.equal(p.regular_hours, 40);
  assert.equal(p.overtime_hours, 2);
  assert.equal(p.gross_cents, 40 * 1000 + 2 * 1500);
  const noOt = computePay(entries, { ...settings, overtime_enabled: '0' })[1];
  assert.equal(noOt.gross_cents, 42 * 1000);
  assert.equal(weekStartOf('2026-10-04', 1), '2026-09-28');
  assert.equal(weekStartOf('2026-10-04', 0), '2026-10-04');
});
