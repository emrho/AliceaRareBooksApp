// Book Shop Manager — single-page frontend (no build step).

// ---- tiny helpers -----------------------------------------------------------

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const renderVal = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
};
/** Tagged template that escapes every interpolation unless it is already html``. */
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += renderVal(v) + strings[i + 1]; });
  return new Safe(out);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents) => moneyFmt.format((cents || 0) / 100);
const moneyShort = (cents) => {
  const d = (cents || 0) / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
};
const toCents = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const centsInput = (c) => (c ? (c / 100).toFixed(2) : '');
const hrs = (h) => (h || 0).toFixed(2);

const pad = (n) => String(n).padStart(2, '0');
const parseD = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const fmtD = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (d, n) => fmtD(parseD(d) + n * 86400000);
const weekStartOf = (d, ws) => addDays(d, -((new Date(parseD(d)).getUTCDay() - ws + 7) % 7));
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const today = () => nowLocal().slice(0, 10);
const prettyDate = (d, opts = { month: 'short', day: 'numeric' }) => (d ? new Date(parseD(d.slice(0, 10))).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
const prettyTime = (ts) => {
  if (!ts) return '';
  const [h, m] = ts.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CHANNELS = {
  ebay: { label: 'eBay', color: 'var(--ch-ebay)' },
  whatnot: { label: 'Whatnot', color: 'var(--ch-whatnot)' },
  amazon: { label: 'Amazon', color: 'var(--ch-amazon)' },
  other: { label: 'Other / in person', color: 'var(--ch-other)' },
};
const LISTING_CHANNELS = ['ebay', 'whatnot', 'amazon'];
const channelChip = (ch) => html`<span class="pill"><span class="dot" style="background:${CHANNELS[ch].color}"></span>${CHANNELS[ch].label}</span>`;

// ---- API ----------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    renderApp();
    throw new Error(data.error || 'Please sign in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2800);
}

// ---- modal ----------------------------------------------------------------------

/**
 * Opens a form dialog. onSubmit(values, form) may throw to show an error and keep
 * the dialog open; resolve to close it.
 */
function openModal({ title, body, submitLabel = 'Save', onSubmit, extra = '', onOpen, wide = false, readOnly = false }) {
  const dlg = $('#modal');
  dlg.style.width = wide ? 'min(900px, calc(100vw - 32px))' : '';
  dlg.innerHTML = html`
    <form class="modal" novalidate>
      <div class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${readOnly ? html`<fieldset disabled class="plain">${body}</fieldset>` : body}<div class="error" role="alert"></div></div>
      <div class="modal-foot">${extra}<span class="spacer"></span>
        <button type="button" class="btn" data-close>${submitLabel ? 'Cancel' : 'Close'}</button>
        ${submitLabel ? html`<button type="submit" class="btn primary">${submitLabel}</button>` : ''}
      </div>
    </form>`.s;
  const form = $('form', dlg);
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    if (!btn) return;
    btn.disabled = true;
    $('.error', form).textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form));
      await onSubmit(values, form);
      dlg.close();
    } catch (err) {
      $('.error', form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  dlg.showModal();
  onOpen?.(form, dlg);
  const first = $('input:not([type=hidden]):not([type=checkbox]), select, textarea', form);
  first?.focus();
  return { form, dlg };
}

function confirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    let ok = false;
    const { dlg } = openModal({ title, body: html`<p style="margin:0">${message}</p>`, submitLabel: confirmLabel, onSubmit: () => { ok = true; } });
    dlg.addEventListener('close', () => resolve(ok), { once: true });
  });
}

// ---- state & routing --------------------------------------------------------------

const state = { user: null, businessName: '', weekStart: 1, needsSetup: false, sheets: {} };
let timers = [];
const isOwner = () => state.user?.role === 'owner';

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  inventory: '<path d="M4 4h4v16H4zm6 0h4v16h-4zm6.2 1.3 3.8-1 4 15.5-3.9 1z" transform="scale(.9) translate(1 1)"/>',
  sales: '<path d="M4 18l5-6 4 3 7-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 21h17" stroke="currentColor" stroke-width="2"/>',
  expenses: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18" stroke="currentColor" stroke-width="2"/>',
  payroll: '<path d="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.7 4.5 3.2 4.5 1.5 4.5 3.3-2 3-4.5 3-4.5-1.3-4.5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6s7 2 7 6z"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14c3 0 5 1.7 5 5h-4.5c0-2-.7-3.7-2-4.8z"/>',
  settings: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const icon = (name) => new Safe(`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`);

const ROUTES = {
  dashboard: { label: 'Dashboard', owner: true, render: pageDashboard },
  clock: { label: 'Time Clock', render: pageClock },
  inventory: { label: 'Inventory', render: pageInventory },
  sales: { label: 'Sales', owner: true, render: pageSales },
  expenses: { label: 'Expenses', owner: true, render: pageExpenses },
  payroll: { label: 'Hours & Pay', owner: true, render: pagePayroll },
  team: { label: 'Team', owner: true, render: pageTeam },
  settings: { label: 'Settings', owner: true, icon: 'settings', render: pageSettings },
};

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  const r = ROUTES[name];
  if (r && (!r.owner || isOwner())) return name;
  return isOwner() ? 'dashboard' : 'clock';
}

async function boot() {
  const s = await api('/status');
  Object.assign(state, { user: s.user, businessName: s.businessName, weekStart: s.weekStart, needsSetup: s.needsSetup, sheets: s.sheets || {} });
  document.title = s.businessName || 'Book Shop Manager';
  renderApp();
}

function renderApp() {
  timers.forEach(clearInterval);
  timers = [];
  const app = $('#app');
  if (!state.user) {
    app.innerHTML = '';
    return state.needsSetup ? pageSetup(app) : pageLogin(app);
  }
  if (!$('.shell', app)) {
    app.innerHTML = html`
      <div class="shell">
        <div class="topbar">
          <button class="icon-btn" id="nav-toggle" aria-label="Open menu">☰</button>
          <strong>${state.businessName}</strong>
        </div>
        <aside class="sidebar">
          <div class="brand"><span class="brand-mark">AR</span><span>${state.businessName}</span></div>
          <nav class="nav">
            ${Object.entries(ROUTES).filter(([, r]) => !r.owner || isOwner()).map(([k, r]) => html`
              <a href="#/${k}" data-route="${k}">${icon(r.icon || k)}${r.label}</a>`)}
          </nav>
          <div class="sidebar-foot">
            <div class="who">${state.user.name}</div>
            <div>${isOwner() ? 'Owner' : 'Team member'}</div>
            <div class="row" style="margin-top:8px">
              <button class="btn link small" id="pw-btn">Change password</button>
              <button class="btn link small" id="logout-btn">Sign out</button>
            </div>
          </div>
        </aside>
        <main class="main" id="main" tabindex="-1"></main>
      </div>`.s;
    $('#logout-btn').addEventListener('click', async () => {
      await api('/logout', { method: 'POST' });
      state.user = null;
      location.hash = '';
      renderApp();
    });
    $('#pw-btn').addEventListener('click', changePasswordModal);
    $('#nav-toggle').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));
    $('.sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) $('.shell').classList.remove('nav-open'); });
  }
  const route = currentRoute();
  $$('.nav a').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  main.innerHTML = '<div class="muted">Loading…</div>';
  ROUTES[route].render(main).catch((err) => {
    main.innerHTML = html`<div class="card"><strong>Couldn't load this page.</strong><div class="muted">${err.message}</div></div>`.s;
  });
}

window.addEventListener('hashchange', renderApp);

// ---- auth pages ----------------------------------------------------------------------

function pageLogin(app) {
  app.innerHTML = html`
    <div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><span class="brand-mark">AR</span>${state.businessName}</div>
      <p>Sign in to clock in, manage inventory and more.</p>
      <form id="login">
        <label class="field">Username<input name="username" autocomplete="username" required></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" role="alert"></div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div></div>`.s;
  const form = $('#login');
  $('input', form).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      await boot();
    } catch (err) {
      $('.error', form).textContent = err.message;
    }
  });
}

function pageSetup(app) {
  app.innerHTML = html`
    <div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><span class="brand-mark">AR</span>Welcome</div>
      <p>Create the owner account to get started. You'll add employees afterward.</p>
      <form id="setup">
        <label class="field">Business name<input name="business_name" value="${state.businessName}"></label>
        <label class="field">Your name<input name="name" required></label>
        <label class="field">Username<input name="username" autocomplete="username" required></label>
        <label class="field">Password (8+ characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <div class="error" role="alert"></div>
        <button class="btn primary" type="submit">Create owner account</button>
      </form>
    </div></div>`.s;
  const form = $('#setup');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/setup', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      location.hash = '#/team';
      await boot();
    } catch (err) {
      $('.error', form).textContent = err.message;
    }
  });
}

function changePasswordModal() {
  openModal({
    title: 'Change password',
    body: html`
      <label class="field">Current password<input name="current_password" type="password" autocomplete="current-password" required></label>
      <label class="field">New password (8+ characters)<input name="new_password" type="password" autocomplete="new-password" required></label>`,
    onSubmit: async (v) => {
      await api('/me/password', { method: 'POST', body: v });
      toast('Password changed');
    },
  });
}

