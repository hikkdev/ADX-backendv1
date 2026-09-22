import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE, listQuerySchema } from '../../shared/pagination';

/** Which side of the marketplace the agent is prospecting for. */
export const LEAD_SIDES = ['PUBLISHER', 'ADVERTISER'] as const;
export type LeadSideValue = (typeof LEAD_SIDES)[number];

/**
 * One vocabulary of six, reconciled the way DR 07 reconciled `DisputeStatus`.
 *
 * The card draws three as a pill — HOT, NEW, CONTACTED — and the other three
 * are where a lead ends up. The app is given `leadPillOf` rather than a second
 * list, so the two can never drift.
 */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'HOT',
  'VISIT_BOOKED',
  'CONVERTED',
  'LOST',
] as const;
export type LeadStatusValue = (typeof LEAD_STATUSES)[number];

export const LEAD_ACTIVITY_KINDS = [
  'IMPORTED',
  'CALLED',
  'MESSAGED',
  'NOTE',
  'VISIT_BOOKED',
  'VISIT_DONE',
  'STATUS_CHANGED',
  'FOLLOW_UP',
  'TEMPERATURE_CHANGED',
] as const;
export type LeadActivityKindValue = (typeof LEAD_ACTIVITY_KINDS)[number];

/** LH1: the computed temperature. */
export const LEAD_TEMPERATURES = ['HOT', 'WARM', 'COLD'] as const;
export type LeadTemperatureValue = (typeof LEAD_TEMPERATURES)[number];

/* ── LH2: the stages' vocabulary ──────────────────────────────────────── */

export const LEAD_STAGE_VALUES = ['SOURCED', 'SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED', 'CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED', 'LOST'] as const;
export const LEAD_LOST_REASON_VALUES = ['NOT_INTERESTED', 'WRONG_CONTACT', 'COMPETITOR', 'PRICE', 'TIMING', 'OTHER'] as const;
/** D14's channel vocabulary, shared with LH6's hub. */
export const LEAD_CHANNELS = ['SMS', 'EMAIL', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS', 'CALL', 'LINKEDIN', 'IN_PERSON', 'LINK', 'OTHER'] as const;

/**
 * What the card's pill says for each status.
 *
 * VISIT_BOOKED has no pill of its own on the frame — the card shows the status
 * as CONTACTED and replaces the money slot with "Visit booked", which is the
 * one place DR 06 puts a state where a figure usually goes.
 */
export function leadPillOf(status: LeadStatusValue, temperature: LeadTemperatureValue | null = null): { label: string; tone: string } {
  // LH1: the pill reads the computed temperature for an open lead — the
  // status HOT the agent used to set is now the flag inside the score.
  if (temperature === 'HOT' && status !== 'CONVERTED' && status !== 'LOST') return { label: 'Hot', tone: 'hot' };
  switch (status) {
    case 'HOT':
      return { label: 'Hot', tone: 'hot' };
    case 'NEW':
      return { label: 'New', tone: 'new' };
    case 'CONTACTED':
    case 'VISIT_BOOKED':
      return { label: 'Contacted', tone: 'new' };
    case 'CONVERTED':
      return { label: 'Converted', tone: 'live' };
    case 'LOST':
      return { label: 'Lost', tone: 'neutral' };
  }
}

/** True while a lead is still worth an agent's time. */
export const isOpenLead = (status: LeadStatusValue): boolean =>
  status !== 'CONVERTED' && status !== 'LOST';

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time like "11:00"');

/**
 * The agent's own list — "23 publisher leads near you".
 *
 * `lat`/`lng` travel together or not at all, the same refinement browse makes:
 * half a point is not a place, and silently ignoring the half that arrived
 * would answer a distance-ranked question with an unranked list.
 */
/** AG-5: a lead's importance band. */
export const LEAD_IMPORTANCES = ['STANDARD', 'KEY', 'ENTERPRISE'] as const;

export const nearLeadsQuerySchema = listQuerySchema(LEAD_STATUSES, [
  // NEWEST first because it is the default, and the default has to be a sort
  // that works without a point: `NEAREST` needs somewhere to be near, and a
  // default that fails on a bare request is not a default.
  'NEWEST',
  'NEAREST',
  'ESTIMATE_DESC',
  'HOTTEST',
])
  .extend({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(100).default(25),
    side: z.enum(LEAD_SIDES).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    /** LH1: one temperature; the chips count every one under the other facets. */
    temperature: z.enum(LEAD_TEMPERATURES).optional(),
    /** LH2: one stage, or a comma list. */
    stage: z
      .string()
      .optional()
      .transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(LEAD_STAGE_VALUES)).optional()),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lng'],
  })
  .refine((query) => query.sort !== 'NEAREST' || query.lat !== undefined, {
    message: 'Nearest needs a point to be near',
    path: ['sort'],
  });
export type NearLeadsQuery = z.infer<typeof nearLeadsQuerySchema>;

