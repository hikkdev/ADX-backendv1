import { z } from 'zod';
import { dateOfBirthSchema, genderSchema, upperEnum } from '../../shared/validation';
import type { ImportParty } from '../../shared/database';
import { advertiserTypeSchema, ADVERTISER_INDUSTRIES } from '../advertisers';
import { WORK_MODES, EMPLOYMENT_TYPES } from '../employees';
import { LISTING_CATEGORIES } from '../listings';

/**
 * Lot S — the publisher importer, generalised: one column table per party.
 *
 * Mobile is the only required column everywhere: it is the party's identity
 * on this platform and the key a merge matches on. Everything else is
 * optional and lenient on its shape — a book kept in a spreadsheet for years
 * has every kind of value in it — but a value that is present has to be
 * well-formed, or the row is INVALID and says which field.
 */

/** The URL segment → the enum the rows are stored under. */
export const PARTY_KEYS = ['advertisers', 'agents', 'print-partners', 'employees'] as const;
export type PartyKey = (typeof PARTY_KEYS)[number];
export const partyKeySchema = z.enum(PARTY_KEYS);

export const PARTY_OF: Record<PartyKey, ImportParty> = {
  advertisers: 'ADVERTISER',
  agents: 'AGENT',
  'print-partners': 'PRINT_PARTNER',
  employees: 'EMPLOYEE',
};

/**
 * Lot U: the two imports that are FOR a publisher rather than of a party —
 * their spots, and their rate card. Same table, same two steps, same report;
 * `?publisherId=` on every route, and the act rule an agent's own listing
 * creation uses instead of ADMIN at the router.
 */
export const LISTING_KINDS = ['listings', 'rate-card'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
export const listingKindSchema = z.enum(LISTING_KINDS);
export const KIND_OF: Record<ListingKind, ImportParty> = { listings: 'LISTING', 'rate-card': 'RATE_CARD' };

/** Every key the routes take — a party, or one of the publisher's two. */
export type ImportKey = PartyKey | ListingKind;
export const isListingKind = (key: string): key is ListingKind => (LISTING_KINDS as readonly string[]).includes(key);

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().min(1).max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.string().trim().toLowerCase().email().optional());
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blankToUndefined, upperEnum(values).optional());

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const optionalGstin = z.preprocess(blankToUndefined, z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'Invalid GSTIN').optional());
const optionalPan = z.preprocess(blankToUndefined, z.string().trim().toUpperCase().regex(PAN_PATTERN, 'Invalid PAN').optional());

/** Present on every party: the key, at least ten digits; `normalizeMobile` runs after the parse. */
const requiredMobile = z.preprocess(blankToUndefined, z.string().trim().min(10, 'mobile is required').max(20));

/** QR-15: the four person columns at the end — given a first name, the row opens the sign-in account up front, as the desk does. */
export const ADVERTISER_COLUMNS = ['name', 'mobile', 'email', 'type', 'companyName', 'industry', 'gstin', 'panNumber', 'address', 'city', 'state', 'contactName', 'firstName', 'lastName', 'dateOfBirth', 'gender'] as const;
export const AGENT_COLUMNS = ['name', 'mobile', 'email', 'side', 'city', 'state'] as const;
export const PRINT_PARTNER_COLUMNS = ['name', 'mobile', 'legalName', 'gstin', 'panNumber', 'contactName', 'email', 'address', 'city', 'capabilities', 'maxWidthFt', 'turnaroundDays'] as const;
export const EMPLOYEE_COLUMNS = ['name', 'mobile', 'email', 'department', 'designation', 'region', 'workMode', 'employmentType'] as const;

export const advertiserRowSchema = z.object({
  name: optionalText(120),
  mobile: requiredMobile,
  email: optionalEmail,
  type: z.preprocess(blankToUndefined, z.string().trim().toUpperCase().pipe(advertiserTypeSchema).optional()),
  companyName: optionalText(160),
  industry: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .transform((value) => ADVERTISER_INDUSTRIES.find((industry) => industry.toLowerCase() === value.toLowerCase()) ?? value)
      .pipe(z.enum(ADVERTISER_INDUSTRIES))
      .optional(),
  ),
  gstin: optionalGstin,
  panNumber: optionalPan,
  address: optionalText(400),
  city: optionalText(80),
  state: optionalText(80),
  contactName: optionalText(120),
  firstName: optionalText(60),
  lastName: optionalText(60),
  dateOfBirth: z.preprocess(blankToUndefined, dateOfBirthSchema.optional()),
  gender: z.preprocess(blankToUndefined, genderSchema.optional()),
});