// ---- shared: Google Sheets ------------------------------------------------------------------

const SECTIONS_LINKED = (sh) => !!(sh && (sh.inventory || sh.sales || sh.expenses));
const SECTION_LABEL = { inventory: 'Inventory', sales: 'Sales', expenses: 'Expenses' };
const sheetLinked = (section) => !!state.sheets?.[section];

function timeAgo(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} hr ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function refreshStatus() {
  const s = await api('/status');
  state.sheets = s.sheets || {};
}

/** Runs a sync, reports the outcome, and calls reload() when done. */
async function runSync(reload, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const r = await api('/sheets/sync', { method: 'POST' });
    await refreshStatus();
    const parts = Object.entries(r.sections).map(([k, v]) => (v.ok ? `${SECTION_LABEL[k]}: ${v.imported} row${v.imported === 1 ? '' : 's'}${v.skipped.count ? ` (${v.skipped.count} skipped)` : ''}` : `${SECTION_LABEL[k]}: failed`));
    toast(`Synced from Google Sheets — ${parts.join(' · ')}`, !r.ok);
  } catch (err) {
    toast(err.message, true);
  }
  reload?.();
}

/** Notice at the top of a page whose data comes from a Google Sheet. */
function sheetBanner(section) {
  if (!sheetLinked(section)) return '';
  const url = state.sheets[`${section}Url`];
  return html`<div class="sheet-banner">
    <span class="sheet-icon" aria-hidden="true">▦</span>
    <span>${SECTION_LABEL[section]} ${section === 'inventory' ? 'comes' : 'come'} from your Google Sheet. Add or change ${section === 'inventory' ? 'books' : section} there.
      <span class="muted">Last synced ${timeAgo(state.sheets.lastSyncAt)}${state.sheets.lastOk === false ? ' (with problems — see Settings)' : ''}.</span></span>
    <span class="row">${url ? html`<a class="btn small" href="${url}" target="_blank" rel="noopener">Open sheet</a>` : ''}
      ${isOwner() ? html`<button class="btn small" data-sync>Sync now</button>` : ''}</span>
  </div>`;
}
function bindSheetBanner(root, reload) {
  $$('[data-sync]', root).forEach((b) => b.addEventListener('click', () => runSync(reload, b)));
}
const fromSheetToast = (row) => toast(`This comes from row ${row.sheet_row || '?'} of your Google Sheet — edit it there, then sync.`);

// ---- shared: date range picker ---------------------------------------------------------

const RANGE_PRESETS = {
  week: { label: 'This week', calc: () => [weekStartOf(today(), state.weekStart), today()] },
  month: { label: 'This month', calc: () => [`${today().slice(0, 7)}-01`, today()] },
  last30: { label: 'Last 30 days', calc: () => [addDays(today(), -29), today()] },
  quarter: { label: 'Last 90 days', calc: () => [addDays(today(), -89), today()] },
  ytd: { label: 'Year to date', calc: () => [`${today().slice(0, 4)}-01-01`, today()] },
};
const rangeState = { preset: 'last30', from: null, to: null };
function currentRange() {
  if (rangeState.preset !== 'custom') [rangeState.from, rangeState.to] = RANGE_PRESETS[rangeState.preset].calc();
  return { from: rangeState.from, to: rangeState.to };
}
function rangeControls() {
  const { from, to } = currentRange();
  return html`
    <div class="seg" role="group" aria-label="Date range">
      ${Object.entries(RANGE_PRESETS).map(([k, p]) => html`<button type="button" data-preset="${k}" aria-pressed="${rangeState.preset === k}">${p.label}</button>`)}
    </div>
    <label class="row small muted">From <input type="date" data-range="from" value="${from}"></label>
    <label class="row small muted">to <input type="date" data-range="to" value="${to}"></label>`;
}
function bindRange(root, reload) {
  $$('[data-preset]', root).forEach((b) => b.addEventListener('click', () => { rangeState.preset = b.dataset.preset; reload(); }));
  $$('[data-range]', root).forEach((inp) => inp.addEventListener('change', () => {
    if (!inp.value) return;
    const { from, to } = currentRange();
    rangeState.preset = 'custom';
    rangeState.from = from;
    rangeState.to = to;
    rangeState[inp.dataset.range] = inp.value;
    if (rangeState.from > rangeState.to) [rangeState.from, rangeState.to] = [rangeState.to, rangeState.from];
    reload();
  }));
}
const rangeLabel = ({ from, to }) => `${prettyDate(from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${prettyDate(to, { month: 'short', day: 'numeric', year: 'numeric' })}`;

// ---- dashboard ------------------------------------------------------------------------------