/** The ops desk. Same facets, plus who it is assigned to. */
export const adminLeadsQuerySchema = listQuerySchema(LEAD_STATUSES, [
  'NEWEST',
  'OLDEST',
  'ESTIMATE_DESC',
  'HOTTEST',
]).extend({
  side: z.enum(LEAD_SIDES).optional(),
  temperature: z.enum(LEAD_TEMPERATURES).optional(),
  stage: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(LEAD_STAGE_VALUES)).optional()),
  city: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  /** `unassigned` is a real answer, not the absence of a filter. */
  assignedAgentId: z.string().trim().min(1).max(64).optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type AdminLeadsQuery = z.infer<typeof adminLeadsQuerySchema>;

const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "1450" or "1450.00"');

export const createLeadSchema = z.object({
  side: z.enum(LEAD_SIDES),
  businessName: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(60).optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.string().email().max(160).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  locality: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  interest: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(120).optional(),
  bestTimeFrom: clock.optional(),
  bestTimeTo: clock.optional(),
  /** Omit it and the platform quotes what it actually pays. See the README. */
  estimatedCommission: money.optional(),
  assignedAgentId: z.string().trim().min(1).max(64).optional(),
  /** AG-5: how important the lead is — routed to the grade the settings ask for. STANDARD unless ops says otherwise. */
  importance: z.enum(LEAD_IMPORTANCES).optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * A batch, as ops pastes one in. Bounded so one request cannot be a
 * migration. `dryRun` (Lot D, Q93) answers with the per-row report and
 * writes nothing — the preview before the paste.
 */
export const importLeadsSchema = z.object({
  source: z.string().trim().min(1).max(120),
  rows: z.array(createLeadSchema.omit({ source: true }).extend({ externalKey: z.string().trim().min(1).max(200).optional() })).min(1).max(500),
  dryRun: z.boolean().default(false),
});
export type ImportLeadRow = z.infer<typeof importLeadsSchema>['rows'][number];

/** What became of one row of an import. */
/** Lot V: `CITY_NOT_OPEN` — the row names a catalogued city whose rollout stage has lead feeds off. */
export const IMPORT_OUTCOMES = ['CREATED', 'DUPLICATE_LEAD', 'EXISTING_ACCOUNT', 'INVALID', 'WARNING', 'CITY_NOT_OPEN'] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
export type ImportRowReport = {
  /** 1-based, as the sheet numbers them. */
  row: number;
  outcome: ImportOutcome;
  /** The lead or account the row collided with, or the lead it became. */
  ref: string | null;
  message: string;
};

export const patchLeadSchema = createLeadSchema
  .partial()
  .extend({
    status: z.enum(LEAD_STATUSES).optional(),
    /** Clearing the agent puts the lead back in the open pool. */
    assignedAgentId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const logContactSchema = z.object({
  kind: z.enum(['CALLED', 'MESSAGED', 'NOTE', 'FOLLOW_UP']),
  note: z.string().trim().min(1).max(1000).optional(),
});

/** LH1: the agent's flag — on (renews the 14 days) or off. */
export const flagHotSchema = z.object({
  hot: z.boolean().default(true),
});

/* ── LH2: the stages ─────────────────────────────────────────────────── */


/** PATCH /leads/:id/stage — the desk's move; a loss carries its reason. */
export const moveStageSchema = z.object({
  stage: z.enum(LEAD_STAGE_VALUES),
  reason: z.enum(LEAD_LOST_REASON_VALUES).optional(),
  lostNote: z.string().trim().min(1).max(500).optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

/** POST /leads/:id/lost — the agent's loss. */
export const markLostSchema = z.object({
  reason: z.enum(LEAD_LOST_REASON_VALUES),
  note: z.string().trim().min(1).max(500).optional(),
});

/** POST /leads/:id/engaged — they replied. */
export const markEngagedSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  channel: z.enum(LEAD_CHANNELS).optional(),
});

/** POST /leads/:id/proposed — a proposal went out (LH7 attaches the record). */
export const markProposedSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
});

/** GET /leads/funnel */
export const funnelQuerySchema = z.object({
  side: z.enum(LEAD_SIDES).optional(),
  sourceId: z.string().trim().min(1).max(64).optional(),
  agentId: z.string().trim().min(1).max(64).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type FunnelQuery = z.infer<typeof funnelQuerySchema>;

/** LH1: Settings › Leads scoring's sibling — a source's editable fields. */
export const patchSourceSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    quality: z.number().min(0).max(15).optional(),
    isActive: z.boolean().optional(),
    quotaPerDay: z.number().int().min(1).max(100_000).nullable().optional(),
    termsAccepted: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

/**
 * Both optional (Lot D, Q93): with neither named, the lead's phone is checked
 * against the publisher and advertiser accounts and the match is linked.
 * Never both — a lead becomes one account.
 */
export const convertLeadSchema = z
  .object({
    publisherId: z.string().trim().min(1).max(64).optional(),
    advertiserId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((body) => !(body.publisherId && body.advertiserId), {
    message: 'A lead becomes one account, not both',
  });

export const DEFAULT_LEADS_PAGE_SIZE = DEFAULT_LIST_PAGE_SIZE;
export const MAX_LEADS_PAGE_SIZE = MAX_LIST_PAGE_SIZE;
