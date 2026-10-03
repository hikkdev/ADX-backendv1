import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — one calendar rule for a date of birth on every surface.
 *
 * AGE-1 (the owner, the same day): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders." So the rule is two:
 *
 *   - a VALID date of birth — a real day, not after today (the Indian day),
 *     not more than 120 years back to the day. `PATCH /users/me` takes any.
 *   - 18 OR OVER — the 18th birthday on or before today, counted in
 *     calendar days, the way the website's `birthDateFault` does. Asked when
 *     an order is placed (`orderAgeProblem`, `shared/age-gate`) and by the
 *     agent application's desk copy (`adultDateOfBirthSchema`).
 */

import {
  adultDateOfBirthSchema,
  isAdultDateOfBirth,
  isValidDateOfBirth,
  orderAgeProblem,
  sameDayYearsBefore,
  todayInIndia,
} from '../../../shared/validation';
import { updateProfileSchema } from '../users.schema';

afterEach(() => {
  vi.useRealTimers();
});

describe('a valid date of birth', () => {
  it('takes any real day up to today — a child is a person too', () => {
    expect(isValidDateOfBirth('2008-09-29', '2026-09-29')).toBe(true);
    expect(isValidDateOfBirth('2012-06-01', '2026-09-29')).toBe(true);
    expect(isValidDateOfBirth('2026-09-29', '2026-09-29')).toBe(true);
  });

  it('refuses a day in the future', () => {
    expect(isValidDateOfBirth('2026-09-30', '2026-09-29')).toBe(false);
    expect(isValidDateOfBirth('2030-01-01', '2026-09-29')).toBe(false);
  });

  it('allows 120 years back to the day, and not a day more', () => {
    expect(isValidDateOfBirth('1906-09-29', '2026-09-29')).toBe(true);
    expect(isValidDateOfBirth('1906-09-28', '2026-09-29')).toBe(false);
  });

  it('refuses a day that does not exist, and anything not YYYY-MM-DD', () => {
    expect(isValidDateOfBirth('1990-02-30', '2026-09-29')).toBe(false);
    expect(isValidDateOfBirth('1990-13-01', '2026-09-29')).toBe(false);
    expect(isValidDateOfBirth('12/04/1990', '2026-09-29')).toBe(false);
  });
});

describe('18 or over — the calendar rule', () => {
  it('lets the 18th birthday be today, and refuses the day after', () => {
    expect(isAdultDateOfBirth('2008-09-29', '2026-09-29')).toBe(true);
    expect(isAdultDateOfBirth('2008-09-30', '2026-09-29')).toBe(false);
    expect(isAdultDateOfBirth('2008-09-28', '2026-09-29')).toBe(true);
  });

  it('is never true of a date that is not a valid date of birth', () => {
    expect(isAdultDateOfBirth('1906-09-28', '2026-09-29')).toBe(false);
    expect(isAdultDateOfBirth('1990-02-30', '2026-09-29')).toBe(false);
  });

  it('gives a 29 February birthday its day on 1 March in a common year', () => {
    expect(isAdultDateOfBirth('2008-02-29', '2026-02-28')).toBe(false);
    expect(isAdultDateOfBirth('2008-02-29', '2026-03-01')).toBe(true);
    /* Today a 29 February: someone born on 1 March the year eighteen back is still seventeen. */
    expect(isAdultDateOfBirth('2010-03-01', '2028-02-29')).toBe(false);
    expect(isAdultDateOfBirth('2010-02-28', '2028-02-29')).toBe(true);
    expect(sameDayYearsBefore('2028-02-29', 18)).toBe('2010-02-28');
    expect(sameDayYearsBefore('2028-02-29', 20)).toBe('2008-02-29');
  });

  it('counts the Indian day — a UTC evening is already tomorrow in India', () => {
    expect(todayInIndia(new Date('2026-09-28T18:29:00Z'))).toBe('2026-09-28');
    expect(todayInIndia(new Date('2026-09-28T18:30:00Z'))).toBe('2026-09-29');
  });
});

describe('orderAgeProblem — what an order asks', () => {
  it('is MISSING with no date on file', () => {
    expect(orderAgeProblem(null, '2026-09-29')).toBe('MISSING');
    expect(orderAgeProblem(undefined, '2026-09-29')).toBe('MISSING');
    expect(orderAgeProblem('', '2026-09-29')).toBe('MISSING');
  });

  it('is UNDER_18 until the 18th birthday, and nothing from that day on', () => {
    expect(orderAgeProblem('2008-09-30', '2026-09-29')).toBe('UNDER_18');
    expect(orderAgeProblem('2008-09-29', '2026-09-29')).toBeNull();
    expect(orderAgeProblem('1980-05-14', '2026-09-29')).toBeNull();
  });

  it('reads the stored @db.Date (UTC midnight) the same as the API string', () => {
    expect(orderAgeProblem(new Date('2008-09-29T00:00:00Z'), '2026-09-29')).toBeNull();
    expect(orderAgeProblem(new Date('2008-09-30T00:00:00Z'), '2026-09-29')).toBe('UNDER_18');
  });
});

describe('PATCH /users/me', () => {
  it('takes any valid date of birth — under 18 included', () => {
    vi.useFakeTimers();
    /* 09:00 IST on 29 Sep 2026. */
    vi.setSystemTime(new Date('2026-09-29T03:30:00Z'));
    expect(updateProfileSchema.safeParse({ dateOfBirth: '2008-09-29' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dateOfBirth: '2008-09-30' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dateOfBirth: '2014-01-15' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({}).success).toBe(true);
  });

  it('refuses a future date and one more than 120 years back, in words', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T03:30:00Z'));
    const future = updateProfileSchema.safeParse({ dateOfBirth: '2026-09-30' });
    expect(future.success).toBe(false);
    expect(future.error?.issues[0]?.message).toBe('A real date of birth — not in the future, and not more than 120 years ago');
    expect(updateProfileSchema.safeParse({ dateOfBirth: '1906-09-28' }).success).toBe(false);
  });

  it('turns the day at Indian midnight, not UTC midnight', () => {
    vi.useFakeTimers();
    /* 00:30 IST on 29 Sep 2026 — still the 28th in UTC: today (the 29th) is not in the future. */
    vi.setSystemTime(new Date('2026-09-28T19:00:00Z'));
    expect(updateProfileSchema.safeParse({ dateOfBirth: '2026-09-29' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ dateOfBirth: '2026-09-30' }).success).toBe(false);
  });
});

describe('the agent application keeps the adult rule', () => {
  it('refuses a date a day short of eighteen, and takes the birthday itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T03:30:00Z'));
    expect(adultDateOfBirthSchema.safeParse('2008-09-29').success).toBe(true);
    const refused = adultDateOfBirthSchema.safeParse('2008-09-30');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe('A date of birth between 18 and 120 years ago');
  });
});
