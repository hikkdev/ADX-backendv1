import type { DocumentWaiverInput, ExtraAnswer } from './listings.schema';

/**
 * LD-1 (listing data gaps, 3 Oct 2026): "never drop an answer again".
 *
 * The listing forms render `flows.listing`, and a client turns each answer
 * it knows into a column of the create body. A question somebody adds in
 * the Flow Editor has no column and no client binding, so until now its
 * answer was saved on the draft and lost when the listing was made. Every
 * answer a draft holds whose id is not one of the ids below is copied onto
 * the listing as `extraAnswers: [{ key, label, value }]`, labelled with the
 * question's words from the stored flow.
 */

/**
 * Every answer id a client binds to a column, a paper, a photograph or a
 * rule — the code template's questions (`scripts/data/listing-flow.ts`;
 * `listing-answers.test.ts` holds the two lists together, so a question
 * added to the template must be added here too) and the answers the
 * clients draw beside the flow.
 */
export const LISTING_FLOW_FIELD_IDS = [
  // Root and steps 2–3.
  'category',
  'venue_type_id',
  'media_type_id',
  'material_id',
  // Step 4 — spot details.
  'title',
  'placement',
  'address',
  'city',
  'vehicle_number',
  'vehicle_type',
  'vehicle_model',
  'broadcast_language',
  'content_format',
  'slot_duration',
  'location',
  'width_ft',
  'height_ft',
  'area_sq_ft',
  'width_px',
  'height_px',
  'illumination',
  'facing',
  'estimated_daily_footfall',
  'traffic_grade',
  'visibility',
  'elevation',
  'installation_by_adx',
  // Step 5 — more info.
  'description',
  'target_audience',
  'unique_selling_point',
  'footfall_note',
  // Step 6 — audience evidence (stored together as `audienceDemographics`; the two reports as papers).
  'age_band',
  'gender_split',
  'urban_rural',
  'sec_profile',
  'income_bracket',
  'occupation',
  'barc_report',
  'footfall_report',
  // Step 7 — content rules.
  'restricted_categories',
  'prohibited_content',
  // Step 8 — booking terms.
  'available_now',
  'available_year_round',
  'max_booking_days',
  'advance_booking_days',
  'cancellation_notice',
  // Step 9 — pricing.
  'pricing_unit',
  'base_price',
  'min_booking_days',
  'available_from',
  'available_hours',
  'peak_period_note',
  // Step 10 — rate card.
  'rate_card',
  'rate_card_valid_from',
  'rate_card_valid_to',
  'rate_card_seasonal',
  // Documents and review.
  'rights_basis',
  'rights_valid_until',
  'documents',
  'main_photo',
  'left_photo',
  'right_photo',
  'wide_photo',
  'terms',
] as const;

/**
 * Answers the clients keep beside the flow's questions: the merged content
 * rules, the instant-booking switch and the loop the apps draw under the
 * price, the website's marker, the two website questions that now have
 * columns of their own (`operatingHoursFrom/To`, `coverage`), and LD-1's
 * `photo_meta` — the upload rows (id, capture time) the website and the
 * apps keep beside the photographs, filed on `ListingPhoto`, never an answer.
 */
export const CLIENT_ANSWER_IDS = ['content_rules', 'instant_booking', 'slots_total', 'web', 'operating_hours', 'coverage', 'photo_meta'] as const;

const MAPPED = new Set<string>([...LISTING_FLOW_FIELD_IDS, ...CLIENT_ANSWER_IDS]);

/** Whether an answer id lands somewhere other than `extraAnswers`. */
export const isMappedAnswer = (id: string): boolean => MAPPED.has(id);

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

type FlowLike = { screens?: unknown; branches?: unknown };
type FieldLike = { id?: unknown; label?: unknown; type?: unknown };