export const agentRowSchema = z.object({
  name: optionalText(120),
  mobile: requiredMobile,
  email: optionalEmail,
  /** Required: `createAgent` needs the side to pick the role. */
  side: z.preprocess(blankToUndefined, upperEnum(['PUBLISHER', 'ADVERTISER'] as const)),
  city: optionalText(80),
  state: optionalText(80),
});

export const printPartnerRowSchema = z.object({
  name: optionalText(120),
  mobile: requiredMobile,
  legalName: optionalText(200),
  gstin: optionalGstin,
  panNumber: optionalPan,
  contactName: optionalText(120),
  email: optionalEmail,
  address: optionalText(500),
  city: optionalText(80),
  /** Pipe-separated in the file (`flex|vinyl|backlit`); kept as typed in the row, split at create. */
  capabilities: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .transform((value) => value.split('|').map((part) => part.trim()).filter(Boolean).join('|'))
      .pipe(z.string().min(1).max(30 * 61))
      .optional(),
  ),
  maxWidthFt: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, 'Use a number with at most two decimals').optional()),
  turnaroundDays: z.preprocess(blankToUndefined, z.string().trim().regex(/^(\d{1,3})$/, 'Use a whole number of days').refine((value) => Number(value) <= 365, 'At most 365').optional()),
});

export const employeeRowSchema = z.object({
  name: optionalText(120),
  mobile: requiredMobile,
  email: optionalEmail,
  department: optionalText(120),
  designation: optionalText(120),
  region: optionalText(80),
  workMode: optionalEnum(WORK_MODES),
  employmentType: optionalEnum(EMPLOYMENT_TYPES),
});

/* ── Lot U: the publisher's spots ──────────────────────────────────────── */

/** JSON rows may carry numbers and booleans where the CSV carries text; both read as text here. */
const scalarToText = (value: unknown) => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : blankToUndefined(value));
const requiredText = (max: number, field: string) => z.preprocess(scalarToText, z.string({ error: `${field} is required` }).trim().min(1, `${field} is required`).max(max));
const optionalScalarText = (max: number) => z.preprocess(scalarToText, z.string().trim().min(1).max(max).optional());
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const optionalMoney = z.preprocess(
  scalarToText,
  z.string().trim().regex(MONEY_PATTERN, 'Use an amount like 1200 or 1200.50').refine((value) => Number(value) > 0, 'Must be greater than zero').optional(),
);
const optionalCoordinate = (limit: number) =>
  z.preprocess(
    scalarToText,
    z
      .string()
      .trim()
      .regex(/^-?\d{1,3}(\.\d{1,10})?$/, 'Use a decimal like 18.5204')
      .refine((value) => Math.abs(Number(value)) <= limit, `Between -${limit} and ${limit}`)
      .optional(),
  );
/** Lot G's loop: 1..24, a whole number. */
const optionalSlots = z.preprocess(scalarToText, z.string().trim().regex(/^\d{1,2}$/, 'Use a whole number from 1 to 24').refine((value) => Number(value) >= 1 && Number(value) <= 24, 'Use a whole number from 1 to 24').optional());
const YES = ['yes', 'y', 'true', '1'];
const NO = ['no', 'n', 'false', '0', ''];
/** `yes` / `no` (also true/false, 1/0), kept as `yes` / `no` on the row. */
const optionalYesNo = z.preprocess(
  scalarToText,
  z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => YES.includes(value) || NO.includes(value), 'Use yes or no')
    .transform((value) => (YES.includes(value) ? 'yes' : 'no'))
    .optional(),
);
/** Pipe-separated URLs; each must be a URL. Kept as typed, split at create. */
const optionalPhotos = z.preprocess(
  scalarToText,
  z
    .string()
    .trim()
    .transform((value) => value.split('|').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.string().url('Each photo must be a URL')).max(20, 'At most 20 photos'))
    .transform((urls) => urls.join('|'))
    .optional(),
);

export const LISTING_COLUMNS = [
  'externalRef',
  'title',
  'category',
  'subType',
  'description',
  'address',
  'city',
  'state',
  'latitude',
  'longitude',
  'mediaType',
  'sizeClass',
  'size',
  'material',
  'ratePerDay',
  'monthlyPrice',
  'slotsTotal',
  'instantBooking',
  'photos',
] as const;

