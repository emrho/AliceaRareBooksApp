// eBay integration: account connection (OAuth), business policies and locations,
// photo upload (Media API) and publishing fixed-price listings (Inventory API).
//
// Configure with EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME and optionally
// EBAY_ENV=sandbox (default production). Tokens are stored in the settings table.
import crypto from 'node:crypto';

export const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

export const CATEGORIES = {
  261186: 'Books & Magazines › Books',
  29223: 'Books & Magazines › Antiquarian & Collectible',
};

// eBay's book condition values (Inventory API enums).
export const CONDITIONS = {
  NEW: 'Brand New',
  LIKE_NEW: 'Like New',
  USED_VERY_GOOD: 'Very Good',
  USED_GOOD: 'Good',
  USED_ACCEPTABLE: 'Acceptable',
};

/** Maps a bookseller's grade (Fine, Near Fine, …) to the closest eBay condition. */
export function conditionFromGrade(grade) {
  const g = String(grade || '').toLowerCase();
  if (/as new|^new|mint/.test(g)) return 'LIKE_NEW';
  if (/^fine|near fine/.test(g)) return 'LIKE_NEW';
  if (/very good/.test(g)) return 'USED_VERY_GOOD';
  if (/good/.test(g)) return 'USED_GOOD';
  if (/fair|poor|acceptable|reading/.test(g)) return 'USED_ACCEPTABLE';
  return 'USED_GOOD';
}

export class EbayError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function ebayConfig(env = process.env) {
  const sandbox = (env.EBAY_ENV || '').toLowerCase() === 'sandbox';
  const cfg = {
    clientId: env.EBAY_CLIENT_ID || '',
    clientSecret: env.EBAY_CLIENT_SECRET || '',
    ruName: env.EBAY_RU_NAME || '',
    sandbox,
    marketplace: env.EBAY_MARKETPLACE || 'EBAY_US',
    authHost: sandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com',
    api: sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    apiz: sandbox ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com',
    apim: sandbox ? 'https://apim.sandbox.ebay.com' : 'https://apim.ebay.com',
    itemUrl: sandbox ? 'https://sandbox.ebay.com/itm/' : 'https://www.ebay.com/itm/',
  };
  cfg.configured = !!(cfg.clientId && cfg.clientSecret && cfg.ruName);
  return cfg;
}

function ebayMessage(data, status) {
  const errs = data?.errors || data?.error && [{ message: data.error_description || data.error }] || [];
  const msg = errs.map((e) => e.longMessage || e.message).filter(Boolean).join(' ');
  return msg || `eBay returned an error (${status})`;
}

/**
 * Talks to eBay for one connected account. `store` persists tokens:
 * { get(key) -> string, set(obj) } backed by the settings table.
 */
export class EbayClient {
  constructor(cfg, store, fetchImpl = fetch) {
    this.cfg = cfg;
    this.store = store;
    this.fetch = fetchImpl;
    this.access = null;
  }

  get connected() {
    const exp = this.store.get('ebay_refresh_expires');
    return !!this.store.get('ebay_refresh_token') && (!exp || exp > new Date().toISOString());
  }

