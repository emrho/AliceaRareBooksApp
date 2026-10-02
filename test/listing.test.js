import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { bookAspects, conditionFromGrade, descriptionHtml } from '../server/ebay.js';

// A tiny "JPEG": the server only checks the magic bytes.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64')}`;

const AI_BOOK = {
  title: 'Dune', subtitle: '', author: 'Frank Herbert', isbn: '', publisher: 'Chilton', pub_year: '1965',
  edition: 'First Edition', binding: 'Hardcover w/ DJ', language: 'English', genre: 'Science Fiction', illustrator: '',
  signed: 'No', condition: 'Very Good', condition_notes: 'Light edge wear to jacket', ebay_title: 'Dune Frank Herbert 1965 Chilton First Edition HC/DJ',
  description: 'The classic.\n\nVery good copy.', price_low: 900, price_high: 1400, price_reasoning: 'Check comps.',
  collectible: true, confidence: 'medium', verify: ['Check the price on the jacket flap'],
};

/** Fake Anthropic client: records the request and returns structured JSON. */
const aiCalls = [];
const anthropic = {
  beta: {
    messages: {
      create: async (req) => {
        aiCalls.push(req);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(AI_BOOK) }] };
      },
    },
  },
};

/** Fake eBay: enough of OAuth, Account, Media and Inventory APIs. */
const ebayCalls = [];
let failPublish = false;
async function ebayFetch(url, opts = {}) {
  const u = new URL(url);
  const method = opts.method || 'GET';
  ebayCalls.push(`${method} ${u.pathname}${u.search}`);
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (u.pathname === '/identity/v1/oauth2/token') {
    const p = new URLSearchParams(String(opts.body));
    assert.match(opts.headers.Authorization, /^Basic /);
    if (p.get('grant_type') === 'authorization_code') {
      assert.equal(p.get('code'), 'good-code');
      assert.equal(p.get('redirect_uri'), 'My-RuName');
      return json({ access_token: 'acc', expires_in: 7200, refresh_token: 'ref', refresh_token_expires_in: 47304000 });
    }
    return json({ access_token: 'acc2', expires_in: 7200 });
  }
  assert.match(opts.headers?.Authorization || '', /^Bearer acc/);
  if (u.pathname === '/commerce/identity/v1/user/') return json({ username: 'aliceabooks' });
  if (u.pathname === '/sell/account/v1/fulfillment_policy') return json({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'F1', name: 'Media Mail' }] });
  if (u.pathname === '/sell/account/v1/payment_policy') return json({ paymentPolicies: [{ paymentPolicyId: 'P1', name: 'Managed' }] });
  if (u.pathname === '/sell/account/v1/return_policy') return json({ returnPolicies: [{ returnPolicyId: 'R1', name: '30 days' }] });
  if (u.pathname === '/sell/inventory/v1/location' && method === 'GET') return json({ locations: [] });
  if (u.pathname.startsWith('/sell/inventory/v1/location/')) return new Response(null, { status: 204 });
  if (u.pathname === '/commerce/media/v1_beta/image/create_image_from_file') {
    assert.ok(opts.body instanceof FormData);
    return new Response(null, { status: 201, headers: { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/IMG1' } });
  }
  if (u.pathname === '/commerce/media/v1_beta/image/IMG1') return json({ imageUrl: 'https://i.ebayimg.com/images/IMG1.jpg' });
  if (u.pathname.startsWith('/sell/inventory/v1/inventory_item/')) {
    const item = JSON.parse(opts.body);
    assert.equal(opts.headers['Content-Language'], 'en-US');
    assert.equal(item.condition, 'USED_VERY_GOOD');
    assert.deepEqual(item.product.imageUrls, ['https://i.ebayimg.com/images/IMG1.jpg']);
    assert.deepEqual(item.product.aspects.Author, ['Frank Herbert']);
    assert.deepEqual(item.product.aspects.Language, ['English']);
    return new Response(null, { status: 204 });
  }
  if (u.pathname === '/sell/inventory/v1/offer' && method === 'GET') return json({ offers: [] });
  if (u.pathname === '/sell/inventory/v1/offer' && method === 'POST') {
    const offer = JSON.parse(opts.body);
    assert.equal(offer.categoryId, '29223');
    assert.equal(offer.pricingSummary.price.value, '1150.00');
    assert.equal(offer.listingPolicies.fulfillmentPolicyId, 'F1');
    assert.match(offer.listingDescription, /<p>The classic.<\/p>/);
    return json({ offerId: 'OFF1' }, 201);
  }
  if (u.pathname === '/sell/inventory/v1/offer/OFF1/publish') {
    if (failPublish) return json({ errors: [{ errorId: 25002, message: 'A user error has occurred', longMessage: 'Missing item specific Book Title' }] }, 400);
    return json({ listingId: '110012345678' });
  }
  if (u.pathname === '/sell/inventory/v1/offer/OFF1/withdraw') return json({ listingId: '110012345678' });
  return json({ errors: [{ message: `unexpected ${method} ${u.pathname}` }] }, 404);
}

let server;
let base;
let photosDir;
let cookie = '';
async function call(p, method = 'GET', body, extra = {}) {
  const res = await fetch(base + p, {
    method, redirect: 'manual', headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body), ...extra,
  });
  cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-'));
  const env = { EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'secret', EBAY_RU_NAME: 'My-RuName' };
  server = createApp(openDb(':memory:'), { fetchImpl: ebayFetch, env, anthropic, photosDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  await call('/api/setup', 'POST', { name: 'Owner', username: 'owner', password: 'password123' });
});
after(() => {
  server.close();
  fs.rmSync(photosDir, { recursive: true, force: true });
});

test('listing helpers', () => {
  assert.equal(conditionFromGrade('Near Fine'), 'LIKE_NEW');
  assert.equal(conditionFromGrade('Very Good'), 'USED_VERY_GOOD');
  assert.equal(conditionFromGrade('Good'), 'USED_GOOD');
  assert.equal(conditionFromGrade('Fair'), 'USED_ACCEPTABLE');
  assert.match(descriptionHtml('A <b>book</b>\n\nTwo', { Author: 'X & Y', Year: '' }), /<p>A &lt;b&gt;book&lt;\/b&gt;<\/p>\n<p>Two<\/p>[\s\S]*X &amp; Y/);
  const a = bookAspects({ title: 'T', author: 'A', binding: 'Paperback', pub_year: '1999', publisher: '' }, { signed: 'Unknown' });
  assert.deepEqual(a, { 'Book Title': ['T'], Author: ['A'], Language: ['English'], 'Publication Year': ['1999'], Format: ['Paperback'] });
});

test('AI identifies a book from photos', async () => {
  const r = await call('/api/ai/identify', 'POST', { images: [JPEG, JPEG] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.book.title, 'Dune');
  const req = aiCalls.at(-1);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.messages[0].content.filter((c) => c.type === 'image').length, 2);
  assert.equal((await call('/api/ai/identify', 'POST', { images: [] })).status, 400);
  assert.equal((await call('/api/ai/identify', 'POST', { images: ['data:text/plain;base64,aGk='] })).status, 400);
});

test('eBay: connect with OAuth, pick policies and a location', async () => {
  assert.equal((await call('/api/ebay')).data.connected, false);
  const { data } = await call('/api/ebay/connect', 'POST', {});
  const authUrl = new URL(data.url);
  assert.equal(authUrl.host, 'auth.ebay.com');
  assert.match(authUrl.searchParams.get('scope'), /sell\.inventory/);
  const state = authUrl.searchParams.get('state');
  const bad = await call(`/api/ebay/callback?code=good-code&state=wrong`);
  assert.match(bad.headers.get('location'), /expired/);
  const again = (await call('/api/ebay/connect', 'POST', {})).data.url;
  const ok = await call(`/api/ebay/callback?code=good-code&state=${new URL(again).searchParams.get('state')}`);
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location'), /ebay=connected/);
  assert.notEqual(state, new URL(again).searchParams.get('state'));
  const st = (await call('/api/ebay')).data;
  assert.equal(st.connected, true);
  assert.equal(st.user, 'aliceabooks');
  assert.equal(st.ready, false);
  const pol = (await call('/api/ebay/policies')).data;
  assert.equal(pol.fulfillment[0].id, 'F1');
  assert.equal((await call('/api/ebay/locations', 'POST', { postalCode: '10001', city: 'New York', state: 'NY' })).status, 201);
  const saved = (await call('/api/ebay/settings', 'PUT', { fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1' })).data;
  assert.equal(saved.ready, true);
  assert.match(saved.policy.merchantLocationKey, /^home-/);
});

let bookId;
test('lister: save with photos and publish to eBay', async () => {
  const noPhotos = await call('/api/lister/save', 'POST', { book: { title: 'Bare' }, list: { price_cents: 500 } });
  assert.equal(noPhotos.status, 201);
  assert.match(noPhotos.data.ebayError, /photo/);
  assert.equal(noPhotos.data.listing, null);

  const r = await call('/api/lister/save', 'POST', {
    book: { title: 'Dune', author: 'Frank Herbert', publisher: 'Chilton', pub_year: '1965', edition: 'First Edition', binding: 'Hardcover w/ DJ', condition: 'Very Good', quantity: 1, list_price_cents: 115000, cost_cents: 2000, description: 'The classic.\n\nVery good copy.' },
    images: [{ data: JPEG, thumb: JPEG }],
    list: { title: AI_BOOK.ebay_title, description: AI_BOOK.description, condition: 'USED_VERY_GOOD', category_id: '29223', price_cents: 115000, quantity: 1, aspects: { language: 'English', genre: 'Science Fiction' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.ebayError, null);
  assert.equal(r.data.listing.listingId, '110012345678');
  assert.equal(r.data.listing.url, 'https://www.ebay.com/itm/110012345678');
  assert.equal(r.data.book.ebay_listed, 1);
  assert.equal(r.data.book.ebay_ref, '110012345678');
  assert.equal(r.data.book.ebay_offer_id, 'OFF1');
  assert.equal(r.data.photos.length, 1);
  bookId = r.data.book.id;
  assert.ok(fs.existsSync(path.join(photosDir, `${r.data.photos[0].id}.jpg`)));
  assert.ok(fs.existsSync(path.join(photosDir, `${r.data.photos[0].id}_t.jpg`)));

  // Inventory shows the cover thumbnail; the photo is served to signed-in users only.
  const list = (await call('/api/books?status=all')).data.books.find((b) => b.id === bookId);
  assert.equal(list.photo_id, r.data.photos[0].id);
  const img = await fetch(`${base}/api/photos/${list.photo_id}?size=thumb`, { headers: { cookie } });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/api/photos/${list.photo_id}`)).status, 401);

  // Photos already on eBay aren't uploaded twice.
  const uploads = ebayCalls.filter((c) => c.includes('create_image_from_file')).length;
  failPublish = true;
  const retry = await call(`/api/books/${bookId}/ebay/list`, 'POST', { price_cents: 115000, category_id: '29223', condition: 'USED_VERY_GOOD', description: AI_BOOK.description });
  assert.equal(retry.status, 502);
  assert.match(retry.data.error, /Missing item specific/);
  failPublish = false;
  assert.equal(ebayCalls.filter((c) => c.includes('create_image_from_file')).length, uploads);
});

test('ending a listing and selling the last copy', async () => {
  const end = await call(`/api/books/${bookId}/ebay/end`, 'POST', {});
  assert.equal(end.status, 200);
  assert.equal(end.data.book.ebay_listed, 0);
  assert.ok(ebayCalls.includes('POST /sell/inventory/v1/offer/OFF1/withdraw'));
});

test('photos: add, reorder, delete', async () => {
  let photos = (await call(`/api/books/${bookId}/photos`, 'POST', { images: [{ data: JPEG }, { data: JPEG }] })).data.photos;
  assert.equal(photos.length, 3);
  photos = (await call(`/api/photos/${photos[2].id}/cover`, 'POST', {})).data.photos;
  const newCover = photos[0].id;
  assert.equal(Math.max(...photos.map((p) => p.id)), newCover);
  photos = (await call(`/api/photos/${newCover}`, 'DELETE', {})).data.photos;
  assert.equal(photos.length, 2);
  assert.ok(!fs.existsSync(path.join(photosDir, `${newCover}.jpg`)));
  const bad = await call(`/api/books/${bookId}/photos`, 'POST', { images: [{ data: 'data:image/jpeg;base64,AAAA' }] });
  assert.equal(bad.status, 400);
});

test('home screen summary', async () => {
  const h = (await call('/api/home')).data;
  assert.equal(h.ebay.connected, true);
  assert.equal(h.ebay.ready, true);
  assert.ok(h.inventory.titles >= 1);
  assert.ok('week_pay_cents' in h.team);
});
