import { z } from 'zod';
import { dateOfBirthSchema, genderSchema, upperEnum } from '../../../shared/validation';
import { PUBLISHER_TYPES } from '../publishers.schema';

/**
 * Lot D (Q43/Q86) — the legacy book's columns.
 *
 * Twelve columns, mobile the only one required: it is the publisher's
 * identity on this platform and the key a merge matches on. Everything
 * else is optional and lenient on its shape — a book kept in a spreadsheet
 * for years has every kind of value in it — but a value that is present has
 * to be well-formed, or the row is INVALID and says which field.
 */
export const IMPORT_COLUMNS = [
  'name',
  'mobile',
  'email',
  'type',
  'gstin',
  'address',
  'city',
  'state',
  'contactName',
  'contactMobile',
  'contactEmail',
  'panNumber',
  // QR-13: the person behind the account and the address pin — what the app's ladder collects.
  'firstName',
  'lastName',
  'dateOfBirth',
  'gender',
  'latitude',
  'longitude',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().min(1).max(max).optional());

export const importRowSchema = z.object({
  name: optionalText(160),
  mobile: z.preprocess(blankToUndefined, z.string().trim().min(10, 'mobile is required').max(20)),
  email: z.preprocess(blankToUndefined, z.string().trim().email().optional()),
  type: z.preprocess(blankToUndefined, upperEnum(PUBLISHER_TYPES).optional()),
  gstin: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN')
      .optional(),
  ),
  address: optionalText(500),
  city: optionalText(80),
  state: optionalText(80),
  contactName: optionalText(160),
  contactMobile: z.preprocess(blankToUndefined, z.string().trim().min(10).max(20).optional()),
  contactEmail: z.preprocess(blankToUndefined, z.string().trim().email().optional()),
  // QR-13: the person and the pin.
  firstName: optionalText(60),
  lastName: optionalText(60),
  dateOfBirth: z.preprocess(blankToUndefined, dateOfBirthSchema.optional()),
  gender: z.preprocess(blankToUndefined, genderSchema.optional()),
  latitude: z.preprocess(blankToUndefined, z.coerce.number().min(-90).max(90).optional()),
  longitude: z.preprocess(blankToUndefined, z.coerce.number().min(-180).max(180).optional()),
  panNumber: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
      .optional(),
  ),
});
export type ImportRow = z.infer<typeof importRowSchema>;

/** POST /publishers/import as JSON: the rows, and what to call the batch. */
export const importBodySchema = z.object({
  fileName: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(500).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});
export type ImportBody = z.infer<typeof importBodySchema>;
