/**
 * The live hours — Lot I.
 *
 * Live chat is answered inside a wall-clock window in one zone
 * (`support.liveChat.hours`, 09:00–21:00 Asia/Kolkata by default). Outside
 * it a message still lands, as a ticket, with the next opening promised.
 * Pure functions of the clock and the settings, so the boundary can be
 * pinned without a database. The same wall-clock read `notifications`'
 * quiet hours make, kept here rather than shared because the two windows
 * are read in opposite senses (one is when nothing leaves, this is when
 * somebody answers) and a shared helper would carry both names.
 */

export type LiveHours = { from: string; to: string; tz: string };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

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
 * Whether the desk is live at `now`. `[from, to)` on the local clock; a
 * window that crosses midnight (`21:00` → `06:00`) is a night shift; two
 * equal edges mean around the clock.
 */
export function withinLiveHours(now: Date, hours: LiveHours): boolean {
  const from = clockMinutes(hours.from);
  const to = clockMinutes(hours.to);
  if (from === to) return true;
  const local = localMinutes(now, hours.tz);
  return from < to ? local >= from && local < to : local >= from || local < to;
}

/**
 * The next instant the desk opens, cut to the whole minute — null while it
 * is open. Before today's `from` it is today's; after `to` it is tomorrow's.
 */
export function nextOpening(now: Date, hours: LiveHours): Date | null {
  if (withinLiveHours(now, hours)) return null;
  const from = clockMinutes(hours.from);
  const local = localMinutes(now, hours.tz);
  const wait = local < from ? from - local : from + DAY_MINUTES - local;
  const floored = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(floored + wait * MINUTE_MS);
}

/**
 * An instant as the desk's clock would say it — `9:00 am IST on Tue 15 Sep`
 * — for a SYSTEM line or a status read a person will read. Never an ISO
 * instant: the requester is told when to come back, not a timestamp to
 * convert. The zone abbreviation comes from the runtime (`IST` for
 * Asia/Kolkata); a zone the runtime does not know falls back to IST, the
 * platform's own, the same way `localMinutes` does.
 */
export function openingLabel(at: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(at);
    const of = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
    // en-IN is the locale that prints `IST` rather than `GMT+5:30`.
    const zone = new Intl.DateTimeFormat('en-IN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    const [weekday, day, month, hour, minute, period] = [of('weekday'), of('day'), of('month'), of('hour'), of('minute'), of('dayPeriod')];
    if (weekday && day && month && hour && minute && period && zone) {
      return `${hour}:${minute} ${period.toLowerCase()} ${zone} on ${weekday} ${day} ${month}`;
    }
  } catch {
    /* an unknown zone: fall through to IST, the platform's own */
  }
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const h24 = shifted.getUTCHours();
  const hour = h24 % 12 === 0 ? 12 : h24 % 12;
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  const period = h24 < 12 ? 'am' : 'pm';
  return `${hour}:${minute} ${period} IST on ${WEEKDAYS[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