  authorizeUrl(state) {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: this.cfg.ruName, response_type: 'code', scope: SCOPES.join(' '), state, prompt: 'login',
    });
    return `${this.cfg.authHost}/oauth2/authorize?${q}`;
  }

  async tokenRequest(params) {
    const res = await this.fetch(`${this.cfg.api}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new EbayError(502, `eBay sign-in failed: ${ebayMessage(data, res.status)}`);
    return data;
  }

  /** Finishes the OAuth flow with the code eBay redirected back with. */
  async connect(code) {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.ruName });
    const now = Date.now();
    this.access = { token: t.access_token, expires: now + (t.expires_in || 7200) * 1000 };
    this.store.set({
      ebay_refresh_token: t.refresh_token,
      ebay_refresh_expires: new Date(now + (t.refresh_token_expires_in || 47304000) * 1000).toISOString(),
      ebay_user: '',
    });
    try {
      const me = await this.call('GET', '/commerce/identity/v1/user/', { host: this.cfg.apiz });
      this.store.set({ ebay_user: me.username || '' });
    } catch { /* the username is only for display */ }
  }

  disconnect() {
    this.access = null;
    this.store.set({ ebay_refresh_token: '', ebay_refresh_expires: '', ebay_user: '' });
  }

  async accessToken() {
    if (this.access && this.access.expires > Date.now() + 60000) return this.access.token;
    const refresh = this.store.get('ebay_refresh_token');
    if (!refresh) throw new EbayError(409, 'eBay isn\'t connected. The owner can connect it in Settings → eBay.');
    const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, scope: SCOPES.join(' ') });
    this.access = { token: t.access_token, expires: Date.now() + (t.expires_in || 7200) * 1000 };
    return this.access.token;
  }

  async call(method, path, { body, host = this.cfg.api, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Language'] = 'en-US';
    }
    const res = await this.fetch(host + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!res.ok) throw new EbayError(res.status === 401 ? 409 : 502, ebayMessage(data, res.status), data);
    return data;
  }

  // ---- setup --------------------------------------------------------------

  async policies() {
    const m = `marketplace_id=${this.cfg.marketplace}`;
    const [f, p, r, l] = await Promise.all([
      this.call('GET', `/sell/account/v1/fulfillment_policy?${m}`),
      this.call('GET', `/sell/account/v1/payment_policy?${m}`),
      this.call('GET', `/sell/account/v1/return_policy?${m}`),
      this.call('GET', '/sell/inventory/v1/location?limit=100'),
    ]);
    return {
      fulfillment: (f.fulfillmentPolicies || []).map((x) => ({ id: x.fulfillmentPolicyId, name: x.name })),
      payment: (p.paymentPolicies || []).map((x) => ({ id: x.paymentPolicyId, name: x.name })),
      returns: (r.returnPolicies || []).map((x) => ({ id: x.returnPolicyId, name: x.name })),
      locations: (l.locations || []).map((x) => ({
        key: x.merchantLocationKey,
        name: x.name || [x.location?.address?.city, x.location?.address?.stateOrProvince].filter(Boolean).join(', ') || x.merchantLocationKey,
      })),
    };
  }

  async createLocation({ name, city, state, postalCode, country = 'US' }) {
    const key = `home-${crypto.randomBytes(3).toString('hex')}`;
    await this.call('POST', `/sell/inventory/v1/location/${key}`, {
      body: {
        name: name || 'Home',
        location: { address: { city, stateOrProvince: state, postalCode, country } },
        locationTypes: ['WAREHOUSE'],
        merchantLocationStatus: 'ENABLED',
      },
    });
    return key;
  }

  // ---- listing ------------------------------------------------------------

  /** Uploads one JPEG to eBay Picture Services and returns its eBay-hosted URL. */
  async uploadImage(buffer, filename = 'photo.jpg') {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), filename);
    const res = await this.fetch(`${this.cfg.apim}/commerce/media/v1_beta/image/create_image_from_file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new EbayError(502, `Photo upload to eBay failed: ${ebayMessage(data, res.status)}`);
    if (data.imageUrl) return data.imageUrl;
    const loc = res.headers.get('location');
    if (!loc) throw new EbayError(502, 'eBay didn\'t return a photo URL');
    const img = await this.call('GET', new URL(loc).pathname, { host: this.cfg.apim });
    return img.imageUrl;
  }

  /**
   * Creates/updates the inventory item and offer for `listing`, then publishes it.
   * Returns { listingId, offerId, url }.
   */
  async publish(listing, policy) {
    const missing = ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocationKey'].filter((k) => !policy[k]);
    if (missing.length) throw new EbayError(409, 'Pick your eBay shipping, payment and return policies and a ship-from location in Settings → eBay first.');
    const sku = encodeURIComponent(listing.sku);
    const product = {
      title: listing.title,
      description: listing.descriptionText,
      aspects: listing.aspects,
      imageUrls: listing.imageUrls,
    };
    if (listing.isbn) product.isbn = [listing.isbn];
    const item = {
      availability: { shipToLocationAvailability: { quantity: listing.quantity } },
      condition: listing.condition,
      product,
    };
    if (listing.conditionDescription && listing.condition !== 'NEW') item.conditionDescription = listing.conditionDescription.slice(0, 1000);
    await this.call('PUT', `/sell/inventory/v1/inventory_item/${sku}`, { body: item });

    const offer = {
      availableQuantity: listing.quantity,
      categoryId: String(listing.categoryId),
      listingDescription: listing.descriptionHtml,
      listingPolicies: {
        fulfillmentPolicyId: policy.fulfillmentPolicyId,
        paymentPolicyId: policy.paymentPolicyId,
        returnPolicyId: policy.returnPolicyId,
      },
      merchantLocationKey: policy.merchantLocationKey,
      pricingSummary: { price: { value: (listing.priceCents / 100).toFixed(2), currency: 'USD' } },
    };
    let offerId;
    const existing = await this.call('GET', `/sell/inventory/v1/offer?sku=${sku}&marketplace_id=${this.cfg.marketplace}`).catch(() => ({}));
    if (existing.offers?.length) {
      offerId = existing.offers[0].offerId;
      await this.call('PUT', `/sell/inventory/v1/offer/${offerId}`, { body: offer });
    } else {
      const created = await this.call('POST', '/sell/inventory/v1/offer', {
        body: { sku: listing.sku, marketplaceId: this.cfg.marketplace, format: 'FIXED_PRICE', ...offer },
      });
      offerId = created.offerId;
    }
    const pub = await this.call('POST', `/sell/inventory/v1/offer/${offerId}/publish`, { body: {} });
    return { offerId, listingId: pub.listingId, url: `${this.cfg.itemUrl}${pub.listingId}` };
  }

  /** Ends a published listing (the offer stays, so it can be republished later). */
  async end(offerId) {
    await this.call('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, { body: {} });
  }
}

// ---- listing content -------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Plain-text description (paragraphs split by blank lines) plus a details list, as listing HTML. */
export function descriptionHtml(text, details) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const rows = Object.entries(details).filter(([, v]) => v)
    .map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('\n');
  return `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.5">\n${paras}\n${rows ? `<ul>\n${rows}\n</ul>` : ''}\n</div>`;
}

/** eBay item specifics for the Books categories; empty values are dropped. */
export function bookAspects(b, extra = {}) {
  const format = /paper|mass/i.test(b.binding || '') ? 'Paperback' : /leather/i.test(b.binding || '') ? 'Leather' : b.binding ? 'Hardcover' : '';
  const a = {
    'Book Title': b.title,
    Author: b.author,
    Language: extra.language || 'English',
    Publisher: b.publisher,
    'Publication Year': /^\d{4}$/.test(b.pub_year || '') ? b.pub_year : '',
    Format: format,
    Edition: b.edition,
    Genre: extra.genre,
    Illustrator: extra.illustrator,
    'Signed': extra.signed === 'Yes' ? 'Yes' : extra.signed === 'No' ? 'No' : '',
    ISBN: b.isbn,
  };
  const out = {};
  for (const [k, v] of Object.entries(a)) if (v) out[k] = [String(v).slice(0, 65)];
  return out;
}
