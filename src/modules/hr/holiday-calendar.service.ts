import type { Holiday, HolidayKind } from '../../shared/database';
import { getEffectiveHolidayCalendarConfig } from '../../shared/integrations';
import { logger } from '../../shared/logging';
import { getConfigObject, saveConfigObject } from '../app-config';
import { prismaHrRepository as repository } from './prisma-hr.repository';
import { HOLIDAYS_2026 } from './holidays-2026';
import { dateColumn, isoDateOf } from './hr.schema';
import { CalendarParseError, parseHolidayCalendar, type CalendarEvent } from './holiday-calendar.parser';
import { ensureHolidays } from './holidays.service';

/**
 * HC-1 (1 Oct 2026): the Holidays page follows a public calendar.
 *
 * The owner: "connect our holidays section to some free available holiday
 * calendar for every year so that we don't have to manually add everything
 * every time." The feed is Settings › Integrations › Holiday calendar
 * (Google's "Holidays in India" by default); this reads it and reconciles
 * the table for the years asked, by these rules:
 *
 * - observances come in (as OPTIONAL) only when the setting says so;
 * - a row already carrying the event's id follows the feed — name, date,
 *   kind, tentative — unless it is hidden (someone deleted it: it stays
 *   hidden) or a person edited it (it turned MANUAL: theirs now);
 * - a day a person entered by hand wins and is counted `skipped` — except a
 *   row the old boot seed wrote (its date and name are in `HOLIDAYS_2026`),
 *   which the calendar adopts;
 * - the table holds one national row per date, so two events on one day
 *   share a row: the names joined with " · ", PUBLIC winning over OPTIONAL;
 * - nothing is ever deleted. A calendar row whose event left the feed is
 *   left as it is and logged. A fetch or parse failure changes nothing and
 *   is recorded as the last run's error.
 */

export const HOLIDAY_SYNC_STATE_KEY = 'holiday-calendar-sync';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const NAME_JOINER = ' · ';
const NAME_MAX = 120;

export type HolidaySyncResult = { added: number; updated: number; adopted: number; skipped: number; years: number[] };
export type HolidaySyncState = {
  at: string;
  added: number;
  updated: number;
  adopted: number;
  skipped: number;
  error: string | null;
  years: number[];
};
export type HolidayCalendarView = {
  enabled: boolean;
  url: string;
  includeObservances: boolean;
  lastSync: HolidaySyncState | null;
};

/** A fetch or parse failure, in words a person can act on. Nothing was written. */
export class HolidayCalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolidayCalendarUnavailableError';
  }
}
/** A sync is already running in this process. */
export class HolidaySyncBusyError extends Error {
  constructor() {
    super('A calendar sync is already running.');
    this.name = 'HolidaySyncBusyError';
  }
}

/** The calendar year in India right now. */
export const istYear = (now: Date): number => new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear();

/** The years asked, else this year and next (IST), deduplicated and in order. */
export function syncYears(years: number[] | undefined, now: Date): number[] {
  const asked = years && years.length > 0 ? years : [istYear(now), istYear(now) + 1];
  return [...new Set(asked)].sort((a, b) => a - b);
}

const SEED_ROWS = new Set(HOLIDAYS_2026.map((h) => `${h.date}|${h.name.trim().toLowerCase()}`));
/** A MANUAL row the old boot seed wrote: no calendar id, and its date and name are the seed's. */
const isSeedRow = (row: Holiday): boolean =>
  row.source === 'MANUAL' && !row.externalId && SEED_ROWS.has(`${isoDateOf(row.date)}|${row.name.trim().toLowerCase()}`);

/** Names on one row, joined, each once (case-insensitive), cut to what fits the column's form limit. */
function joinNames(names: string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    const next = [...kept, name].join(NAME_JOINER);
    if (kept.length > 0 && next.length > NAME_MAX) break;
    seen.add(key);
    kept.push(name);
  }
  return kept.join(NAME_JOINER).slice(0, NAME_MAX);
}

/** What one date's events become: PUBLIC first, the names joined, tentative when a winning-kind event is. */
function desiredFor(events: CalendarEvent[]): { name: string; kind: HolidayKind; tentative: boolean } {
  const kind: HolidayKind = events.some((e) => e.kind === 'PUBLIC') ? 'PUBLIC' : 'OPTIONAL';
  return {
    name: joinNames(events.map((e) => e.name)),
    kind,
    tentative: events.filter((e) => e.kind === kind).some((e) => e.tentative),
  };
}

async function fetchCalendar(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' } });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new HolidayCalendarUnavailableError('The calendar did not answer within 15 seconds.');
    }
    throw new HolidayCalendarUnavailableError('The calendar could not be reached.');
  }
  if (!response.ok) {
    throw new HolidayCalendarUnavailableError(`The calendar answered with an error (HTTP ${response.status}).`);
  }
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new HolidayCalendarUnavailableError('The calendar is too large to read.');
  return text;
}