async function pageDashboard(main) {
  const r = currentRange();
  const d = await api(`/dashboard?from=${r.from}&to=${r.to}`);
  const t = d.totals;
  const channelRows = Object.entries(d.byChannel).filter(([k, v]) => v.orders > 0 || k !== 'other');
  const grossAll = t.gross_sales_cents || 1;
  const maxExp = Math.max(1, ...d.expensesByCategory.map((e) => e.cents));
  const inv = d.inventory;

  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Dashboard</h1><div class="sub">${rangeLabel(d)}${SECTIONS_LINKED(d.sheets) ? html` · Google Sheets synced ${timeAgo(d.sheets.lastSyncAt)}` : ''}</div></div>
      ${SECTIONS_LINKED(d.sheets) ? html`<button class="btn" data-sync>Sync now</button>` : ''}
    </div>
    <div class="toolbar">${rangeControls()}</div>

    <div class="grid kpis">
      <div class="card tile hero"><div class="label">Net profit</div>
        <div class="value ${t.net_profit_cents < 0 ? 'neg' : ''}">${money(t.net_profit_cents)}</div>
        <div class="foot">after fees, shipping, cost of books, expenses &amp; labor</div></div>
      <div class="card tile"><div class="label">Gross sales</div><div class="value">${money(t.gross_sales_cents)}</div>
        <div class="foot">${t.orders} orders · ${t.items} books</div></div>
      <div class="card tile"><div class="label">Expenses</div><div class="value">${money(t.expenses_cents)}</div>
        <div class="foot">${d.expensesByCategory.length} categories</div></div>
      <div class="card tile"><div class="label">Labor</div><div class="value">${money(t.labor_cents)}</div>
        <div class="foot">${hrs(t.labor_hours)} hours worked</div></div>
      <div class="card tile"><div class="label">Platform fees</div><div class="value">${money(t.fees_cents)}</div>
        <div class="foot">${t.gross_sales_cents ? ((t.fees_cents / t.gross_sales_cents) * 100).toFixed(1) : '0.0'}% of gross</div></div>
    </div>

    <div class="grid two" style="margin-top:16px">
      <div class="card" style="grid-column: span 1">
        <div class="card-head"><h2>Weekly sales by channel</h2><span class="hint">item price + shipping charged</span></div>
        <div id="weekly-chart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Profit &amp; loss</h2><span class="hint">${rangeLabel(d)}</span></div>
        <table><tbody>
          <tr><td>Sales (incl. shipping charged)</td><td class="num">${money(t.gross_sales_cents)}</td></tr>
          <tr><td class="muted">− Platform fees</td><td class="num">${money(-t.fees_cents)}</td></tr>
          <tr><td class="muted">− Postage paid on orders</td><td class="num">${money(-t.shipping_cost_cents)}</td></tr>
          <tr><td class="muted">− Cost of books sold</td><td class="num">${money(-t.cogs_cents)}</td></tr>
          <tr><td><strong>Profit on sales</strong></td><td class="num"><strong>${money(t.sales_net_cents)}</strong></td></tr>
          <tr><td class="muted">− Business expenses</td><td class="num">${money(-t.expenses_cents)}</td></tr>
          <tr><td class="muted">− Employee pay</td><td class="num">${money(-t.labor_cents)}</td></tr>
        </tbody><tfoot><tr><td>Net profit</td><td class="num ${t.net_profit_cents < 0 ? 'neg' : 'pos'}">${money(t.net_profit_cents)}</td></tr></tfoot></table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Team this week</h2>
        <span class="hint">${prettyDate(d.teamWeek.from)} – ${prettyDate(d.teamWeek.to)} · <a href="#/payroll">Hours &amp; pay details</a></span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Status</th><th class="num">Hours</th><th class="num">Overtime</th><th class="num">Rate</th><th class="num">Pay this week</th></tr></thead>
        <tbody>${d.team.length ? d.team.map((m) => html`<tr>
          <td>${m.name}${m.role === 'owner' ? html` <span class="pill">owner</span>` : ''}</td>
          <td>${m.clocked_in_since ? html`<span class="pill good">● On the clock since ${prettyTime(m.clocked_in_since)}${m.clocked_in_since.slice(0, 10) !== today() ? ` (${prettyDate(m.clocked_in_since)})` : ''}</span>` : html`<span class="muted small">Off</span>`}</td>
          <td class="num">${hrs(m.total_hours)}</td>
          <td class="num">${m.overtime_hours ? html`<span class="pill warn">${hrs(m.overtime_hours)}</span>` : '—'}</td>
          <td class="num">${money(m.hourly_rate_cents)}/hr</td>
          <td class="num"><strong>${money(m.gross_cents)}</strong></td></tr>`) : html`<tr><td colspan="6" class="empty">No team members yet. <a href="#/team">Add one</a>.</td></tr>`}
        </tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="num">${hrs(d.teamWeek.totals.total_hours)}</td><td class="num">${hrs(d.teamWeek.totals.overtime_hours)}</td><td></td><td class="num">${money(d.teamWeek.totals.gross_cents)}</td></tr></tfoot>
      </table></div>
    </div>

    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h2>Sales by channel</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Channel</th><th class="num">Orders</th><th class="num">Gross</th><th class="num">Fees</th><th class="num">Profit</th><th class="num">Share</th></tr></thead>
          <tbody>${channelRows.map(([k, c]) => html`<tr>
            <td>${channelChip(k)}</td><td class="num">${c.orders}</td>
            <td class="num">${money(c.revenue_cents + c.shipping_charged_cents)}</td>
            <td class="num">${money(c.fees_cents)}</td>
            <td class="num ${c.net_cents < 0 ? 'neg' : ''}">${money(c.net_cents)}</td>
            <td class="num">${(((c.revenue_cents + c.shipping_charged_cents) / grossAll) * 100).toFixed(0)}%</td></tr>`)}
          </tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Expenses by category</h2><a class="hint" href="#/expenses">All expenses</a></div>
        ${d.expensesByCategory.length ? d.expensesByCategory.map((e) => html`
          <div class="hbar" title="${e.category}: ${money(e.cents)}"><span class="lbl">${e.category}</span>
            <span class="track"><span class="fill" style="display:block;width:${(e.cents / maxExp) * 100}%"></span></span>
            <span class="num">${money(e.cents)}</span></div>`) : html`<div class="empty">No expenses in this range.</div>`}
      </div>
    </div>

    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h2>Inventory</h2><a class="hint" href="#/inventory">Open inventory</a></div>
        ${inv.stale ? html`<div class="alert"><span>⚠</span><span><strong>${inv.stale} sold-out ${inv.stale === 1 ? 'book is' : 'books are'} still marked as listed.</strong> End those listings so nothing sells twice. <a href="#/inventory?status=stale" data-stale>Review</a></span></div>` : ''}
        <div class="grid kpis" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
          <div class="tile"><div class="label">Books in stock</div><div class="value">${inv.units}</div><div class="foot">${inv.titles} titles</div></div>
          <div class="tile"><div class="label">Cost value</div><div class="value">${money(inv.cost_value_cents)}</div><div class="foot">what you paid</div></div>
          <div class="tile"><div class="label">List value</div><div class="value">${money(inv.list_value_cents)}</div><div class="foot">at asking prices</div></div>
        </div>
        <div class="chips" style="margin-top:14px">
          ${LISTING_CHANNELS.map((k) => html`<span class="pill"><span class="dot" style="background:${CHANNELS[k].color}"></span>${CHANNELS[k].label}: ${inv[k]} listed</span>`)}
          <span class="pill ${inv.unlisted ? 'warn' : ''}">Not listed anywhere: ${inv.unlisted}</span>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Recent sales</h2><a class="hint" href="#/sales">All sales</a></div>
        <div class="table-wrap"><table><tbody>
          ${d.recentSales.length ? d.recentSales.map((s) => html`<tr>
            <td class="nowrap muted">${prettyDate(s.sale_date)}</td>
            <td class="title-cell"><div class="t">${s.title}</div></td>
            <td>${channelChip(s.channel)}</td>
            <td class="num">${money(s.sale_price_cents + s.shipping_charged_cents)}</td></tr>`) : html`<tr><td class="empty">No sales recorded yet.</td></tr>`}
        </tbody></table></div>
      </div>
    </div>`.s;

  bindRange(main, () => pageDashboard(main));
  bindSheetBanner(main, () => pageDashboard(main));
  $('[data-stale]', main)?.addEventListener('click', () => { invState.status = 'stale'; });
  weeklyChart($('#weekly-chart', main), d.weeks);
}

/** Stacked weekly bars by channel, with legend, hover tooltip and a table view. */
function weeklyChart(el, weeks) {
  const keys = Object.keys(CHANNELS).filter((k) => k !== 'other' || weeks.some((w) => w.other > 0));
  const totals = weeks.map((w) => keys.reduce((s, k) => s + w[k], 0));
  const max = Math.max(...totals, 0);
  if (!max) {
    el.innerHTML = '<div class="empty">No sales in this range yet.</div>';
    return;
  }
  const W = 640; const H = 240; const L = 48; const R = 8; const T = 10; const B = 26;
  const step = Math.pow(10, Math.floor(Math.log10(max / 4)));
  const tick = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= 5);
  const top = Math.ceil(max / tick) * tick;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const band = (W - L - R) / weeks.length;
  const bw = Math.min(44, band * 0.62);
  const GAP = 2;
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += tick) {
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }
  const labelEvery = Math.ceil(weeks.length / 8);
  weeks.forEach((w, i) => {
    const x = L + band * i + (band - bw) / 2;
    let acc = 0;
    const segs = keys.filter((k) => w[k] > 0);
    let bars = '';
    segs.forEach((k, j) => {
      const y0 = y(acc); const y1 = y(acc + w[k]);
      acc += w[k];
      const isTop = j === segs.length - 1;
      const h = Math.max(0, y0 - y1 - (j > 0 ? GAP : 0));
      const yTop = y1;
      if (isTop) {
        const r = Math.min(4, h / 2, bw / 2);
        bars += `<path fill="${CHANNELS[k].color}" d="M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${yTop + h} Z"/>`;
      } else {
        bars += `<rect fill="${CHANNELS[k].color}" x="${x}" y="${yTop}" width="${bw}" height="${h}"/>`;
      }
    });
    svg += `<g class="col" data-i="${i}"><rect class="hit" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>${bars}</g>`;
    if (i % labelEvery === 0) svg += `<text class="axis-label" x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(prettyDate(w.week))}</text>`;
  });
  el.innerHTML = html`
    <div class="legend">${keys.map((k) => html`<span><span class="dot" style="background:${CHANNELS[k].color}"></span>${CHANNELS[k].label}</span>`)}</div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly sales by channel">${new Safe(svg)}</svg><div class="tooltip"></div></div>
    <details class="table-toggle"><summary>Show as table</summary>
      <div class="table-wrap"><table><thead><tr><th>Week of</th>${keys.map((k) => html`<th class="num">${CHANNELS[k].label}</th>`)}<th class="num">Total</th></tr></thead>
      <tbody>${weeks.map((w, i) => html`<tr><td>${prettyDate(w.week)}</td>${keys.map((k) => html`<td class="num">${money(w[k])}</td>`)}<td class="num">${money(totals[i])}</td></tr>`)}</tbody></table></div>
    </details>`.s;
  const chart = $('.chart', el);
  const tip = $('.tooltip', el);
  $$('g.col', el).forEach((g) => {
    g.addEventListener('mouseenter', () => {
      const i = +g.dataset.i; const w = weeks[i];
      tip.innerHTML = html`<div class="tt-head">Week of ${prettyDate(w.week, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        ${[...keys].reverse().map((k) => html`<div class="tt-row"><span class="row" style="gap:6px"><span class="dot" style="background:${CHANNELS[k].color}"></span>${CHANNELS[k].label}</span><b>${money(w[k])}</b></div>`)}
        <div class="tt-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Total</span><b>${money(totals[i])}</b></div>`.s;
      tip.style.display = 'block';
      const box = chart.getBoundingClientRect();
      const gb = g.getBoundingClientRect();
      let left = gb.left - box.left + gb.width / 2 + 12;
      if (left + tip.offsetWidth > box.width) left = gb.left - box.left + gb.width / 2 - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = '10px';
      $$('g.col', el).forEach((o) => { o.style.opacity = o === g ? 1 : 0.45; });
    });
    g.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      $$('g.col', el).forEach((o) => { o.style.opacity = 1; });
    });
  });
}

// ---- time clock ----------------------------------------------------------------------------

