/**
 * The Indian day around an instant.
 *
 * "Today's orders" is a promise to an agent standing in Bengaluru, and the
 * hosts run on UTC; the platform is India-only, so the offset is fixed rather
 * than read from the request.
 *
 * Lived in `agents/dashboard.service.ts` until DR 06's visits needed the same
 * boundary for "Today / Upcoming / Past". A rule read by two modules belongs
 * here, or the two drift and an agent's day starts at two different midnights.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayWindowIST(now: Date): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = new Date(midnight - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * The Indian calendar month — `[start, end)` in UTC instants. `month` is
 * 1-based, as the console's `YYYY-MM` writes it. The window closes at the
 * next month's IST midnight, so a booking paid at 23:30 IST on the 31st
 * counts in the month the advertiser saw on the receipt, not the UTC one.
 */
export function monthWindowIST(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
  return { start, end };
}

/** The Indian day a `YYYY-MM-DD` names. */
export function dayWindowISTFor(isoDate: string): { start: Date; end: Date } {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const midnight = Date.UTC(y, m - 1, d);
  const start = new Date(midnight - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * How long a queued record has been waiting, and whether that is past its
 * SLA — Lot A (Q31), where the window itself comes from the platform
 * settings row rather than from a constant in each queue.
 *
 * `ageHours` is rounded down to a whole hour because that is what the queue
 * prints; `slaBreached` is computed on the unrounded difference so a row does
 * not sit at "48h" for an hour before it turns red. A record with no
 * submission timestamp has no age and cannot breach: nothing has been
 * promised about a document that was never submitted.
 */
export function slaAge(
  submittedAt: Date | null | undefined,
  slaHours: number,
  now: Date = new Date(),
): { ageHours: number | null; slaBreached: boolean } {
  if (!submittedAt) return { ageHours: null, slaBreached: false };
  const elapsedMs = now.getTime() - submittedAt.getTime();
  return {
    ageHours: Math.max(0, Math.floor(elapsedMs / (60 * 60 * 1000))),
    slaBreached: elapsedMs > slaHours * 60 * 60 * 1000,
  };
}

/** The instant a record submitted before is already in breach of `slaHours`. */
export function slaCutoff(slaHours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - slaHours * 60 * 60 * 1000);
}