/** Every field's label in a wizard flow (root and every branch), by id — the first one wins. */
export function flowFieldLabels(flow: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!flow || typeof flow !== 'object') return labels;
  const walk = (screens: unknown) => {
    if (!Array.isArray(screens)) return;
    for (const screen of screens) {
      const fields = (screen as { fields?: unknown })?.fields;
      if (!Array.isArray(fields)) continue;
      for (const field of fields as FieldLike[]) {
        if (typeof field?.id === 'string' && typeof field.label === 'string' && !labels.has(field.id)) labels.set(field.id, field.label);
      }
    }
  };
  const { screens, branches } = flow as FlowLike;
  walk(screens);
  if (branches && typeof branches === 'object') for (const branch of Object.values(branches as Record<string, { screens?: unknown }>)) walk(branch?.screens);
  return labels;
}

/** A value as JSON keeps it — a Date as its ISO string, anything unserialisable dropped. */
function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The answers on a draft that no column, paper or rule takes — in the
 * draft's own order, labelled with the question's words (the id when the
 * flow no longer asks it). Blank answers are left out.
 */
export function unmappedAnswers(answers: unknown, labels: ReadonlyMap<string, string>): ExtraAnswer[] {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  const out: ExtraAnswer[] = [];
  for (const [key, raw] of Object.entries(answers as Record<string, unknown>)) {
    if (isMappedAnswer(key) || isBlank(raw)) continue;
    const value = jsonValue(raw);
    if (value === undefined) continue;
    out.push({ key: key.slice(0, 64), label: (labels.get(key) ?? key).slice(0, 200), value });
  }
  return out;
}

/** Whether the draft holds any answer `unmappedAnswers` would keep — so the flow is read for labels only when one does. */
export const hasUnmappedAnswers = (answers: unknown): boolean =>
  !!answers && typeof answers === 'object' && !Array.isArray(answers) && Object.entries(answers as Record<string, unknown>).some(([key, value]) => !isMappedAnswer(key) && !isBlank(value));

/** The draft's and the body's extra answers as one list, by key — the body's word wins, the draft's order first. */
export function mergeExtraAnswers(fromDraft: readonly ExtraAnswer[], fromBody: readonly ExtraAnswer[] | null | undefined): ExtraAnswer[] {
  const byKey = new Map<string, ExtraAnswer>();
  for (const answer of fromDraft) byKey.set(answer.key, answer);
  for (const answer of fromBody ?? []) byKey.set(answer.key, answer);
  return [...byKey.values()];
}

/** Whether the review step's "Terms agreement" was ticked on the draft. */
export const termsTickedOn = (answers: unknown): boolean =>
  !!answers && typeof answers === 'object' && (answers as Record<string, unknown>)['terms'] === true;

/** A stored waiver: the kind, why when the publisher said, and when ADX first heard it. */
export type DocumentWaiver = { kind: string; reason?: string; at: string };

/**
 * The waivers to store: one per kind (the last word on a kind wins), each
 * keeping the moment it was first stated when the listing already held it.
 */
export function stampWaivers(next: readonly DocumentWaiverInput[], previous: unknown, now: Date): DocumentWaiver[] {
  const before = new Map<string, string>();
  if (Array.isArray(previous)) {
    for (const entry of previous as { kind?: unknown; at?: unknown }[]) {
      if (typeof entry?.kind === 'string' && typeof entry.at === 'string') before.set(entry.kind, entry.at);
    }
  }
  const byKind = new Map<string, DocumentWaiver>();
  for (const waiver of next) {
    byKind.set(waiver.kind, {
      kind: waiver.kind,
      ...(waiver.reason ? { reason: waiver.reason } : {}),
      at: before.get(waiver.kind) ?? now.toISOString(),
    });
  }
  return [...byKind.values()];
}

/** The terms wording a tick is recorded against when the client did not name one: the listing flow's version. */
export const termsVersionOf = (flowVersion: number | null): string => (flowVersion ? `flows.listing:v${flowVersion}` : 'flows.listing');