async function pageClock(main) {
  const d = await api('/time/me');
  const open = d.open;
  main.innerHTML = html`
    <div class="page-head"><div><h1>Time Clock</h1><div class="sub">Hi ${state.user.name.split(' ')[0]} — week of ${prettyDate(d.week.from)} – ${prettyDate(d.week.to)}</div></div></div>
    <div class="grid two">
      <div class="card clock-card">
        <div class="clock-now" id="clock-now"></div>
        <div class="clock-status">${open
          ? html`<span class="pill good">● Clocked in since ${prettyTime(open.clock_in)}${open.clock_in.slice(0, 10) !== today() ? ` on ${prettyDate(open.clock_in)}` : ''}</span><div style="margin-top:8px" id="elapsed"></div>`
          : html`<span class="pill">You're clocked out</span>`}</div>
        ${open
          ? html`<button class="btn big" id="clock-out">Clock out</button>`
          : html`<button class="btn primary big" id="clock-in">Clock in</button>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>This week</h2><span class="hint">completed shifts</span></div>
        <div class="grid kpis" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px">
          <div class="tile"><div class="label">Hours</div><div class="value">${hrs(d.totals.total_hours)}</div></div>
          <div class="tile"><div class="label">Overtime</div><div class="value">${hrs(d.totals.overtime_hours)}</div></div>
          <div class="tile"><div class="label">Est. pay</div><div class="value">${money(d.totals.gross_cents)}</div><div class="foot">at ${money(d.rate_cents)}/hr, before taxes</div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>My shifts this week</h2><span class="hint">Ask the owner to fix a mistake</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Day</th><th>In</th><th>Out</th><th class="num">Break</th><th class="num">Hours</th><th>Notes</th></tr></thead>
        <tbody>${d.entries.length ? d.entries.map((e) => html`<tr>
          <td>${prettyDate(e.clock_in, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
          <td>${prettyTime(e.clock_in)}</td><td>${e.clock_out ? prettyTime(e.clock_out) : html`<span class="pill good">now</span>`}</td>
          <td class="num">${e.break_minutes ? `${e.break_minutes} min` : '—'}</td>
          <td class="num">${e.clock_out ? hrs(e.hours) : '—'}</td>
          <td class="small muted">${e.notes}${e.edited_by_owner ? html` <span class="pill">edited by owner</span>` : ''}</td></tr>`) : html`<tr><td colspan="6" class="empty">No shifts yet this week.</td></tr>`}
        </tbody></table></div>
    </div>`.s;

  const tickClock = () => {
    const el = $('#clock-now');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const ela = $('#elapsed');
    if (ela && open) {
      const [a, b] = [open.clock_in, nowLocal()].map((s) => Date.UTC(...s.slice(0, 10).split('-').map((n, i) => (i === 1 ? n - 1 : +n)), +s.slice(11, 13), +s.slice(14, 16)));
      const m = Math.max(0, Math.round((b - a) / 60000));
      ela.textContent = `${Math.floor(m / 60)}h ${pad(m % 60)}m on this shift`;
    }
  };
  tickClock();
  timers.push(setInterval(tickClock, 15000));

  $('#clock-in')?.addEventListener('click', async () => {
    try {
      await api('/time/clock-in', { method: 'POST' });
      toast('Clocked in. Have a good shift!');
      pageClock(main);
    } catch (err) { toast(err.message, true); }
  });
  $('#clock-out')?.addEventListener('click', () => openModal({
    title: 'Clock out',
    body: html`
      <label class="field">Unpaid break taken (minutes)<input name="break_minutes" type="number" min="0" max="1440" step="1" value="0" inputmode="numeric"></label>
      <label class="field">What did you work on? (optional)<textarea name="notes" placeholder="e.g. Listed 30 books, packed eBay orders"></textarea></label>`,
    submitLabel: 'Clock out',
    onSubmit: async (v) => {
      await api('/time/clock-out', { method: 'POST', body: { break_minutes: Number(v.break_minutes || 0), notes: v.notes } });
      toast('Clocked out. Thanks!');
      pageClock(main);
    },
  }));
}

// ---- inventory --------------------------------------------------------------------------

const invState = { status: 'active', channel: '', q: '' };

async function pageInventory(main) {
  const hashStatus = new URLSearchParams(location.hash.split('?')[1] || '').get('status');
  if (hashStatus) { invState.status = hashStatus; history.replaceState(null, '', '#/inventory'); }
  const params = new URLSearchParams({ status: invState.status, channel: invState.channel, q: invState.q });
  const { books, counts } = await api(`/books?${params}`);
  const owner = isOwner();
  const statusTabs = [['active', 'In stock'], ['soldout', 'Sold out'], ['stale', 'Needs delisting'], ['archived', 'Archived'], ['all', 'All']];
  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Inventory</h1><div class="sub">${counts.active || 0} titles in stock</div></div>
      <div class="row">
        ${owner ? html`<a class="btn" href="/api/export/books.csv">Export CSV</a>` : ''}
        ${sheetLinked('inventory') ? '' : html`<button class="btn primary" id="add-book">+ Add book</button>`}
      </div>
    </div>
    ${sheetBanner('inventory')}
    ${counts.stale ? html`<div class="alert"><span>⚠</span><span><strong>${counts.stale} sold-out ${counts.stale === 1 ? 'book is' : 'books are'} still marked as listed</strong> on eBay, Whatnot or Amazon. End those listings, then ${sheetLinked('inventory') ? 'update the sheet' : 'uncheck them here'}, so nothing sells twice.</span></div>` : ''}
    <div class="toolbar">
      <input type="search" id="inv-q" placeholder="Search title, author, SKU, ISBN, shelf…" value="${invState.q}" aria-label="Search inventory">
      <div class="seg" role="group" aria-label="Stock status">${statusTabs.map(([k, l]) => html`<button type="button" data-status="${k}" aria-pressed="${invState.status === k}">${l}${k !== 'all' ? html`<span class="count">${counts[k] || 0}</span>` : ''}</button>`)}</div>
      <select id="inv-ch" aria-label="Channel">
        <option value="">All channels</option>
        ${LISTING_CHANNELS.map((k) => html`<option value="${k}" ${invState.channel === k ? 'selected' : ''}>Listed on ${CHANNELS[k].label}</option>`)}
        <option value="unlisted" ${invState.channel === 'unlisted' ? 'selected' : ''}>Not listed anywhere</option>
      </select>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>SKU</th><th>Book</th><th>Condition</th><th>Shelf</th><th class="num">Qty</th>${owner ? html`<th class="num">Cost</th>` : ''}<th class="num">Price</th><th>Listed on</th><th></th></tr></thead>
        <tbody>${books.length ? books.map((b) => html`<tr class="clickable" data-id="${b.id}">
          <td class="nowrap small">${b.sku}</td>
          <td class="title-cell"><div class="t">${b.title}</div><div class="s">${[b.author, b.edition, b.pub_year].filter(Boolean).join(' · ')}</div></td>
          <td class="small">${b.condition}${b.binding ? html`<div class="muted">${b.binding}</div>` : ''}</td>
          <td class="small">${b.location}</td>
          <td class="num">${b.quantity === 0 ? html`<span class="pill bad">0</span>` : b.quantity}</td>
          ${owner ? html`<td class="num">${money(b.cost_cents)}</td>` : ''}
          <td class="num">${money(b.list_price_cents)}</td>
          <td><div class="chips">${LISTING_CHANNELS.filter((k) => b[`${k}_listed`]).map((k) => channelChip(k))}${b.archived ? html`<span class="pill">archived</span>` : ''}</div></td>
          <td class="num">${b.quantity > 0 && !b.archived && !sheetLinked('sales') ? html`<button class="btn small" data-sell="${b.id}">Sell</button>` : ''}</td>
        </tr>`) : html`<tr><td colspan="9" class="empty">${invState.q ? 'No books match your search.' : 'Nothing here yet.'}</td></tr>`}
        </tbody></table></div>
    </div>`.s;

  const reload = () => pageInventory(main);
  const q = $('#inv-q');
  let qTimer;
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(async () => {
      invState.q = q.value;
      const pos = q.selectionStart;
      await reload();
      const nq = $('#inv-q');
      nq.focus();
      nq.setSelectionRange(pos, pos);
    }, 250);
  });
  $$('[data-status]', main).forEach((b) => b.addEventListener('click', () => { invState.status = b.dataset.status; reload(); }));
  $('#inv-ch').addEventListener('change', (e) => { invState.channel = e.target.value; reload(); });
  $('#add-book')?.addEventListener('click', async () => bookModal(null, reload));
  bindSheetBanner(main, reload);
  const byId = new Map(books.map((b) => [String(b.id), b]));
  $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-sell]')) return;
    bookModal(byId.get(tr.dataset.id), reload);
  }));
  $$('[data-sell]', main).forEach((b) => b.addEventListener('click', () => saleModal({ book: byId.get(b.dataset.sell), onDone: reload })));
}

async function bookModal(book, onDone) {
  const isNew = !book;
  const b = book || { sku: (await api('/books/next-sku')).sku, quantity: 1, acquired_date: today() };
  const owner = isOwner();
  const readOnly = b.origin === 'sheet';
  openModal({
    title: readOnly ? `${b.sku} — from Google Sheets` : isNew ? 'Add book' : `Edit ${b.sku}`,
    submitLabel: readOnly ? null : 'Save',
    readOnly,
    wide: true,
    body: html`
      <div class="form-grid">
        <label class="field wide">Title<input name="title" value="${b.title || ''}" required></label>
        <label class="field">Author<input name="author" value="${b.author || ''}"></label>
        <label class="field">SKU<input name="sku" value="${b.sku}" required></label>
        <label class="field">ISBN<input name="isbn" value="${b.isbn || ''}" inputmode="numeric"></label>
        <label class="field">Publisher<input name="publisher" value="${b.publisher || ''}"></label>
        <label class="field">Year<input name="pub_year" value="${b.pub_year || ''}" inputmode="numeric"></label>
        <label class="field">Edition / printing<input name="edition" value="${b.edition || ''}" placeholder="e.g. 1st Edition, 1st Printing"></label>
        <label class="field">Binding<input name="binding" value="${b.binding || ''}" list="bindings"></label>
        <label class="field">Condition<input name="condition" value="${b.condition || ''}" list="conditions"></label>
        <label class="field">Shelf / location<input name="location" value="${b.location || ''}"></label>
        <label class="field">Quantity<input name="quantity" type="number" min="0" step="1" value="${b.quantity}"></label>
        <label class="field">Cost (what you paid)<input name="cost" inputmode="decimal" value="${centsInput(b.cost_cents)}" placeholder="0.00"></label>
        <label class="field">List price<input name="list_price" inputmode="decimal" value="${centsInput(b.list_price_cents)}" placeholder="0.00"></label>
        <label class="field">Acquired<input name="acquired_date" type="date" value="${b.acquired_date || ''}"></label>
        <label class="field">Source<input name="source" value="${b.source || ''}" placeholder="Estate sale, library sale…"></label>
        <fieldset class="wide"><legend>Where it's listed</legend>
          ${LISTING_CHANNELS.map((k) => html`<div class="channel-row">
            <label class="check"><input type="checkbox" name="${k}_listed" ${b[`${k}_listed`] ? 'checked' : ''}> <span class="dot" style="background:${CHANNELS[k].color}"></span>${CHANNELS[k].label}</label>
            <input name="${k}_ref" value="${b[`${k}_ref`] || ''}" placeholder="${k === 'amazon' ? 'Seller SKU / ASIN' : 'Listing ID or link'}" aria-label="${CHANNELS[k].label} listing reference">
          </div>`)}
        </fieldset>
        <label class="field wide">Description<textarea name="description">${b.description || ''}</textarea></label>
        <label class="field wide">Private notes<textarea name="notes">${b.notes || ''}</textarea></label>
        ${!isNew ? html`<label class="check wide"><input type="checkbox" name="archived" ${b.archived ? 'checked' : ''}> Archived (hidden from stock lists)</label>` : ''}
      </div>
      <datalist id="conditions">${['As New', 'Fine', 'Near Fine', 'Very Good', 'Good', 'Fair', 'Poor'].map((c) => html`<option value="${c}">`)}</datalist>
      <datalist id="bindings">${['Hardcover', 'Hardcover w/ DJ', 'Paperback', 'Mass Market', 'Leather', 'Signed'].map((c) => html`<option value="${c}">`)}</datalist>`,
    extra: html`${!isNew && owner && !readOnly ? html`<button type="button" class="btn danger" id="del-book">Delete</button>` : ''}
      ${readOnly ? html`<span class="muted small">Row ${b.sheet_row} of your sheet — edit it there.</span>` : ''}
      ${!isNew && b.quantity > 0 && !b.archived && !sheetLinked('sales') ? html`<button type="button" class="btn" id="sell-book">Record sale</button>` : ''}`,
    onSubmit: async (v) => {
      const body = { ...v, cost_cents: toCents(v.cost), list_price_cents: toCents(v.list_price) };
      for (const k of LISTING_CHANNELS) body[`${k}_listed`] = !!v[`${k}_listed`];
      body.archived = !!v.archived;
      if (isNew) await api('/books', { method: 'POST', body });
      else await api(`/books/${b.id}`, { method: 'PUT', body });
      toast(isNew ? 'Book added' : 'Book saved');
      onDone?.();
    },
    onOpen: (form, dlg) => {
      $('#del-book', form)?.addEventListener('click', async () => {
        dlg.close();
        if (!(await confirmModal('Delete book?', `Delete "${b.title}"? If it has sales, it will be archived instead so your sales history stays intact.`, 'Delete'))) return;
        const r = await api(`/books/${b.id}`, { method: 'DELETE' });
        toast(r.archived ? 'Book has sales history, so it was archived' : 'Book deleted');
        onDone?.();
      });
      $('#sell-book', form)?.addEventListener('click', () => { dlg.close(); saleModal({ book: b, onDone }); });
    },
  });
}

// ---- sales ------------------------------------------------------------------------------

async function saleModal({ book = null, sale = null, onDone }) {
  const isEdit = !!sale;
  let books = [];
  if (!book && !isEdit) books = (await api('/books?status=active')).books;
  const s = sale || {
    channel: 'ebay', sale_date: today(), quantity: 1, sale_price_cents: book?.list_price_cents || 0,
  };
  openModal({
    title: isEdit ? 'Edit sale' : book ? `Sell “${book.title}”` : 'Record a sale',
    body: html`
      <div class="form-grid">
        ${!book && !isEdit ? html`<label class="field wide">Book
          <select name="book_id"><option value="">— Not in inventory (type a title below) —</option>
          ${books.map((b) => html`<option value="${b.id}" data-price="${b.list_price_cents}" data-cost="${b.cost_cents}">${b.sku} — ${b.title}${b.author ? ` (${b.author})` : ''}</option>`)}</select></label>
          <label class="field wide" id="title-field">Title (if not in inventory)<input name="title"></label>` : ''}
        ${isEdit && !sale.book_id ? html`<label class="field wide">Title<input name="title" value="${sale.title}" required></label>` : ''}
        ${isEdit && sale.book_id ? html`<div class="wide"><strong>${sale.title}</strong> <span class="muted small">· qty ${sale.quantity}</span></div>` : ''}
        <label class="field">Sold on<select name="channel">${Object.entries(CHANNELS).map(([k, c]) => html`<option value="${k}" ${s.channel === k ? 'selected' : ''}>${c.label}</option>`)}</select></label>
        <label class="field">Date<input type="date" name="sale_date" value="${s.sale_date}" required></label>
        ${!isEdit ? html`<label class="field">Quantity<input type="number" name="quantity" min="1" step="1" value="1" max="${book ? book.quantity : ''}"></label>` : ''}
        <label class="field">Item price<input name="sale_price" inputmode="decimal" value="${centsInput(s.sale_price_cents)}" placeholder="0.00" required></label>
        <label class="field">Shipping charged to buyer<input name="shipping_charged" inputmode="decimal" value="${centsInput(s.shipping_charged_cents)}" placeholder="0.00"></label>
        <label class="field">Platform fees<input name="platform_fees" inputmode="decimal" value="${centsInput(s.platform_fees_cents)}" placeholder="0.00"></label>
        <label class="field">Postage you paid<input name="shipping_cost" inputmode="decimal" value="${centsInput(s.shipping_cost_cents)}" placeholder="0.00"></label>
        ${isEdit || (!book && !isEdit) ? html`<label class="field" id="cost-field">Cost of book${!isEdit ? ' (if not in inventory)' : ''}<input name="cost" inputmode="decimal" value="${centsInput(s.cost_cents)}" placeholder="0.00"></label>` : ''}
        <label class="field">Order # / reference<input name="order_ref" value="${s.order_ref || ''}"></label>
        <label class="field wide">Notes<textarea name="notes">${s.notes || ''}</textarea></label>
      </div>
      <div class="muted small" id="sale-net"></div>`,
    extra: isEdit ? html`<button type="button" class="btn danger" id="del-sale">Delete sale</button>` : '',
    onSubmit: async (v) => {
      const body = {
        channel: v.channel, sale_date: v.sale_date, order_ref: v.order_ref, notes: v.notes,
        sale_price_cents: toCents(v.sale_price), shipping_charged_cents: toCents(v.shipping_charged),
        platform_fees_cents: toCents(v.platform_fees), shipping_cost_cents: toCents(v.shipping_cost),
      };
      if (v.title !== undefined) body.title = v.title;
      if (v.cost !== undefined) body.cost_cents = toCents(v.cost);
      if (isEdit) {
        await api(`/sales/${sale.id}`, { method: 'PUT', body });
        toast('Sale updated');
        return onDone?.();
      }
      body.quantity = Number(v.quantity || 1);
      body.book_id = book ? book.id : v.book_id ? Number(v.book_id) : null;
      const r = await api('/sales', { method: 'POST', body });
      toast('Sale recorded');
      onDone?.();
      if (r.stillListed?.length) {
        if (sheetLinked('inventory')) toast(`Last copy sold — end the ${r.stillListed.map((c) => CHANNELS[c].label).join(', ')} listing and set its quantity to 0 in your sheet.`);
        else delistPrompt(r.sale.book_id, r.stillListed, onDone);
      }
    },
    onOpen: (form, dlg) => {
      const net = () => {
        const v = Object.fromEntries(new FormData(form));
        const qty = Number(v.quantity || 1);
        const picked = $('select[name=book_id]', form)?.selectedOptions[0];
        const unitCost = book?.cost_cents ?? Number(picked?.dataset.cost || 0);
        const cost = v.cost !== undefined && (isEdit || !v.book_id) ? toCents(v.cost) : unitCost * qty;
        const n = toCents(v.sale_price) + toCents(v.shipping_charged) - toCents(v.platform_fees) - toCents(v.shipping_cost) - cost;
        if (isOwner()) $('#sale-net', form).textContent = `Profit on this sale: ${money(n)}`;
      };
      form.addEventListener('input', net);
      net();
      const sel = $('select[name=book_id]', form);
      sel?.addEventListener('change', () => {
        const opt = sel.selectedOptions[0];
        const inInv = !!sel.value;
        $('#title-field', form).hidden = inInv;
        $('#cost-field', form).hidden = inInv;
        if (inInv && !$('input[name=sale_price]', form).value) $('input[name=sale_price]', form).value = centsInput(Number(opt.dataset.price));
        net();
      });
      $('#del-sale', form)?.addEventListener('click', async () => {
        dlg.close();
        if (!(await confirmModal('Delete sale?', sale.book_id ? 'The book will be put back into stock.' : 'This removes the sale record.', 'Delete sale'))) return;
        await api(`/sales/${sale.id}`, { method: 'DELETE' });
        toast('Sale deleted');
        onDone?.();
      });
    },
  });
}

async function delistPrompt(bookId, channels, onDone) {
  const names = channels.map((c) => CHANNELS[c].label).join(', ');
  const ok = await confirmModal('Last copy sold — end other listings',
    `That was the last copy, but it's still marked as listed on ${names}. End those listings on the sites now so it can't sell twice, then mark it delisted here.`,
    'I ended them — mark delisted');
  if (!ok) return;
  const { book } = await api(`/books/${bookId}`);
  const body = { ...book };
  for (const k of LISTING_CHANNELS) body[`${k}_listed`] = false;
  await api(`/books/${bookId}`, { method: 'PUT', body });
  toast('Marked as delisted');
  onDone?.();
}

const salesState = { channel: '' };

async function pageSales(main) {
  const r = currentRange();
  const q = new URLSearchParams({ ...r, channel: salesState.channel });
  const { sales } = await api(`/sales?${q}`);
  const net = (s) => s.sale_price_cents + s.shipping_charged_cents - s.platform_fees_cents - s.shipping_cost_cents - s.cost_cents;
  const sum = (f) => sales.reduce((t, s) => t + f(s), 0);
  const gross = sum((s) => s.sale_price_cents + s.shipping_charged_cents);
  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Sales</h1><div class="sub">${rangeLabel(r)}</div></div>
      <div class="row"><a class="btn" href="/api/export/sales.csv?from=${r.from}&to=${r.to}">Export CSV</a>${sheetLinked('sales') ? '' : html`<button class="btn primary" id="add-sale">+ Record sale</button>`}</div>
    </div>
    ${sheetBanner('sales')}
    <div class="toolbar">${rangeControls()}
      <select id="sale-ch" aria-label="Channel"><option value="">All channels</option>${Object.entries(CHANNELS).map(([k, c]) => html`<option value="${k}" ${salesState.channel === k ? 'selected' : ''}>${c.label}</option>`)}</select>
    </div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="card tile"><div class="label">Gross sales</div><div class="value">${money(gross)}</div><div class="foot">${sales.length} orders</div></div>
      <div class="card tile"><div class="label">Fees + postage</div><div class="value">${money(sum((s) => s.platform_fees_cents + s.shipping_cost_cents))}</div></div>
      <div class="card tile"><div class="label">Cost of books</div><div class="value">${money(sum((s) => s.cost_cents))}</div></div>
      <div class="card tile"><div class="label">Profit on sales</div><div class="value">${money(sum(net))}</div><div class="foot">${gross ? `${((sum(net) / gross) * 100).toFixed(0)}% margin` : ''}</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Channel</th><th>Book</th><th class="num">Price</th><th class="num">Ship chg.</th><th class="num">Fees</th><th class="num">Postage</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
      <tbody>${sales.length ? sales.map((s) => html`<tr class="clickable" data-id="${s.id}">
        <td class="nowrap">${prettyDate(s.sale_date)}</td><td>${channelChip(s.channel)}</td>
        <td class="title-cell"><div class="t">${s.title}${s.quantity > 1 ? ` ×${s.quantity}` : ''}</div><div class="s">${[s.sku, s.order_ref, s.created_by_name && `by ${s.created_by_name}`, s.origin === 'sheet' && `sheet row ${s.sheet_row}`].filter(Boolean).join(' · ')}</div></td>
        <td class="num">${money(s.sale_price_cents)}</td><td class="num">${money(s.shipping_charged_cents)}</td>
        <td class="num">${money(s.platform_fees_cents)}</td><td class="num">${money(s.shipping_cost_cents)}</td>
        <td class="num">${money(s.cost_cents)}</td><td class="num ${net(s) < 0 ? 'neg' : ''}"><strong>${money(net(s))}</strong></td></tr>`) : html`<tr><td colspan="9" class="empty">No sales in this range.</td></tr>`}
      </tbody></table></div></div>`.s;
  const reload = () => pageSales(main);
  bindRange(main, reload);
  $('#sale-ch').addEventListener('change', (e) => { salesState.channel = e.target.value; reload(); });
  $('#add-sale')?.addEventListener('click', () => saleModal({ onDone: reload }));
  bindSheetBanner(main, reload);
  const byId = new Map(sales.map((s) => [String(s.id), s]));
  $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => {
    const sale = byId.get(tr.dataset.id);
    if (sale.origin === 'sheet') fromSheetToast(sale);
    else saleModal({ sale, onDone: reload });
  }));
}

// ---- expenses ---------------------------------------------------------------------------

async function pageExpenses(main) {
  const r = currentRange();
  const [{ expenses }, { categories }] = await Promise.all([api(`/expenses?from=${r.from}&to=${r.to}`), api('/expense-categories')]);
  const total = expenses.reduce((t, e) => t + e.amount_cents, 0);
  const byCat = {};
  expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount_cents; });
  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Expenses</h1><div class="sub">${rangeLabel(r)} · ${money(total)} total</div></div>
      <div class="row"><a class="btn" href="/api/export/expenses.csv?from=${r.from}&to=${r.to}">Export CSV</a>${sheetLinked('expenses') ? '' : html`<button class="btn primary" id="add-exp">+ Add expense</button>`}</div>
    </div>
    ${sheetBanner('expenses')}
    <div class="toolbar">${rangeControls()}</div>
    <div class="chips" style="margin-bottom:14px">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => html`<span class="pill">${c}: ${money(v)}</span>`)}</div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th>Notes</th><th class="num">Amount</th></tr></thead>
      <tbody>${expenses.length ? expenses.map((e) => html`<tr class="clickable" data-id="${e.id}">
        <td class="nowrap">${prettyDate(e.expense_date)}</td><td>${e.category}</td><td>${e.vendor}</td><td class="small muted">${e.notes}</td><td class="num">${money(e.amount_cents)}</td></tr>`)
        : html`<tr><td colspan="5" class="empty">No expenses in this range.</td></tr>`}</tbody>
      ${expenses.length ? html`<tfoot><tr><td colspan="4">Total</td><td class="num">${money(total)}</td></tr></tfoot>` : ''}
    </table></div></div>
    <p class="muted small">Employee pay is calculated from the time clock automatically — don't enter it here.</p>`.s;
  const reload = () => pageExpenses(main);
  bindRange(main, reload);
  const modal = (e) => {
    const isNew = !e;
    const x = e || { expense_date: today(), category: categories[0] };
    const cats = categories.includes(x.category) ? categories : [...categories, x.category];
    openModal({
      title: isNew ? 'Add expense' : 'Edit expense',
      body: html`<div class="form-grid">
        <label class="field">Date<input type="date" name="expense_date" value="${x.expense_date}" required></label>
        <label class="field">Category<select name="category">${cats.map((c) => html`<option ${c === x.category ? 'selected' : ''}>${c}</option>`)}</select></label>
        <label class="field">Amount<input name="amount" inputmode="decimal" value="${centsInput(x.amount_cents)}" placeholder="0.00" required></label>
        <label class="field">Vendor / paid to<input name="vendor" value="${x.vendor || ''}"></label>
        <label class="field wide">Notes<textarea name="notes">${x.notes || ''}</textarea></label></div>`,
      extra: !isNew ? html`<button type="button" class="btn danger" id="del-exp">Delete</button>` : '',
      onSubmit: async (v) => {
        if (!(toCents(v.amount) > 0)) throw new Error('Enter an amount');
        const body = { ...v, amount_cents: toCents(v.amount) };
        if (isNew) await api('/expenses', { method: 'POST', body });
        else await api(`/expenses/${x.id}`, { method: 'PUT', body });
        toast(isNew ? 'Expense added' : 'Expense saved');
        reload();
      },
      onOpen: (form, dlg) => $('#del-exp', form)?.addEventListener('click', async () => {
        dlg.close();
        if (!(await confirmModal('Delete expense?', `Delete this ${money(x.amount_cents)} expense?`, 'Delete'))) return;
        await api(`/expenses/${x.id}`, { method: 'DELETE' });
        toast('Expense deleted');
        reload();
      }),
    });
  };
  $('#add-exp')?.addEventListener('click', () => modal(null));
  bindSheetBanner(main, reload);
  const byId = new Map(expenses.map((e) => [String(e.id), e]));
  $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => {
    const e = byId.get(tr.dataset.id);
    if (e.origin === 'sheet') fromSheetToast(e);
    else modal(e);
  }));
}

