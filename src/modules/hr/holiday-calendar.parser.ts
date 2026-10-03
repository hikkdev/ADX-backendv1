/**
 * HC-1 (1 Oct 2026): reading a public iCal holiday feed.
 *
 * Google's "Holidays in India" calendar is one VEVENT per day: `UID`,
 * `DTSTART;VALUE=DATE`, `SUMMARY` (the name) and `DESCRIPTION`, whose first
 * line says what the day is — `Public holiday` (the gazetted days) or
 * `Observance` (festivals and days a person may choose) — and which may add
 * `Date is tentative and may change.` for a lunar date. Long lines are folded
 * (a line break followed by a space or tab continues the line) and text is
 * escaped (`\,` `\;` `\n` `\\`). Pure: no I/O, so a test reads a fixture.
 */

export type CalendarEvent = {
  /** The event's iCal UID — stable across years of the feed. */
  uid: string;
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
  /** PUBLIC for a gazetted day; OPTIONAL for an observance. */
  kind: 'PUBLIC' | 'OPTIONAL';
  /** Anything that is not a public holiday — imported only when observances are switched on. */
  observance: boolean;
  tentative: boolean;
};

export class CalendarParseError extends Error {
  constructor(message = 'The calendar address did not return a calendar.') {
    super(message);
    this.name = 'CalendarParseError';
  }
}

/** Joins folded lines back together and splits the text into content lines. */
export function unfoldLines(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/** Undoes iCal TEXT escaping: `\n` is a line break; `\,` `\;` `\\` are the character itself. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/** A content line's name (upper-cased, parameters dropped) and value — the first colon outside quotes divides them. */
function splitLine(line: string): { name: string; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      const head = line.slice(0, i);
      const semicolon = head.indexOf(';');
      return { name: (semicolon === -1 ? head : head.slice(0, semicolon)).toUpperCase(), value: line.slice(i + 1) };
    }
  }
  return null;
}

/** `20260126` or `20260126T000000Z` → `2026-01-26`; anything else is null. */
function dateOf(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

const PUBLIC_HOLIDAY = /^public holiday$/i;
const TENTATIVE = /date is tentative/i;

/**
 * Every usable event in the feed, in feed order. An event without a UID, a
 * date or a name, or one marked CANCELLED, is left out. Text that is not a
 * calendar at all throws `CalendarParseError`.
 */
export function parseHolidayCalendar(text: string): CalendarEvent[] {
  const lines = unfoldLines(text);
  if (!lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VCALENDAR')) throw new CalendarParseError();

  const events: CalendarEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        const event = toEvent(current);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = splitLine(line);
    if (prop && current[prop.name] === undefined) current[prop.name] = prop.value;
  }
  return events;
}

function toEvent(props: Record<string, string>): CalendarEvent | null {
  if ((props['STATUS'] ?? '').trim().toUpperCase() === 'CANCELLED') return null;
  const uid = unescapeText(props['UID'] ?? '').trim();
  const date = dateOf(props['DTSTART'] ?? '');
  // "Ramzan Id (tentative)": the badge says tentative, so the name does not —
  // and it stays the same name the day the date is confirmed.
  const summary = unescapeText(props['SUMMARY'] ?? '');
  const name = summary
    .replace(/\s+/g, ' ')
    .replace(/\s*\(tentative\)\s*$/i, '')
    .trim()
    .slice(0, 120);
  if (!uid || !date || !name) return null;
  const description = unescapeText(props['DESCRIPTION'] ?? '');
  const firstLine = (description.split('\n')[0] ?? '').trim();
  const observance = !PUBLIC_HOLIDAY.test(firstLine);
  return { uid, date, name, kind: observance ? 'OPTIONAL' : 'PUBLIC', observance, tentative: TENTATIVE.test(description) || /\(tentative\)/i.test(summary) };
}
