import { z } from 'zod';

/**
 * Enum field that accepts any casing from the client and normalises to UPPERCASE
 * before validation. This means the DB and API always store/return uppercase
 * enum values regardless of what the UI sends.
 *
 * Usage:  upperEnum(['PENDING', 'VERIFIED', 'REJECTED'] as const)
 */
export function upperEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(values));
}