// ---- payroll ----------------------------------------------------------------------------

const payState = { week: null };

async function pagePayroll(main) {
  const p = await api(`/payroll?week=${payState.week || today()}`);
  payState.week = p.from;
  const [{ entries }, { users }] = await Promise.all([api(`/time/entries?from=${p.from}&to=${p.to}`), api('/users')]);
  const ot = p.settings;
  main.innerHTML = html`
    <div class="page-head">
      <div><h1>Hours &amp; Pay</h1><div class="sub">Week of ${prettyDate(p.from, { month: 'long', day: 'numeric', year: 'numeric' })} – ${prettyDate(p.to, { month: 'long', day: 'numeric' })}</div></div>
      <div class="row">
        <button class="btn" id="wk-prev" aria-label="Previous week">‹ Prev</button>
        <button class="btn" id="wk-this">This week</button>
        <button class="btn" id="wk-next" aria-label="Next week">Next ›</button>
        <a class="btn" href="/api/payroll.csv?week=${p.from}">Export CSV</a>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
    </div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="card tile"><div class="label">Total pay this week</div><div class="value">${money(p.totals.gross_cents)}</div><div class="foot">gross, before taxes</div></div>
      <div class="card tile"><div class="label">Hours worked</div><div class="value">${hrs(p.totals.total_hours)}</div></div>
      <div class="card tile"><div class="label">Overtime hours</div><div class="value">${hrs(p.totals.overtime_hours)}</div>
        <div class="foot">${ot.overtime_enabled ? `over ${ot.overtime_threshold_hours} hrs/week at ${ot.overtime_multiplier}×` : 'overtime is off'}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Weekly pay by employee</h2><span class="hint">completed shifts only</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th>${p.days.map((d) => html`<th class="num">${DOW[new Date(parseD(d)).getUTCDay()]}<div class="muted" style="text-transform:none;font-weight:400">${prettyDate(d)}</div></th>`)}
          <th class="num">Regular</th><th class="num">OT</th><th class="num">Rate</th><th class="num">Gross pay</th></tr></thead>
        <tbody>${p.rows.map((r) => html`<tr>
          <td class="nowrap">${r.name}${r.open_shift ? html` <span class="pill good">on clock</span>` : ''}${!r.active ? html` <span class="pill">inactive</span>` : ''}</td>
          ${p.days.map((d) => html`<td class="num ${r.days[d] ? '' : 'muted'}">${r.days[d] ? hrs(r.days[d]) : '—'}</td>`)}
          <td class="num">${hrs(r.regular_hours)}</td>
          <td class="num">${r.overtime_hours ? html`<span class="pill warn">${hrs(r.overtime_hours)}</span>` : '—'}</td>
          <td class="num">${money(r.hourly_rate_cents)}</td>
          <td class="num"><strong>${money(r.gross_cents)}</strong></td></tr>`)}
        </tbody>
        <tfoot><tr><td>Total</td>${p.days.map((d) => html`<td class="num">${hrs(p.rows.reduce((t, r) => t + (r.days[d] || 0), 0))}</td>`)}
          <td class="num">${hrs(p.rows.reduce((t, r) => t + r.regular_hours, 0))}</td><td class="num">${hrs(p.totals.overtime_hours)}</td><td></td><td class="num">${money(p.totals.gross_cents)}</td></tr></tfoot>
      </table></div>
      <p class="muted small" style="margin-bottom:0">Pay uses the rate in effect when each shift was worked; "Rate" shows the current rate.</p>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Shifts</h2><button class="btn small" id="add-entry">+ Add shift</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Day</th><th>In</th><th>Out</th><th class="num">Break</th><th class="num">Hours</th><th class="num">Rate</th><th>Notes</th></tr></thead>
        <tbody>${entries.length ? entries.map((e) => html`<tr class="clickable" data-id="${e.id}">
          <td>${e.name}</td><td class="nowrap">${prettyDate(e.clock_in, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
          <td>${prettyTime(e.clock_in)}</td><td>${e.clock_out ? `${prettyTime(e.clock_out)}${e.clock_out.slice(0, 10) !== e.clock_in.slice(0, 10) ? ` (${prettyDate(e.clock_out)})` : ''}` : html`<span class="pill good">on clock</span>`}</td>
          <td class="num">${e.break_minutes ? `${e.break_minutes}m` : '—'}</td><td class="num">${e.clock_out ? hrs(e.hours) : '—'}</td>
          <td class="num">${money(e.hourly_rate_cents)}</td>
          <td class="small muted">${e.notes}${e.edited_by_owner ? html` <span class="pill">edited</span>` : ''}</td></tr>`) : html`<tr><td colspan="8" class="empty">No shifts this week.</td></tr>`}
        </tbody></table></div>
    </div>`.s;
  const reload = () => pagePayroll(main);
  $('#wk-prev').addEventListener('click', () => { payState.week = addDays(p.from, -7); reload(); });
  $('#wk-next').addEventListener('click', () => { payState.week = addDays(p.from, 7); reload(); });
  $('#wk-this').addEventListener('click', () => { payState.week = null; reload(); });
  const byId = new Map(entries.map((e) => [String(e.id), e]));
  $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => entryModal(byId.get(tr.dataset.id), users, reload)));
  $('#add-entry').addEventListener('click', () => entryModal(null, users, reload, p.from));
}

