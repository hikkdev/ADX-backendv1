import * as cheerio from 'cheerio';

/**
 * Turning a fetched page, feed or payload into event records.
 *
 * Pure: takes text and a field map, returns records. Nothing here fetches or
 * writes, so the fragile part — reading somebody else's markup — is the part
 * that can be tested without a network or a database.
 */

/** What the scraper understands. Everything else on a page is ignored. */
export type EventRecord = {
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  venue: string | null;
  city: string | null;
  /** A fraction. Null when the source did not carry one. */
  upliftPct: string | null;
  /** Whatever the source calls this record, for de-duplicating across runs. */
  externalRef: string | null;
};

export type FieldMap = Partial<
  Record<'container' | 'name' | 'startsAt' | 'endsAt' | 'venue' | 'city' | 'uplift' | 'ref', string>
>;

export class ParseError extends Error {}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * A date, or null.
 *
 * Deliberately does not fall back to "now" for an unreadable value. A surge
 * window silently dated today would lift prices for a real event on a date
 * nobody chose, which is worse than a record the run reports as unusable.
 */
const date = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * An uplift as a fraction.
 *
 * Accepts "0.25" and "25%" because sources write both, and rejects a bare "25":
 * read as a fraction that is a 2400% lift, and guessing which was meant would
 * eventually guess wrong on a live price.
 */
const uplift = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  if (raw.endsWith('%')) {
    const percent = Number(raw.slice(0, -1));
    if (Number.isNaN(percent) || percent < 0 || percent > 100) return null;
    return (percent / 100).toFixed(4);
  }
  const fraction = Number(raw);
  if (Number.isNaN(fraction) || fraction < 0 || fraction > 1) return null;
  return fraction.toFixed(4);
};

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

export function parseHtml(body: string, map: FieldMap): EventRecord[] {
  if (!map.container || !map.name) {
    throw new ParseError('An HTML source needs at least a container and a name selector');
  }
  const $ = cheerio.load(body);
  const records: EventRecord[] = [];

  $(map.container).each((_, element) => {
    const node = $(element);
    const pick = (selector?: string): string | null =>
      selector ? text(node.find(selector).first().text()) : null;

    const name = pick(map.name);
    // A record with no name cannot become a window an operator could recognise,
    // so it is dropped rather than published as "Untitled".
    if (!name) return;

    records.push({
      name,
      startsAt: date(pick(map.startsAt)),
      endsAt: date(pick(map.endsAt)),
      venue: pick(map.venue),
      city: pick(map.city),
      upliftPct: uplift(pick(map.uplift)),
      externalRef: pick(map.ref),
    });
  });

  return records;
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

/** Reads `a.b.c` out of a parsed payload. Returns undefined rather than throwing. */
export function pathValue(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

export function parseJson(body: string, map: FieldMap): EventRecord[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ParseError('Response was not valid JSON');
  }

  const rows = map.container ? pathValue(payload, map.container) : payload;
  if (!Array.isArray(rows)) {
    throw new ParseError(
      map.container
        ? `Nothing array-shaped at "${map.container}"`
        : 'Response was not an array, and no container path was configured'
    );
  }
  if (!map.name) throw new ParseError('A JSON source needs a name path');

  const records: EventRecord[] = [];
  for (const row of rows) {
    const pick = (path?: string): unknown => (path ? pathValue(row, path) : null);
    const name = text(pick(map.name));
    if (!name) continue;
    records.push({
      name,
      startsAt: date(pick(map.startsAt)),
      endsAt: date(pick(map.endsAt)),
      venue: text(pick(map.venue)),
      city: text(pick(map.city)),
      upliftPct: uplift(pick(map.uplift)),
      externalRef: text(pick(map.ref)),
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* RSS / Atom                                                          */
/* ------------------------------------------------------------------ */

/**
 * Feeds, read with cheerio in XML mode.
 *
 * A feed has a fixed shape, so the field map is optional here — `title`,
 * `pubDate` and `guid` mean the same thing in every RSS document, and asking an
 * operator to configure them would be asking them to restate a standard.
 */
export function parseFeed(body: string, map: FieldMap): EventRecord[] {
  const $ = cheerio.load(body, { xmlMode: true });
  const records: EventRecord[] = [];

  $('item, entry').each((_, element) => {
    const node = $(element);
    const first = (...selectors: string[]): string | null => {
      for (const selector of selectors) {
        const found = text(node.find(selector).first().text());
        if (found) return found;
      }
      return null;
    };

    const name = first(map.name ?? 'title', 'title');
    if (!name) return;

    records.push({
      name,
      startsAt: date(first(map.startsAt ?? 'pubDate', 'pubDate', 'published', 'updated')),
      endsAt: date(first(map.endsAt ?? 'endDate')),
      venue: first(map.venue ?? 'venue'),
      city: first(map.city ?? 'category'),
      upliftPct: uplift(first(map.uplift ?? 'uplift')),
      externalRef: first(map.ref ?? 'guid', 'guid', 'id', 'link'),
    });
  });

  return records;
}

export function parseBody(
  kind: 'HTML' | 'FEED' | 'JSON' | 'MANUAL',
  body: string,
  map: FieldMap
): EventRecord[] {
  switch (kind) {
    case 'HTML':
      return parseHtml(body, map);
    case 'JSON':
      return parseJson(body, map);
    case 'FEED':
      return parseFeed(body, map);
    case 'MANUAL':
      // Rows arrive through the API rather than being fetched. Reaching here
      // means a manual source was scheduled, which is a configuration mistake.
      throw new ParseError('A manual source is not fetched — its rows are posted in');
  }
}