async function recordState(state: HolidaySyncState): Promise<void> {
  try {
    await saveConfigObject(HOLIDAY_SYNC_STATE_KEY, state as unknown as Record<string, unknown>);
  } catch (err) {
    logger.warn('Could not record the holiday calendar sync', { cause: err instanceof Error ? err.message : String(err) });
  }
}

export async function readHolidaySyncState(): Promise<HolidaySyncState | null> {
  const stored = await getConfigObject(HOLIDAY_SYNC_STATE_KEY);
  if (!stored || typeof stored['at'] !== 'string') return null;
  const n = (key: string) => (typeof stored[key] === 'number' ? (stored[key] as number) : 0);
  return {
    at: stored['at'] as string,
    added: n('added'),
    updated: n('updated'),
    adopted: n('adopted'),
    skipped: n('skipped'),
    error: typeof stored['error'] === 'string' ? (stored['error'] as string) : null,
    years: Array.isArray(stored['years']) ? (stored['years'] as unknown[]).filter((y): y is number => typeof y === 'number') : [],
  };
}

/** GET /hr/holidays/calendar — what the Holidays page says under its header. */
export async function getHolidayCalendarView(): Promise<HolidayCalendarView> {
  const [cfg, lastSync] = await Promise.all([getEffectiveHolidayCalendarConfig(), readHolidaySyncState()]);
  return { enabled: cfg.enabled, url: cfg.url, includeObservances: cfg.includeObservances, lastSync };
}

let running: Promise<HolidaySyncResult> | null = null;

/**
 * Reads the feed and reconciles the years asked (default: this year and
 * next, IST). Does not consult `enabled` — the route and the job do. Throws
 * `HolidayCalendarUnavailableError` when the feed cannot be read (nothing
 * written, the error recorded) and `HolidaySyncBusyError` when a sync is
 * already running here.
 */