function entryModal(e, users, onDone, weekFrom) {
  const isNew = !e;
  const day = weekFrom && today() > addDays(weekFrom, 6) ? weekFrom : today();
  const x = e || { clock_in: `${day}T09:00`, clock_out: `${day}T17:00`, break_minutes: 30, user_id: users.find((u) => u.active)?.id };
  openModal({
    title: isNew ? 'Add shift' : `Edit shift — ${e.name}`,
    body: html`<div class="form-grid">
      ${isNew ? html`<label class="field wide">Team member<select name="user_id">${users.filter((u) => u.active).map((u) => html`<option value="${u.id}" ${u.id === x.user_id ? 'selected' : ''}>${u.name} (${money(u.hourly_rate_cents)}/hr)</option>`)}</select></label>` : ''}
      <label class="field">Clock in<input type="datetime-local" name="clock_in" value="${x.clock_in}" required></label>
      <label class="field">Clock out<input type="datetime-local" name="clock_out" value="${x.clock_out || ''}"></label>
      <label class="field">Unpaid break (minutes)<input type="number" name="break_minutes" min="0" step="1" value="${x.break_minutes}"></label>
      <label class="field">Hourly rate for this shift<input name="rate" inputmode="decimal" value="${isNew ? '' : centsInput(x.hourly_rate_cents)}" placeholder="${isNew ? 'Their current rate' : ''}"></label>
      <label class="field wide">Notes<input name="notes" value="${x.notes || ''}"></label></div>
      <div class="muted small">Leave "Clock out" empty if they're still on the clock.</div>`,
    extra: !isNew ? html`<button type="button" class="btn danger" id="del-entry">Delete</button>` : '',
    onSubmit: async (v) => {
      const body = { clock_in: v.clock_in, clock_out: v.clock_out || null, break_minutes: Number(v.break_minutes || 0), notes: v.notes };
      if (v.rate) body.hourly_rate_cents = toCents(v.rate);
      if (isNew) await api('/time/entries', { method: 'POST', body: { ...body, user_id: Number(v.user_id) } });
      else await api(`/time/entries/${e.id}`, { method: 'PUT', body });
      toast(isNew ? 'Shift added' : 'Shift saved');
      onDone();
    },
    onOpen: (form, dlg) => $('#del-entry', form)?.addEventListener('click', async () => {
      dlg.close();
      if (!(await confirmModal('Delete shift?', `Delete ${e.name}'s shift on ${prettyDate(e.clock_in)}?`, 'Delete'))) return;
      await api(`/time/entries/${e.id}`, { method: 'DELETE' });
      toast('Shift deleted');
      onDone();
    }),
  });
}

