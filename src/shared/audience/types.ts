/**
 * The audience / footfall vendor port — G7 (Q109).
 *
 * The owner's answer to 109: campaign analytics are ADX's own digital
 * interactions; the Audience Breakdown panel is a footfall / data-panel
 * vendor's — GeoIQ and Azira — behind a seam, with ADX's own retail
 * analytics to come later. One vocabulary here so nothing above
 * `shared/audience` knows which vendor answered, and one rule for every
 * adapter: **map what the vendor documents, mark the rest null, never
 * invent.** A screen prints "not provided" against a null; it never prints
 * a number nobody measured.
 *
 * Everything an adapter answers is a PANEL figure: modelled by the vendor
 * from a device panel, not observed by ADX. `provenance` says so on every
 * answer, the way campaign analytics label MEASURED / ESTIMATED.
 */

import type { AudiencePolicy, AudienceVendorName } from '../integrations';

export type AudienceVendor = AudienceVendorName;
export type AudienceProviderName = 'NONE' | AudienceVendor;
export type { AudiencePolicy } from '../integrations';
export { AUDIENCE_VENDORS, DEFAULT_AUDIENCE_POLICY } from '../integrations';

/** A share of the catchment under one label, 0–100. */
export type AudienceShare = { label: string; share: number };

export type AudienceFootfall = {
  /** Average daily footfall in the catchment over the period. */
  daily: number | null;
  /** 24 shares, midnight first, summing to 100 — null when the vendor has no hourly panel. */
  byHour: number[] | null;
  /** 7 shares, Monday first, summing to 100 — null when the vendor has no weekday panel. */
  byWeekday: number[] | null;
};

export type AudienceDemographics = {
  ageBands: AudienceShare[] | null;
  gender: AudienceShare[] | null;
  incomeBands: AudienceShare[] | null;
  affinities: AudienceShare[] | null;
};

export type AudienceCatchment = {
  footfall: AudienceFootfall;
  demographics: AudienceDemographics;
  provenance: 'PANEL';
  vendor: AudienceVendor;
  /** YYYY-MM — the month the panel was asked about. */
  period: string;
  radiusM: number;
  /** ISO instant the vendor was asked. */
  fetchedAt: string;
};

/* ── Y-B: both vendors at once ──────────────────────────────────── */

/** Where a blended field group came from: one vendor, or both (`BLENDED`). */
export type AudienceSource = AudienceVendor | 'BLENDED';

/**
 * Provenance per field group, beside the legacy `'PANEL'`: which vendor
 * (or both) the footfall, the demographic mixes and the affinities were
 * taken from. Null where no vendor had anything.
 */
export type AudienceProvenanceByField = {
  footfall: AudienceSource | null;
  demographics: AudienceSource | null;
  affinities: AudienceSource | null;
};

/**
 * What `audienceCatchment` answers when more than one vendor is in force:
 * the legacy `AudienceCatchment` shape (so every old reader still finds
 * `footfall`, `demographics`, `provenance: 'PANEL'` and a `vendor` — the
 * footfall's source, or the footfall primary when both contributed), with
 * the per-field provenance, the vendors that answered, how far the two
 * vendors' daily figures agree (1 = identical, 0 = one is zero; null unless
 * both gave a figure — a screen prints "both vendors agree within 12 %"),
 * and the raw answer of each vendor for the desk.
 */
export type BlendedAudienceCatchment = AudienceCatchment & {
  provenanceByField: AudienceProvenanceByField;
  vendors: AudienceVendor[];
  agreement: { footfall: number | null };
  rawByVendor: Partial<Record<AudienceVendor, AudienceCatchment>>;
};

/** What the seam knows before it asks anybody: the enabled set, the blend policy and the circle. */
export type AudienceSetup = { vendors: AudienceVendor[]; policy: AudiencePolicy; radiusM: number };

export interface AudienceProvider {
  readonly name: AudienceProviderName;
  /**
   * The audience in a circle around a spot, for one month. Null when the
   * vendor has nothing for that circle; an ApiError (503 when the vendor is
   * not configured, 429 / 502 for its failures) otherwise.
   */
  catchment(lat: number, lng: number, radiusM: number, period: string): Promise<AudienceCatchment | null>;
}

/**
 * The seam's field names — what `audience.geoiqVariables` maps to catalogue
 * ids, and what a screen can rely on. `age.*`, `income.*` and `affinity.*`
 * are open bands: the account decides which it bought.
 */
export const AUDIENCE_FIELD_PATTERN = /^(footfall\.daily|age\.[a-z0-9_]+|gender\.(male|female|other)|income\.[a-z0-9_]+|affinity\.[a-z0-9_]+)$/i;