/** Lot U: one spot per row. Title, category, address and a price are required; the rest describes it. */
export const listingRowSchema = z
  .object({
    /** The publisher's own id for the spot — the merge key when present. */
    externalRef: optionalScalarText(120),
    title: requiredText(200, 'title'),
    category: z.preprocess(scalarToText, upperEnum(LISTING_CATEGORIES)),
    subType: optionalScalarText(120),
    description: optionalScalarText(2000),
    address: requiredText(500, 'address'),
    city: optionalScalarText(80),
    /** Used to geocode; the listing has no state column of its own. */
    state: optionalScalarText(80),
    latitude: optionalCoordinate(90),
    longitude: optionalCoordinate(180),
    /** A media type by name, resolved against the taxonomy at validation. */
    mediaType: optionalScalarText(120),
    /** A size class by slug or name. */
    sizeClass: optionalScalarText(80),
    /** The size as text ("20 x 10 ft"); free-form. */
    size: optionalScalarText(80),
    /** A material by slug or name. */
    material: optionalScalarText(80),
    ratePerDay: optionalMoney,
    /** The old shape: divided by 30 into the daily rate, the way the listing schema documents. */
    monthlyPrice: optionalMoney,
    slotsTotal: optionalSlots,
    instantBooking: optionalYesNo,
    photos: optionalPhotos,
  })
  .refine((row) => row.ratePerDay !== undefined || row.monthlyPrice !== undefined, { message: 'ratePerDay or monthlyPrice is required', path: ['ratePerDay'] })
  .refine((row) => row.ratePerDay === undefined || row.monthlyPrice === undefined, { message: 'Send ratePerDay or monthlyPrice, not both', path: ['ratePerDay'] })
  .refine((row) => (row.latitude === undefined) === (row.longitude === undefined), { message: 'latitude and longitude come together', path: ['latitude'] });

export type ListingRow = z.infer<typeof listingRowSchema>;

/* ── Lot U: the publisher's rate card ──────────────────────────────────── */

export const RATE_CARD_COLUMNS = ['listing', 'ratePerDay', 'monthlyPrice', 'slotsTotal', 'effectiveFrom'] as const;

/** A calendar day, `YYYY-MM-DD`; read as UTC midnight. */
const optionalIsoDate = z.preprocess(
  scalarToText,
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-15')
    .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), 'Not a real date')
    .optional(),
);

/** Lot U: one rate per row, against a listing named by displayId, externalRef or exact title. */
export const rateCardRowSchema = z
  .object({
    listing: requiredText(200, 'listing'),
    ratePerDay: optionalMoney,
    monthlyPrice: optionalMoney,
    slotsTotal: optionalSlots,
    /** Today when omitted. A future day is refused: rates apply as the import commits. */
    effectiveFrom: optionalIsoDate,
  })
  .refine((row) => row.ratePerDay !== undefined || row.monthlyPrice !== undefined, { message: 'ratePerDay or monthlyPrice is required', path: ['ratePerDay'] })
  .refine((row) => row.ratePerDay === undefined || row.monthlyPrice === undefined, { message: 'Send ratePerDay or monthlyPrice, not both', path: ['ratePerDay'] });

export type RateCardRow = z.infer<typeof rateCardRowSchema>;

/** `?publisherId=` — required on every route of the two publisher kinds. */
export const publisherQuerySchema = z.object({ publisherId: z.string().trim().min(1, 'publisherId is required').max(64) });

/** The parsed row: every column a string, mobile present. */
export type ParsedRow = { mobile: string } & Record<string, string | undefined>;

/** POST /party-imports/:party as JSON: the rows, and what to call the batch. */
export const importBodySchema = z.object({
  fileName: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(500).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});
export type ImportBody = z.infer<typeof importBodySchema>;

/** `GET /party-imports/:party?status=&page=&pageSize=` — the list contract. */
export const IMPORT_STATUSES = ['VALIDATED', 'COMMITTED', 'REVOKED'] as const;
export const listImportsQuerySchema = z.object({
  /** Lot U: the publisher kinds list per publisher. */
  publisherId: z.string().trim().min(1).max(64).optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(IMPORT_STATUSES)).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;
