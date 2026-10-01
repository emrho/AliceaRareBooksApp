// Time and pay math. Timestamps are local wall-clock strings ('YYYY-MM-DDTHH:MM')
// and dates are 'YYYY-MM-DD'; everything is computed in UTC on those components so
// daylight-saving changes and the server's time zone never shift a shift.

const pad = (n) => String(n).padStart(2, '0');

export function nowLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayLocal(d = new Date()) {
  return nowLocal(d).slice(0, 10);
}

function parseWall(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(ts || '');
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDate(parseWall(s)) === s;
}

export function isValidTimestamp(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && isValidDate(s.slice(0, 10))
    && +s.slice(11, 13) < 24 && +s.slice(14, 16) < 60;
}

export function addDays(date, n) {
  return fmtDate(parseWall(date) + n * 86400000);
}

export function weekStartOf(date, weekStart = 1) {
  const dow = new Date(parseWall(date)).getUTCDay();
  return addDays(date, -((dow - weekStart + 7) % 7));
}

/** Worked hours for one entry (clock_out minus clock_in minus break), never negative. */
export function entryHours(entry, until) {
  const end = entry.clock_out || until;
  if (!end) return 0;
  const minutes = (parseWall(end) - parseWall(entry.clock_in)) / 60000 - (entry.break_minutes || 0);
  return Math.max(0, minutes) / 60;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pay for a set of completed entries. Entries are bucketed by the week their
 * clock-in falls in; within a week, hours past the overtime threshold are paid at
 * the entry's own rate times the multiplier.
 */
export function computePay(entries, settings) {
  const weekStart = Number(settings.week_start ?? 1);
  const otOn = settings.overtime_enabled === '1';
  const threshold = Number(settings.overtime_threshold_hours ?? 40);
  const mult = Number(settings.overtime_multiplier ?? 1.5);

  const byUser = new Map();
  const sorted = entries.filter((e) => e.clock_out).sort((a, b) => a.clock_in.localeCompare(b.clock_in));
  for (const e of sorted) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, { regular_hours: 0, overtime_hours: 0, gross_cents: 0, entries: 0, days: {}, weekHours: new Map() });
    const u = byUser.get(e.user_id);
    const hours = entryHours(e);
    const week = weekStartOf(e.clock_in.slice(0, 10), weekStart);
    const before = u.weekHours.get(week) || 0;
    const ot = otOn ? Math.max(0, before + hours - Math.max(threshold, before)) : 0;
    const reg = hours - ot;
    u.weekHours.set(week, before + hours);
    u.regular_hours += reg;
    u.overtime_hours += ot;
    u.gross_cents += reg * e.hourly_rate_cents + ot * e.hourly_rate_cents * mult;
    u.entries += 1;
    const day = e.clock_in.slice(0, 10);
    u.days[day] = (u.days[day] || 0) + hours;
  }
  const out = {};
  for (const [id, u] of byUser) {
    const days = {};
    for (const [d, h] of Object.entries(u.days)) days[d] = round2(h);
    out[id] = {
      regular_hours: round2(u.regular_hours),
      overtime_hours: round2(u.overtime_hours),
      total_hours: round2(u.regular_hours + u.overtime_hours),
      gross_cents: Math.round(u.gross_cents),
      entries: u.entries,
      days,
    };
  }
  return out;
}
