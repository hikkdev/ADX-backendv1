import { z } from 'zod';
import { upperEnum } from './zod';

/**
 * QR-5 (17 Sep 2026): the two details about a person that the ladder collects
 * beside their name — a date of birth and a gender, both asked and neither
 * required. Shared here because `PATCH /users/me`, `PATCH /publishers/me`,
 * the desk's onboarding forms and the party imports all accept them and all
 * write the same two User columns.
 *
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders." So two rules live here,
 * apart:
 *
 *   - a VALID date of birth — a real day, not in the future, not more than
 *     120 years back. Every profile path takes any such date, or none.
 *   - 18 OR OVER — asked only where an order is placed (`shared/age-gate`),
 *     and where a person is engaged for work (agents, employees), which keep
 *     their own adult rule (`adultDateOfBirthSchema`).
 */

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export type Gender = (typeof GENDERS)[number];

export const genderSchema = upperEnum(GENDERS);

/** The age an order needs, and the oldest a date of birth may make a person, in whole years. */
export const MIN_ORDER_AGE_YEARS = 18;
export const MAX_AGE_YEARS = 120;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Today as the Indian calendar has it, `YYYY-MM-DD`. The hosts run on UTC
 * and the platform is India-only (shared/time), so the day a birthday falls
 * on is the Indian one — the day the person's own phone or browser shows.
 */
export function todayInIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The same calendar day `years` before `today` (both `YYYY-MM-DD`). A
 * 29 February with no twin that year becomes the 28th, so someone born on
 * 29 February has their birthday on 1 March in a common year.
 */
export function sameDayYearsBefore(today: string, years: number): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const year = y - years;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** A `YYYY-MM-DD` that names a day the calendar has. */
function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = dateOfBirthToDate(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * AGE-1: a date of birth any profile path takes — a real day, not after
 * today (the Indian day), and not more than 120 years back to the day. A
 * child's date is a valid date; whether they may ORDER is asked apart.
 */
export function isValidDateOfBirth(value: string, today: string = todayInIndia()): boolean {
  return isRealDay(value) && value <= today && value >= sameDayYearsBefore(today, MAX_AGE_YEARS);
}

/**
 * 29 Sep 2026: the calendar rule, the one the website's `birthDateFault`
 * and the apps apply — the 18th birthday on or before today (the Indian
 * day). It replaced a 365.25-day average that refused someone whose 18th
 * birthday was today. A date that is not a valid date of birth is not adult.
 */
export function isAdultDateOfBirth(value: string, today: string = todayInIndia()): boolean {
  return isValidDateOfBirth(value, today) && value <= sameDayYearsBefore(today, MIN_ORDER_AGE_YEARS);
}

/** Why an order is refused on age: no date on file, or not yet eighteen. */
export type OrderAgeProblem = 'MISSING' | 'UNDER_18';

/**
 * AGE-1: whether the person behind an order may place it — null when they
 * may. A stored `@db.Date` (UTC midnight) or the API's `YYYY-MM-DD`.
 */
export function orderAgeProblem(dateOfBirth: Date | string | null | undefined, today: string = todayInIndia()): OrderAgeProblem | null {
  if (dateOfBirth === null || dateOfBirth === undefined || dateOfBirth === '') return 'MISSING';
  const value = typeof dateOfBirth === 'string' ? dateOfBirth : dateOfBirthToString(dateOfBirth);
  if (!value) return 'MISSING';
  return value <= sameDayYearsBefore(today, MIN_ORDER_AGE_YEARS) ? null : 'UNDER_18';
}

export const DATE_OF_BIRTH_MESSAGE = 'A real date of birth — not in the future, and not more than 120 years ago';
export const ADULT_DATE_OF_BIRTH_MESSAGE = 'A date of birth between 18 and 120 years ago';

/** AGE-1: a date of birth as `YYYY-MM-DD` — any real day up to today, at most 120 years back. Under 18 is fine. */
export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => isValidDateOfBirth(value), DATE_OF_BIRTH_MESSAGE);

/**
 * The adult rule, for the paths that engage a person for work — the agent
 * application's desk copy. Eighteen or older today, at most a hundred and
 * twenty. (The agent ladder asks 18 or 21 by side on top: `profileGaps`.)
 */
export const adultDateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => isAdultDateOfBirth(value), ADULT_DATE_OF_BIRTH_MESSAGE);

/** The `YYYY-MM-DD` the API speaks, as the UTC midnight the `@db.Date` column stores. */
export function dateOfBirthToDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** The stored date back as the `YYYY-MM-DD` the API speaks; null stays null. */
export function dateOfBirthToString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