// ---- team ------------------------------------------------------------------------------

async function pageTeam(main) {
  const { users } = await api('/users');
  main.innerHTML = html`
    <div class="page-head"><div><h1>Team</h1><div class="sub">Employees sign in with their own username to clock in and work on inventory.</div></div>
      <button class="btn primary" id="add-user">+ Add team member</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th class="num">Hourly rate</th><th>Status</th></tr></thead>
      <tbody>${users.map((u) => html`<tr class="clickable" data-id="${u.id}">
        <td><strong>${u.name}</strong></td><td>${u.username}</td><td>${u.role === 'owner' ? 'Owner' : 'Employee'}</td>
        <td class="num">${money(u.hourly_rate_cents)}/hr</td>
        <td>${!u.active ? html`<span class="pill">Inactive</span>` : u.clocked_in_since ? html`<span class="pill good">● On the clock</span>` : html`<span class="muted small">Active</span>`}</td></tr>`)}
      </tbody></table></div></div>
    ${users.length < 2 ? html`<p class="muted">Tip: add each employee here with their hourly rate. They can then sign in on any phone or computer and tap “Clock in”.</p>` : ''}`.s;
  const reload = () => pageTeam(main);
  const modal = (u) => {
    const isNew = !u;
    const x = u || { role: 'employee', active: 1, hourly_rate_cents: 0 };
    openModal({
      title: isNew ? 'Add team member' : `Edit ${u.name}`,
      body: html`<div class="form-grid">
        <label class="field">Full name<input name="name" value="${x.name || ''}" required></label>
        <label class="field">Username (for sign-in)<input name="username" value="${x.username || ''}" autocomplete="off" required></label>
        <label class="field">${isNew ? 'Password (8+ characters)' : 'Reset password (leave blank to keep)'}<input name="password" type="password" autocomplete="new-password" ${isNew ? 'required' : ''}></label>
        <label class="field">Hourly rate<input name="rate" inputmode="decimal" value="${centsInput(x.hourly_rate_cents)}" placeholder="0.00"></label>
        <label class="field">Role<select name="role"><option value="employee" ${x.role === 'employee' ? 'selected' : ''}>Employee — time clock &amp; inventory</option><option value="owner" ${x.role === 'owner' ? 'selected' : ''}>Owner — full access</option></select></label>
        ${!isNew ? html`<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Active (can sign in)</label>` : ''}
      </div>
      ${!isNew ? html`<div class="muted small">Changing the rate applies to new shifts (and a shift in progress). Past shifts keep the rate they were worked at.</div>` : ''}`,
      onSubmit: async (v) => {
        const body = { name: v.name, username: v.username, password: v.password, role: v.role, hourly_rate_cents: toCents(v.rate), active: isNew ? true : !!v.active };
        if (isNew) await api('/users', { method: 'POST', body });
        else await api(`/users/${u.id}`, { method: 'PUT', body });
        toast(isNew ? 'Team member added' : 'Saved');
        reload();
      },
    });
  };
  $('#add-user').addEventListener('click', () => modal(null));
  const byId = new Map(users.map((u) => [String(u.id), u]));
  $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => modal(byId.get(tr.dataset.id))));
}