export async function syncHolidayCalendar(options: { years?: number[]; now?: Date } = {}): Promise<HolidaySyncResult> {
  if (running) throw new HolidaySyncBusyError();
  running = runSync(options);
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function runSync(options: { years?: number[]; now?: Date }): Promise<HolidaySyncResult> {
  const now = options.now ?? new Date();
  const years = syncYears(options.years, now);
  const result: HolidaySyncResult = { added: 0, updated: 0, adopted: 0, skipped: 0, years };
  const failed = async (message: string): Promise<never> => {
    await recordState({ at: now.toISOString(), added: 0, updated: 0, adopted: 0, skipped: 0, error: message, years });
    throw new HolidayCalendarUnavailableError(message);
  };

  const cfg = await getEffectiveHolidayCalendarConfig();
  let feed: CalendarEvent[];
  try {
    feed = parseHolidayCalendar(await fetchCalendar(cfg.url));
  } catch (err) {
    if (err instanceof HolidayCalendarUnavailableError || err instanceof CalendarParseError) return failed(err.message);
    return failed('The calendar could not be read.');
  }

  const inYears = feed.filter((e) => years.includes(Number(e.date.slice(0, 4))));
  const wanted = inYears.filter((e) => cfg.includeObservances || !e.observance);

  // One group per date, the public holidays first — the first event's id is the row's.
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of wanted) groups.set(event.date, [...(groups.get(event.date) ?? []), event]);
  for (const [date, events] of groups) {
    groups.set(date, [...events.filter((e) => e.kind === 'PUBLIC'), ...events.filter((e) => e.kind !== 'PUBLIC')]);
  }

  try {
    const from = dateColumn(`${years[0]}-01-01`);
    const to = dateColumn(`${years[years.length - 1]}-12-31`);
    const [rows, linkedRows] = await Promise.all([
      repository.findAllHolidaysBetween(from, to),
      repository.findHolidaysByExternalIds([...new Set(wanted.map((e) => e.uid))]),
    ]);
    const nationalByDate = new Map<string, Holiday>();
    for (const row of rows) if (row.region === null) nationalByDate.set(isoDateOf(row.date), row);
    const byExternalId = new Map<string, Holiday>();
    for (const row of linkedRows) if (row.externalId) byExternalId.set(row.externalId, row);
    const remember = (before: Holiday | null, after: Holiday) => {
      if (before) nationalByDate.delete(isoDateOf(before.date));
      nationalByDate.set(isoDateOf(after.date), after);
      if (after.externalId) byExternalId.set(after.externalId, after);
    };

    for (const date of [...groups.keys()].sort()) {
      const events = groups.get(date)!;
      const desired = desiredFor(events);
      const primary = events[0]!;
      const linked = events.map((e) => byExternalId.get(e.uid)).filter((row): row is Holiday => Boolean(row));

      // A person edited this event's row: it is theirs now.
      if (linked.some((row) => row.source === 'MANUAL')) {
        result.skipped += 1;
        continue;
      }

      const own = linked.find((row) => isoDateOf(row.date) === date) ?? linked[0];
      if (own) {
        if (own.hiddenAt) continue; // deleted on the page — stays hidden
        const moved = isoDateOf(own.date) !== date;
        if (moved) {
          const occupant = nationalByDate.get(date);
          if (occupant && occupant.id !== own.id) {
            logger.warn('Holiday calendar: an event moved onto a day another row holds; left as it is', { date, externalId: own.externalId });
            result.skipped += 1;
            continue;
          }
        }
        if (moved || own.name !== desired.name || own.kind !== desired.kind || own.tentative !== desired.tentative) {
          const after = await repository.updateHoliday(own.id, {
            ...(moved ? { date: dateColumn(date) } : {}),
            name: desired.name,
            kind: desired.kind,
            tentative: desired.tentative,
          });
          remember(own, after);
          result.updated += 1;
        }
        continue;
      }

      const occupant = nationalByDate.get(date);
      if (!occupant) {
        const created = await repository.createHoliday({
          date: dateColumn(date),
          name: desired.name,
          region: null,
          kind: desired.kind,
          source: 'CALENDAR',
          externalId: primary.uid,
          tentative: desired.tentative,
        });
        remember(null, created);
        result.added += 1;
        continue;
      }

      if (occupant.source === 'MANUAL') {
        if (isSeedRow(occupant)) {
          const after = await repository.updateHoliday(occupant.id, {
            source: 'CALENDAR',
            externalId: primary.uid,
            name: desired.name,
            kind: desired.kind,
            tentative: desired.tentative,
          });
          remember(occupant, after);
          result.adopted += 1;
        } else {
          result.skipped += 1; // a person's own entry always wins
        }
        continue;
      }

      // Another calendar event already holds the day: share the row.
      if (occupant.hiddenAt) continue;
      const kind: HolidayKind = occupant.kind === 'PUBLIC' || desired.kind === 'PUBLIC' ? 'PUBLIC' : 'OPTIONAL';
      const existingNames = occupant.name.split(NAME_JOINER);
      const names = occupant.kind === 'PUBLIC' || desired.kind !== 'PUBLIC' ? [...existingNames, desired.name] : [desired.name, ...existingNames];
      const tentative =
        occupant.kind === desired.kind ? occupant.tentative || desired.tentative : kind === desired.kind ? desired.tentative : occupant.tentative;
      const name = joinNames(names.flatMap((n) => n.split(NAME_JOINER)));
      if (name !== occupant.name || kind !== occupant.kind || tentative !== occupant.tentative) {
        const after = await repository.updateHoliday(occupant.id, { name, kind, tentative });
        remember(occupant, after);
        result.updated += 1;
      }
    }

    // Never deleted: a calendar row whose event left the feed stays as it is.
    const feedIds = new Set(inYears.map((e) => e.uid));
    const vanished = rows.filter((row) => row.source === 'CALENDAR' && row.externalId && !feedIds.has(row.externalId));
    if (vanished.length > 0) {
      logger.info('Holiday calendar: rows whose event is no longer in the feed were left as they are', {
        count: vanished.length,
        dates: vanished.map((row) => isoDateOf(row.date)),
      });
    }
  } catch (err) {
    const message = 'The holidays could not be saved.';
    logger.error('Holiday calendar sync failed while writing', { cause: err instanceof Error ? err.message : String(err) });
    await recordState({ at: now.toISOString(), ...result, error: message });
    throw err;
  }

  await recordState({ at: now.toISOString(), ...result, error: null });
  logger.info('Holiday calendar synced', { ...result });
  return result;
}

/**
 * The weekly job's run: only when the calendar is switched on. Never
 * throws — a failure is recorded as the last run's error and logged.
 */
export async function runScheduledHolidaySync(now = new Date()): Promise<HolidaySyncResult | null> {
  const cfg = await getEffectiveHolidayCalendarConfig();
  if (!cfg.enabled) return null;
  try {
    return await syncHolidayCalendar({ now });
  } catch (err) {
    logger.warn('Holiday calendar sync did not run', { cause: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Boot. With the calendar on, the old `HOLIDAYS_2026` seed is retired and
 * the sync runs once when next year has no calendar rows yet; with it off,
 * the old seed runs as it always did. Not awaited by bootstrap.
 */
export async function ensureHolidayCalendar(now = new Date()): Promise<
  { mode: 'seed'; inserted: number } | { mode: 'sync'; result: HolidaySyncResult | null } | { mode: 'none' }
> {
  const cfg = await getEffectiveHolidayCalendarConfig();
  if (!cfg.enabled) return { mode: 'seed', inserted: await ensureHolidays() };
  if ((await repository.countCalendarHolidaysInYear(istYear(now) + 1)) > 0) return { mode: 'none' };
  return { mode: 'sync', result: await runScheduledHolidaySync(now) };
}
