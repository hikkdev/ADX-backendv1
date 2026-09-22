import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';

/** Lot E (Q99) added AUDIT — a data audit or poster check, paid at the visit rate like the rest. */
export const VISIT_KINDS = ['ONBOARDING', 'RENEWAL', 'FOLLOW_UP', 'SURVEY', 'AUDIT'] as const;
export type VisitKindValue = (typeof VISIT_KINDS)[number];

/** What the card and the diary call each kind. */
export const VISIT_KIND_LABELS: Record<VisitKindValue, string> = {
  ONBOARDING: 'Onboarding',
  RENEWAL: 'Renewal',
  FOLLOW_UP: 'Follow-up',
  SURVEY: 'Survey',
  AUDIT: 'Audit',
};
export const visitKindLabel = (kind: string): string => VISIT_KIND_LABELS[kind as VisitKindValue] ?? 'Visit';

export const VISIT_STATUSES = [
  'REQUESTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type VisitStatusValue = (typeof VISIT_STATUSES)[number];

/**
 * The A12 window: an offered visit that nobody answers goes back to the pool.
 * The same 25 minutes an order offer gets — the two clocks must agree or an
 * agent learns two rules for one thing.
 */
export const VISIT_OFFER_MINUTES = 25;

/**
 * DR 06's Visits list draws three chips — Today / Upcoming / Past — over one
 * status machine. They are windows on time, not statuses, so they are their own
 * facet. `scope` is computed on the server against the Indian day, because the
 * hosts run UTC and a phone reimplementing the boundary drifts from
 * `dayWindowIST`.
 */
export const VISIT_SCOPES = ['TODAY', 'UPCOMING', 'PAST'] as const;
export type VisitScopeValue = (typeof VISIT_SCOPES)[number];

/** What the card's pill says. Seven statuses, four pills. */
export function visitPillOf(status: VisitStatusValue): { label: string; tone: string } {
  switch (status) {
    case 'REQUESTED':
      return { label: 'New request', tone: 'warn' };
    case 'SCHEDULED':
      return { label: 'Scheduled', tone: 'new' };
    case 'IN_PROGRESS':
      return { label: 'In progress', tone: 'new' };
    case 'COMPLETED':
      return { label: 'Completed', tone: 'live' };
    case 'DECLINED':
    case 'EXPIRED':
    case 'CANCELLED':
      return { label: status === 'EXPIRED' ? 'Expired' : status === 'DECLINED' ? 'Declined' : 'Cancelled', tone: 'neutral' };
  }
}

export const myVisitsQuerySchema = listQuerySchema(VISIT_STATUSES, ['SOONEST', 'NEWEST']).extend({
  scope: z.enum(VISIT_SCOPES).default('TODAY'),
  kind: z.enum(VISIT_KINDS).optional(),
});
export type MyVisitsQuery = z.infer<typeof myVisitsQuerySchema>;

/** The dispatch board. ISO date narrows to one Indian day. */
export const adminVisitsQuerySchema = listQuerySchema(VISIT_STATUSES, ['SOONEST', 'NEWEST']).extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  agentId: z.string().trim().min(1).max(64).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(VISIT_KINDS).optional(),
  /** Lot E (Q99): one drive's visits. */
  campaignTag: z.string().trim().min(1).max(80).optional(),
});
export type AdminVisitsQuery = z.infer<typeof adminVisitsQuerySchema>;

export const createVisitSchema = z
  .object({
    kind: z.enum(VISIT_KINDS),
    /** Who the visit is to. Exactly one. */
    leadId: z.string().trim().min(1).max(64).optional(),
    publisherId: z.string().trim().min(1).max(64).optional(),
    advertiserId: z.string().trim().min(1).max(64).optional(),
    /** ADMIN dispatches to a named agent; an agent books for themselves. */
    agentId: z.string().trim().min(1).max(64).optional(),
    businessName: z.string().trim().min(1).max(160),
    locality: z.string().trim().min(1).max(120).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    scheduledFor: z.string().datetime().optional(),
    /** Lot E (Q99): groups the visits of one drive — "Delhi onboarding drive". */
    campaignTag: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine(
    (body) => [body.leadId, body.publisherId, body.advertiserId].filter(Boolean).length === 1,
    { message: 'A visit is to exactly one lead, publisher or advertiser' },
  );
export type CreateVisitInput = z.infer<typeof createVisitSchema>;

export const scheduleVisitSchema = z.object({ scheduledFor: z.string().datetime() });
export const rejectVisitSchema = z.object({ reason: z.string().trim().min(3).max(300) });
/**
 * LH10: a completion may carry its proof — a photo the agent uploaded as a
 * private file, and the fix their phone had at the moment. Both optional: a
 * visit completed without them is still a visit, and the QA sample is what
 * says the evidence was missing.
 */
export const completeVisitSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  proofFileId: z.string().trim().min(1).max(64).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});
/** G12-B: the position ping — the order lane's body (`orders.schema#locationSchema`), so the app sends one shape everywhere. */
export const visitLocationSchema = z.object({ latitude: z.number(), longitude: z.number() });

export const patchVisitSchema = z
  .object({
    agentId: z.string().trim().min(1).max(64).optional(),
    scheduledFor: z.string().datetime().nullable().optional(),
    status: z.enum(['CANCELLED']).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
