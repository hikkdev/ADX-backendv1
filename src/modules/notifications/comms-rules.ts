/**
 * The comms rules — Lot G (Q117).
 *
 * Two rules stand between a non-transactional message and the wire: quiet
 * hours (nothing promotional leaves at night) and a weekly cap (nobody hears
 * from ADX more than N times a week unless it is about their own account).
 * Transactional copy — an OTP, a payment, a decision — ignores both; the
 * template says which it is (`NotificationTemplate.transactional`).
 *
 * Both rules are pure functions of the clock and the settings so the tests
 * can pin the boundaries without a database: this file has no I/O.
 */

export interface QuietHours {
  /** `HH:mm`, 24-hour, in `tz`. */
  from: string;
  to: string;
  /** An IANA zone name. */
  tz: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function clockMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** The wall-clock minute of the day at `now` in `tz`; IST when the zone is unknown to the runtime. */
export function localMinutes(now: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  } catch {
    /* an unknown zone: fall through to IST, the platform's own */
  }
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * When a message raised at `now` may leave, under the quiet hours: null when
 * it may leave now, otherwise the instant the window ends. A window that
 * crosses midnight (`21:00` → `08:00`) is quiet from the evening through the
 * next morning; one that does not (`13:00` → `15:00`) is an afternoon. A
 * window whose two edges are the same is no window.
 *
 * The answer is `now` plus the minutes left in the window, cut to the whole
 * minute, so every message deferred in the same night is released together.
 */
export function quietHoursDeferral(now: Date, quiet: QuietHours): Date | null {
  const from = clockMinutes(quiet.from);
  const to = clockMinutes(quiet.to);
  if (from === to) return null;
  const local = localMinutes(now, quiet.tz);
  const crossesMidnight = from > to;
  const inside = crossesMidnight ? local >= from || local < to : local >= from && local < to;
  if (!inside) return null;
  const left = to > local ? to - local : to + 24 * 60 - local;
  const floored = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(floored + left * MINUTE_MS);
}

/**
 * The Indian week around an instant — `[Monday 00:00 IST, next Monday)` —
 * the window the weekly cap counts over. Sunday belongs to the week that
 * began the Monday before it.
 */
export function weekWindowIST(now: Date): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  // getUTCDay: Sunday 0 … Saturday 6; days since Monday is (day + 6) % 7.
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  const start = new Date(midnight - sinceMonday * DAY_MS - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/* ── the legacy deferral marker (one release) ────────────────────── */

/**
 * G10: a deferred row carries its instant in `NotificationDelivery.scheduledFor`
 * (the Lot G addendum's column). Before the column, the instant rode in
 * `lastError` under this prefix. The marker is no longer written; it is read
 * once more, by `foldLegacyDeferrals`, to move rows written before the
 * column onto it — and then this prefix and `readDeferral` go.
 */
export const DEFERRAL_MARKER = 'QUIET_HOURS until ';

/** The instant a legacy marker names, or null when the text is not one (or does not parse). */
export function readDeferral(lastError: string | null | undefined): Date | null {
  if (!lastError || !lastError.startsWith(DEFERRAL_MARKER)) return null;
  const at = new Date(lastError.slice(DEFERRAL_MARKER.length));
  return Number.isNaN(at.getTime()) ? null : at;
}

/* ── sample variables for a test send ────────────────────────────── */

/**
 * What a test send fills the placeholders with — believable, obviously fake
 * values so an operator reading their own inbox sees the layout, not a
 * blank. A name the table does not know renders as its own name in brackets.
 */
const SAMPLE_VALUES: Record<string, string> = {
  code: '482913',
  minutes: '10',
  used: '1',
  limit: '5',
  days: '7',
  url: 'https://adx.example/test-link',
  confirmUrl: 'https://adx.example/test-confirm',
  unsubscribeUrl: 'https://adx.example/test-unsubscribe',
  how: 'Sign in with your mobile number.',
  name: 'Asha Rao',
  partyName: 'Asha Rao',
  agentName: 'Ravi Kumar',
  packageName: 'Growth',
  amount: '1,250.00',
  net: '1,250.00',
  reference: 'TEST-000001',
  utr: 'TESTUTR000001',
  method: 'HDFC •••• 1234',
  decision: 'VERIFIED',
  reason: 'This is a test message.',
  address: '12 MG Road, Bengaluru',
  when: 'tomorrow at 11:00',
  month: 'August 2026',
  date: '14 Sep 2026',
  newMasked: '+91 98450 •••10',
  title: 'Test announcement',
  body: 'This is a test of the announcement template.',
  reportName: 'Test report',
  window: 'last week',
  rowCount: '42',
  format: 'CSV',
  expiresAt: '14 Oct 2026',
  status: 'MONITORING',
  severity: 'MINOR',
  services: 'API',
};

export function sampleVariablesFor(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = SAMPLE_VALUES[name] ?? `[${name}]`;
  return out;
}
