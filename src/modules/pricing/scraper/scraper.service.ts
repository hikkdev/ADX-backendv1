import { logger } from '../../../shared/logging';
import type { ScraperRunStatus, ScraperSource } from '../../../shared/database';
import { prismaPricingRepository as repository } from '../prisma-pricing.repository';
import { buildCityResolver } from '../pricing.service';
import { ParseError, parseBody, type EventRecord, type FieldMap } from './scraper.parse';

/**
 * The event scraper.
 *
 * Fetches a configured source, reads it with that source's field map, and turns
 * what it finds into surge windows. Runs headless on a timer; everything an
 * operator can change lives in `ScraperSource`.
 *
 * Two rules it must not break, because both are how ADX avoids lifting real
 * prices on a mistake:
 *
 * 1. A source publishes windows **disabled** unless `autoEnableWindows` is on.
 *    A field map pointing at the wrong element produces confident nonsense, and
 *    a surge window nobody reviewed raises what advertisers pay.
 * 2. A window an operator switched off **stays off**. The upsert never touches
 *    `isEnabled`, so a re-scrape of the same event cannot undo a kill switch.
 */

const TAG = 'eventScraper';

/** Enough that a slow site cannot hold a run open indefinitely. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * How long a window runs when the source gave a start but no end.
 *
 * Most event listings carry one date. A single day is the conservative reading:
 * too short only means the ceiling drops back sooner than it might have, where
 * too long leaves prices lifted after everyone has gone home.
 */
const DEFAULT_WINDOW_HOURS = 24;

export type RunOutcome = {
  status: ScraperRunStatus;
  message: string | null;
  found: number;
  windowsUpserted: number;
};

