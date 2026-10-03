/**
 * LD-1 (listing data gaps, 3 Oct 2026): the closed lists the listing forms
 * now ask, as stable codes with the plain words beside them.
 *
 * The column holds the CODE (`HIGH`, `50_150M`, `ROOFTOP`, `AUTO`); every
 * client prints its own label for it. The words here are the flow
 * template's option titles (`scripts/data/listing-flow.ts`), so the website,
 * the two apps and the Flow Editor show one set of words in one order.
 *
 * No imports, on purpose: the flow template, the listing request schemas
 * and the pricing factors' predicate all read this file, and none of them
 * should pull another in (listings already depends on pricing).
 */

export type VocabularyEntry = { readonly code: string; readonly label: string; readonly aliases?: readonly string[] };

/** "How busy is it?" — `Listing.trafficGrade`. */
export const TRAFFIC_GRADES = [
  { code: 'LOW', label: 'Low' },
  { code: 'MEDIUM', label: 'Medium' },
  { code: 'HIGH', label: 'High' },
  // The desk's older word for the top grade.
  { code: 'VERY_HIGH', label: 'Very high', aliases: ['Prime'] },
] as const satisfies readonly VocabularyEntry[];

/** "From how far can it be seen?" — `Listing.visibility`. */
export const VISIBILITY_RANGES = [
  { code: 'UNDER_50M', label: 'Under 50 m' },
  { code: '50_150M', label: '50–150 m', aliases: ['50-150 m', '50 - 150 m'] },
  { code: '150_300M', label: '150–300 m', aliases: ['150-300 m', '150 - 300 m'] },
  { code: 'OVER_300M', label: 'Over 300 m' },
] as const satisfies readonly VocabularyEntry[];

/** "How high is it?" — `Listing.elevation`, outdoor spots. */
export const ELEVATIONS = [
  { code: 'GROUND', label: 'Ground level', aliases: ['Ground'] },
  { code: 'FIRST_FLOOR', label: 'First floor' },
  { code: 'ROOFTOP', label: 'Rooftop' },
  { code: 'ELEVATED', label: 'Elevated structure' },
] as const satisfies readonly VocabularyEntry[];

/** "What kind of vehicle?" — `Listing.vehicleType`, transit spots. */
export const LISTING_VEHICLE_TYPES = [
  { code: 'AUTO', label: 'Auto', aliases: ['Auto-rickshaw', 'Autorickshaw', 'Rickshaw'] },
  { code: 'CAR', label: 'Car', aliases: ['Private car'] },
  { code: 'CAB', label: 'Cab', aliases: ['Taxi', 'Taxi / cab'] },
  { code: 'BUS', label: 'Bus', aliases: ['City bus'] },
  { code: 'TRUCK', label: 'Truck' },
  { code: 'OTHER', label: 'Other' },
] as const satisfies readonly VocabularyEntry[];

const squash = (value: string): string => value.trim().toLowerCase().replace(/[\s–—-]+/g, ' ');

/**
 * A stated value as the column stores it: the code when the value is a code
 * or one of the list's words (any case, any dash), else the value as sent.
 *
 * The "else" is deliberate. These columns are controlled strings a pricing
 * factor may key on, and the console's desk form still writes its own words
 * ("Mid-rise", "Landmark"); refusing those would break the desk, and nothing
 * in the database holds a value of either kind yet (checked 3 Oct 2026).
 */
export function toVocabularyCode(entries: readonly VocabularyEntry[], value: string): string {
  const wanted = squash(value);
  for (const entry of entries) {
    if (squash(entry.code) === wanted || squash(entry.label) === wanted) return entry.code;
    if (entry.aliases?.some((alias) => squash(alias) === wanted)) return entry.code;
  }
  return value.trim();
}

/** The listing columns stored as codes, and their lists — what a reader compares through `toVocabularyCode`. */
export const CODED_LISTING_FIELDS: Readonly<Record<string, readonly VocabularyEntry[]>> = {
  trafficGrade: TRAFFIC_GRADES,
  visibility: VISIBILITY_RANGES,
  elevation: ELEVATIONS,
  vehicleType: LISTING_VEHICLE_TYPES,
};

/** Whether a listing column is stored as a code from one of these lists. */
export const isCodedListingField = (field: string): boolean => Object.prototype.hasOwnProperty.call(CODED_LISTING_FIELDS, field);

/**
 * A value of a coded column in its comparable form — the code when it is a
 * code or the list's words, else as stated. Non-strings pass through, and
 * a field that is not coded is returned untouched.
 */
export function comparableListingValue(field: string, value: unknown): unknown {
  const entries = Object.prototype.hasOwnProperty.call(CODED_LISTING_FIELDS, field) ? CODED_LISTING_FIELDS[field] : undefined;
  if (!entries || typeof value !== 'string') return value;
  return toVocabularyCode(entries, value).toUpperCase();
}

/** The flow template's options for a list: the code as the id, the words as the title. */
export const flowOptionsOf = (entries: readonly VocabularyEntry[]) => entries.map((entry) => ({ id: entry.code, title: entry.label }));

/**
 * LD-1: the listing columns that are the publisher's own statement to ADX —
 * the answers no column takes, the papers waived and why, the two ticks.
 * The publisher, their agent and the desk read them; another party to an
 * order on the spot (the advertiser, the installing agent) does not.
 */
export const LISTING_PUBLISHER_RECORD_KEYS = ['extraAnswers', 'documentWaivers', 'termsAcceptedAt', 'termsVersion', 'ownershipDeclaredAt'] as const;

/** The same, as a Prisma `omit` on a listing join. */
export const LISTING_PUBLISHER_RECORD_OMIT = {
  extraAnswers: true,
  documentWaivers: true,
  termsAcceptedAt: true,
  termsVersion: true,
  ownershipDeclaredAt: true,
} as const satisfies Record<(typeof LISTING_PUBLISHER_RECORD_KEYS)[number], true>;
