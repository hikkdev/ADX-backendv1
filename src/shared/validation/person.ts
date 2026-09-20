import { z } from 'zod';
import { upperEnum } from './zod';

/**
 * QR-5 (17 Sep 2026): the two details about a person that the ladder collects
 * beside their name — a date of birth, which the listing door counts among
 * the basics, and a gender, which is asked and never required. Shared here
 * because both `PATCH /users/me` and `PATCH /publishers/me` accept them and
 * both write the same two User columns.
 */

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export type Gender = (typeof GENDERS)[number];

export const genderSchema = upperEnum(GENDERS);

/** A date of birth as `YYYY-MM-DD` — a person, so at least eighteen and at most a hundred and twenty years ago. */
export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const date = dateOfBirthToDate(value);
    if (Number.isNaN(date.getTime())) return false;
    const age = (Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
    return age >= 18 && age <= 120;
  }, 'A date of birth between 18 and 120 years ago');

/** The `YYYY-MM-DD` the API speaks, as the UTC midnight the `@db.Date` column stores. */
export function dateOfBirthToDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** The stored date back as the `YYYY-MM-DD` the API speaks; null stays null. */
export function dateOfBirthToString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