async function fetchBody(source: ScraperSource): Promise<string> {
  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Identifying the crawler is the minimum courtesy, and it gives a site
      // owner something to block or allow deliberately rather than by guess.
      'User-Agent': 'ADX-EventBot/1.0 (+https://adx.in/bot)',
      Accept:
        source.kind === 'JSON'
          ? 'application/json'
          : source.kind === 'FEED'
            ? 'application/rss+xml, application/atom+xml, application/xml'
            : 'text/html',
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * A record becomes a window only if it says when.
 *
 * Everything else can be defaulted; a date cannot. A window with invented dates
 * would lift prices across a period the event never occupied.
 */
function windowFrom(
  record: EventRecord,
  source: ScraperSource,
  citySlug: string | null
): {
  name: string;
  scope: 'CITY' | 'NATIONAL';
  source: 'SCRAPER';
  externalRef: string;
  city: string | null;
  citySlug: string | null;
  latitude: null;
  longitude: null;
  radiusMeters: null;
  startsAt: Date;
  endsAt: Date;
  upliftPct: string;
  isPublic: boolean;
} | null {
  if (!record.startsAt) return null;

  const endsAt =
    record.endsAt && record.endsAt > record.startsAt
      ? record.endsAt
      : new Date(record.startsAt.getTime() + DEFAULT_WINDOW_HOURS * 3_600_000);

  // The upsert key. Without a stable id from the source, the event name plus its
  // start date is the best available — it is stable across re-scrapes of the
  // same listing, which is what stops a nightly run stacking duplicates.
  const externalRef =
    record.externalRef ?? `${source.id}:${record.name}:${record.startsAt.toISOString().slice(0, 10)}`;

  const scoped = citySlug !== null;
  return {
    name: record.name,
    scope: scoped ? 'CITY' : 'NATIONAL',
    source: 'SCRAPER',
    externalRef,
    city: record.city,
    citySlug,
    latitude: null,
    longitude: null,
    radiusMeters: null,
    startsAt: record.startsAt,
    endsAt,
    upliftPct: record.upliftPct ?? source.defaultUpliftPct.toString(),
    // National events are surfaced to advertisers; city ones are not.
    isPublic: !scoped,
  };
}

/** Fetches one source and writes whatever it produced, including nothing. */
export async function runSource(source: ScraperSource): Promise<RunOutcome> {
  if (source.kind === 'MANUAL') {
    return {
      status: 'OK',
      message: 'Manual source — rows are posted in rather than fetched',
      found: 0,
      windowsUpserted: 0,
    };
  }

  let body: string;
  try {
    body = await fetchBody(source);
  } catch (cause) {
    return {
      status: 'FETCH_FAILED',
      message: cause instanceof Error ? cause.message : 'Fetch failed',
      found: 0,
      windowsUpserted: 0,
    };
  }

  let records: EventRecord[];
  try {
    records = parseBody(source.kind, body, (source.fieldMap ?? {}) as FieldMap);
  } catch (cause) {
    return {
      status: 'PARSE_FAILED',
      message: cause instanceof ParseError ? cause.message : 'Could not read the response',
      found: 0,
      windowsUpserted: 0,
    };
  }

  if (records.length === 0) {
    // Not an error, and the status that matters most in the run history: a site
    // redesign moves the elements a field map points at, and the symptom is a
    // source that keeps succeeding while quietly finding nothing.
    return {
      status: 'NO_MATCHES',
      message: 'Fetched successfully but nothing matched the field map',
      found: 0,
      windowsUpserted: 0,
    };
  }

  const resolveCity = buildCityResolver(await repository.listCities());
  // The source's own coverage is the fallback when a record names no city, so a
  // Mumbai-only feed does not publish national windows for every gig it lists.
  const sourceCity = source.citySlugs.length === 1 ? (source.citySlugs[0] ?? null) : null;

  let upserted = 0;
  let skipped = 0;
  for (const record of records) {
    const citySlug = resolveCity(record.city) ?? sourceCity;
    const candidate = windowFrom(record, source, citySlug);
    if (!candidate) {
      skipped += 1;
      continue;
    }
    try {
      const existing = await repository.findSurgeWindowByRef('SCRAPER', candidate.externalRef);
      await repository.upsertSurgeWindow(candidate);
      // Enabling is decided once, at creation. A window an operator switched off
      // must survive every later run of the source that produced it.
      if (!existing && !source.autoEnableWindows) {
        const created = await repository.findSurgeWindowByRef('SCRAPER', candidate.externalRef);
        if (created) {
          await repository.setScraperCreatedWindowDisabled(created.id);
        }
      }
      upserted += 1;
    } catch (cause) {
      logger.warn('Scraper could not write a window', {
        tag: TAG,
        source: source.id,
        event: record.name,
        reason: cause instanceof Error ? cause.message : 'unknown',
      });
    }
  }

  return {
    status: 'OK',
    message:
      skipped > 0 ? `${skipped} record${skipped === 1 ? '' : 's'} carried no usable date` : null,
    found: records.length,
    windowsUpserted: upserted,
  };
}

/** Sources whose interval has elapsed. */
export function isDue(source: ScraperSource, now: Date): boolean {
  if (!source.isEnabled) return false;
  if (!source.lastRunAt) return true;
  return now.getTime() - source.lastRunAt.getTime() >= source.intervalMinutes * 60_000;
}

/**
 * One pass over every due source.
 *
 * Sequential rather than parallel: these are other people's servers, and a
 * dozen simultaneous requests from one crawler is how a bot gets blocked.
 */
export async function runDueSources(now: Date = new Date()): Promise<RunOutcome[]> {
  const sources = (await repository.listScraperSources()).filter((source) => isDue(source, now));
  const outcomes: RunOutcome[] = [];

  for (const source of sources) {
    const run = await repository.startScraperRun(source.id);
    const outcome = await runSource(source);
    await repository.finishScraperRun(run.id, source.id, outcome);
    outcomes.push(outcome);

    logger.info('Scraper source run', {
      tag: TAG,
      source: source.name,
      status: outcome.status,
      found: outcome.found,
      windows: outcome.windowsUpserted,
    });
  }

  return outcomes;
}