// ---- settings ----------------------------------------------------------------------------

async function pageSettings(main) {
  const [{ settings: s }, sh] = await Promise.all([api('/settings'), api('/sheets')]);
  main.innerHTML = html`
    <div class="page-head"><div><h1>Settings</h1></div></div>
    ${sheetsCard(sh)}
    <form class="card stack" id="settings-form" style="max-width:640px">
      <label class="field">Business name<input name="business_name" value="${s.business_name}" required></label>
      <label class="field">Pay week starts on<select name="week_start">${DOW.map((d, i) => html`<option value="${i}" ${String(i) === s.week_start ? 'selected' : ''}>${d}</option>`)}</select></label>
      <fieldset><legend>Overtime</legend>
        <label class="check"><input type="checkbox" name="overtime_enabled" ${s.overtime_enabled === '1' ? 'checked' : ''}> Pay overtime</label>
        <div class="form-grid" style="margin-top:10px">
          <label class="field">After this many hours per week<input name="overtime_threshold_hours" type="number" min="1" max="168" step="0.5" value="${s.overtime_threshold_hours}"></label>
          <label class="field">Overtime multiplier<input name="overtime_multiplier" type="number" min="1" max="5" step="0.05" value="${s.overtime_multiplier}"></label>
        </div>
      </fieldset>
      <label class="field">Expense categories (comma separated)<textarea name="expense_categories">${s.expense_categories}</textarea></label>
      <div class="error" role="alert"></div>
      <div><button class="btn primary" type="submit">Save settings</button></div>
    </form>`.s;
  bindSheetsCard(main, () => pageSettings(main));
  const form = $('#settings-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    v.overtime_enabled = !!v.overtime_enabled;
    v.week_start = Number(v.week_start);
    try {
      const r = await api('/settings', { method: 'PUT', body: { settings: v } });
      state.businessName = r.settings.business_name;
      state.weekStart = Number(r.settings.week_start);
      $('#app').innerHTML = '';
      renderApp();
      toast('Settings saved');
    } catch (err) {
      $('.error', form).textContent = err.message;
    }
  });
}

function sheetsCard(sh) {
  const last = sh.last;
  const linkedAny = Object.values(sh.urls).some(Boolean);
  return html`
    <form class="card stack" id="sheets-form" style="max-width:860px;margin-bottom:16px">
      <div class="card-head" style="margin:0"><h2>Google Sheets</h2>
        <span class="hint">${linkedAny ? `Last synced ${timeAgo(last?.at)}` : 'Not connected'}</span></div>
      <p class="muted small" style="margin:0">Paste the link to each tab that holds your data. Open the tab in Google Sheets and copy the address bar, so the link ends in <code>#gid=…</code>.
        Linked sections are read from the sheet and can't be edited in the app. Leave a link blank to keep managing that section here.
        The first row of each tab must be column headings (for example <em>Title, Author, SKU, Qty, Cost, Price</em> · <em>Date, Platform, Title, Sale Price, Fees, Postage</em> · <em>Date, Category, Vendor, Amount</em>).</p>
      ${sh.serviceAccountEmail
        ? html`<div class="sheet-banner"><span class="sheet-icon" aria-hidden="true">🔒</span><span>Private access is set up. Share your sheet (Viewer) with <strong>${sh.serviceAccountEmail}</strong>.</span></div>`
        : sh.serviceAccountError
          ? html`<div class="alert"><span>⚠</span><span>${sh.serviceAccountError}</span></div>`
          : html`<div class="sheet-banner"><span class="sheet-icon" aria-hidden="true">🔗</span><span>The sheet must be shared as <strong>“Anyone with the link can view”</strong>. To keep it private instead, set up a Google service account (see the README).</span></div>`}
      ${SECTIONS_LIST.map((k) => html`<label class="field">${SECTION_LABEL[k]} tab link
        <input name="${k}" value="${sh.urls[k]}" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" inputmode="url"></label>
        ${last?.sections?.[k] ? syncResult(last.sections[k]) : ''}
        ${sh.appRows?.[k] ? html`<div class="alert" style="margin:0"><span>ⓘ</span><span>${sh.appRows[k]} ${k === 'inventory' ? 'books were' : `${k} were`} entered in the app before linking and still count alongside the sheet.
          If your sheet already has them, <button type="button" class="btn link small" data-clear="${k}">remove the app-entered ${k === 'inventory' ? 'books' : k}</button>.</span></div>` : ''}`)}
      <label class="field" style="max-width:260px">Sync automatically every
        <select name="autoMinutes">${[[0, 'Off (manual only)'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, 'hour'], [240, '4 hours']].map(([v, l]) => html`<option value="${v}" ${sh.autoMinutes === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      <div class="error" role="alert"></div>
      <div class="row"><button class="btn primary" type="submit">Save &amp; sync</button>
        ${linkedAny ? html`<button class="btn" type="button" data-sync>Sync now</button>` : ''}</div>
    </form>`;
}
const SECTIONS_LIST = ['inventory', 'sales', 'expenses'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function syncResult(r) {
  if (!r.ok) return html`<div class="alert" style="margin:0"><span>⚠</span><span><strong>Last sync failed:</strong> ${r.error}</span></div>`;
  return html`<details class="sync-result"><summary><span class="pill good">✓ ${plural(r.imported, 'row')} imported</span>
      ${r.skipped.count ? html` <span class="pill warn">${plural(r.skipped.count, 'row')} skipped</span>` : ''}${r.removed ? html` <span class="pill">${r.removed} removed from sheet</span>` : ''} <span class="small muted">details</span></summary>
    <div class="small" style="margin-top:6px"><strong>Columns used:</strong> ${Object.values(r.matched).join(', ')}</div>
    ${r.ignored.length ? html`<div class="small muted"><strong>Columns ignored:</strong> ${r.ignored.join(', ')}</div>` : ''}
    ${r.skipped.rows.map((x) => html`<div class="small">Row ${x.row}: ${x.reason}</div>`)}
    ${r.skipped.count > r.skipped.rows.length ? html`<div class="small muted">…and ${r.skipped.count - r.skipped.rows.length} more</div>` : ''}
  </details>`;
}

function bindSheetsCard(main, reload) {
  bindSheetBanner(main, reload);
  $$('[data-clear]', main).forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.clear;
    if (!(await confirmModal(`Remove app-entered ${k === 'inventory' ? 'books' : k}?`, `This permanently deletes the ${k === 'inventory' ? 'books' : k} that were typed into the app. Everything from your Google Sheet stays.`, 'Remove'))) return;
    const r = await api('/sheets/clear-app', { method: 'POST', body: { section: k } });
    toast(`Removed ${r.deleted}`);
    reload();
  }));
  const form = $('#sheets-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      await api('/sheets', { method: 'PUT', body: { urls: { inventory: v.inventory, sales: v.sales, expenses: v.expenses }, autoMinutes: Number(v.autoMinutes) } });
      await refreshStatus();
      if (SECTIONS_LIST.some((k) => v[k])) await runSync(reload, $('button[type=submit]', form));
      else { toast('Google Sheets disconnected'); reload(); }
    } catch (err) {
      $('.error', form).textContent = err.message;
    }
  });
}

boot().catch((err) => {
  $('#app').innerHTML = html`<div class="auth-wrap"><div class="card">Couldn't reach the server: ${err.message}</div></div>`.s;
});
