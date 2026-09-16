import crypto from 'crypto';

/**
 * How long an erased person's financial record is kept, and how a number is
 * remembered once it is gone -- Lot A (Q60).
 *
 * Pure functions, deliberately: the retention date is the one number in this
 * feature that somebody will be asked to justify years later, and it has to be
 * reproducible from the inputs without a database.
 */

/** India Standard Time, which has no daylight saving and never has had. */
const IST_OFFSET_MINUTES = 330;
const MINUTE = 60 * 1000;

/** Thirty days, the statutory window an erasure request is answered inside. */
export const ERASURE_DUE_DAYS = 30;

/**
 * Retention years when the platform settings cannot be read.
 *
 * Eight is the Companies Act's books-of-account window, which is the longest
 * of the ones that apply and therefore the safe answer: keeping a record too
 * long is a policy question, destroying one too early is an offence.
 */
export const DEFAULT_RETENTION_YEARS = 8;

export const dueAtFor = (requestedAt: Date, days = ERASURE_DUE_DAYS): Date =>
  new Date(requestedAt.getTime() + days * 24 * 60 * MINUTE);

/** The calendar parts of an instant as somebody in India would read them. */
function istParts(at: Date): { year: number; month: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * MINUTE);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

/**
 * The last instant of the Indian financial year containing `at`.
 *
 * The Indian FY runs 1 April to 31 March, so a date in April 2026 belongs to
 * FY 2026-27 and ends on 31 March 2027, while a date in February 2026 belongs
 * to FY 2025-26 and ends on 31 March 2026. Returned as the UTC instant of
 * 23:59:59.999 IST on that day, so a comparison anywhere in the world lands on
 * the right side of the boundary.
 */
export function financialYearEnd(at: Date): Date {
  const { year, month } = istParts(at);
  // getUTCMonth is zero-based: 3 is April.
  const endYear = month >= 3 ? year + 1 : year;
  return endOfMarch(endYear);
}

function endOfMarch(year: number): Date {
  const istMidnightEnd = Date.UTC(year, 2, 31, 23, 59, 59, 999);
  return new Date(istMidnightEnd - IST_OFFSET_MINUTES * MINUTE);
}

/**
 * When the financial record of an erased person may itself be destroyed.
 *
 * Counted in whole financial years from the one the erasure completed in,
 * because that is how the retention obligation is written -- "eight years from
 * the end of the relevant financial year" -- rather than as a rolling date
 * eight years after a Tuesday in September.
 */
export function retainUntilFor(completedAt: Date, years = DEFAULT_RETENTION_YEARS): Date {
  const { year, month } = istParts(completedAt);
  const endYear = (month >= 3 ? year + 1 : year) + years;
  return endOfMarch(endYear);
}

/**
 * The tombstone's primary key: sha256 of the number, hex.
 *
 * A hash rather than the number, because keeping the number would defeat the
 * erasure it records. It is one-way and the input space is small enough to
 * brute-force in principle -- which is why it is only ever used to answer "has
 * this exact number been erased", never to look a person up.
 */
export const hashMobile = (mobile: string): string =>
  crypto.createHash('sha256').update(mobile).digest('hex');

/**
 * What replaces a mobile number on an erased row.
 *
 * `User.mobile`, `Publisher.mobile` and `Advertiser.mobile` are all NOT NULL
 * and unique, so the column needs a value that no two people can collide on. A
 * prefix of the hash is derived from the number itself, which makes it unique
 * exactly where the number was, and readable enough that an engineer looking
 * at the row knows what happened to it.
 */
export const erasedMobile = (mobile: string): string =>
  'erased:' + hashMobile(mobile).slice(0, 16);