/* ── AC-B2: the field catalogue the console draws the variable map from ── */

export type AudienceFieldGroup = 'footfall' | 'age' | 'gender' | 'income' | 'affinity';

/** One row of the variable map: a seam field the console offers an input for. */
export type AudienceFieldDescriptor = { field: string; group: AudienceFieldGroup; label: string; required: boolean };

/**
 * The age bands the platform prints. The seam's pattern leaves `age.*` open
 * (an account may have bought other cuts — a mapped `age.60_plus` is legal
 * and printed under its own label), but these are the bands the console
 * offers by default and the apps' demographics panels expect.
 */
export const AUDIENCE_AGE_BANDS = ['18_24', '25_34', '35_44', '45_54', '55_plus'] as const;
/** The household-income bands the console offers by default; `income.*` stays open the same way. */
export const AUDIENCE_INCOME_BANDS = ['low', 'mid', 'high', 'affluent'] as const;
export const AUDIENCE_GENDERS = ['male', 'female', 'other'] as const;

const AGE_LABELS: Record<(typeof AUDIENCE_AGE_BANDS)[number], string> = {
  '18_24': 'Age 18–24',
  '25_34': 'Age 25–34',
  '35_44': 'Age 35–44',
  '45_54': 'Age 45–54',
  '55_plus': 'Age 55+',
};
const INCOME_LABELS: Record<(typeof AUDIENCE_INCOME_BANDS)[number], string> = {
  low: 'Income: low',
  mid: 'Income: mid',
  high: 'Income: high',
  affluent: 'Income: affluent',
};
const GENDER_LABELS: Record<(typeof AUDIENCE_GENDERS)[number], string> = { male: 'Male', female: 'Female', other: 'Other' };

/**
 * The named fields, in the order the console draws them. `footfall.daily`
 * is the one required row — it is what the Audience Breakdown leads with;
 * every other field is null, never guessed, when unmapped. Affinities are
 * not here: they are a free-form group (`affinity.<name>`, any name the
 * account chose), described by `AUDIENCE_FIELD_GROUPS`.
 */
export const AUDIENCE_FIELD_CATALOGUE: readonly AudienceFieldDescriptor[] = [
  { field: 'footfall.daily', group: 'footfall', label: 'Daily footfall', required: true },
  ...AUDIENCE_AGE_BANDS.map((band) => ({ field: `age.${band}`, group: 'age' as const, label: AGE_LABELS[band], required: false })),
  ...AUDIENCE_GENDERS.map((g) => ({ field: `gender.${g}`, group: 'gender' as const, label: GENDER_LABELS[g], required: false })),
  ...AUDIENCE_INCOME_BANDS.map((band) => ({ field: `income.${band}`, group: 'income' as const, label: INCOME_LABELS[band], required: false })),
];

/** The groups, in drawing order; `freeForm` groups take any `<group>.<name>` the pattern admits. */
export const AUDIENCE_FIELD_GROUPS: readonly { group: AudienceFieldGroup; label: string; freeForm: boolean; pattern?: string }[] = [
  { group: 'footfall', label: 'Footfall', freeForm: false },
  { group: 'age', label: 'Age bands (shares)', freeForm: false },
  { group: 'gender', label: 'Gender split (shares)', freeForm: false },
  { group: 'income', label: 'Household income bands (shares)', freeForm: false },
  { group: 'affinity', label: 'Affinities (POI counts or shares)', freeForm: true, pattern: 'affinity.<name>' },
];

/* ── AC-B2: the vendor test behind the card ─────────────────────────── */

/**
 * What `POST /integrations/audience/test` answers: a plain verdict the
 * card prints. Never a key. `status` is the vendor's EFFECTIVE status (the
 * one inside GeoIQ's gateway envelope, not the HTTP 200 around it); null
 * when nothing was asked or nothing answered. `fieldsAnswered` /
 * `fieldsMissing` are seam field names for GeoIQ (the mapped variables
 * that did / did not come back) and group names for Azira (whose answer
 * is one shape, not a map).
 */
export type AudienceVendorTest = {
  vendor: AudienceVendor;
  keyPresent: boolean;
  variablesMapped: number;
  reachable: boolean;
  authorized: boolean;
  status: number | null;
  message: string;
  fieldsAnswered: string[];
  fieldsMissing: string[];
  sample: { footfallDaily?: number | null };
};

/** YYYY-MM. */
export const AUDIENCE_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** [first instant of the month, first instant of the next month), UTC. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
