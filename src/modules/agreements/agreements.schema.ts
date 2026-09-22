import { z } from 'zod';

/**
 * All six kinds. The supply and advertisers routes each accept only their own
 * platform click; the transaction kinds (Lot D, Q123) are recorded by the
 * module that owns the transaction — campaigns, packages, orders — through
 * this module's `recordAcceptance`.
 */
export const agreementKindSchema = z.enum([
  'PLATFORM',
  'LISTING',
  'ADVERTISER_PLATFORM',
  'INSERTION_ORDER',
  'PACKAGE_SALE',
  'JOB_TERMS',
  'AGENT_PUBLISHER_PLATFORM',
  'AGENT_ADVERTISER_PLATFORM',
  // DS-1: the three signed-only kinds.
  'EMPLOYEE_APPOINTMENT',
  'PRINT_PARTNER_SERVICE',
  'PUBLISHER_LICENCE',
]);

export const partyTypeSchema = z.enum(['publisher', 'advertiser', 'agent']);

const title = z.string().trim().min(1).max(200);
/** Markdown. Generous: a platform agreement with schedules runs to pages. */
const body = z.string().min(1).max(200_000);
const changeNote = z.string().trim().max(500);

export const createTemplateSchema = z.object({
  kind: agreementKindSchema,
  title,
  body,
  changeNote: changeNote.optional(),
  /** Go live in the same call. Off by default: read it over first. */
  activate: z.boolean().optional(),
  /**
   * Lot D (Q55): a platform-scope version every party must accept again
   * before transacting. Ignored on the transaction kinds, which are accepted
   * per deal at whatever version is live.
   */
  requiresReacceptance: z.boolean().optional(),
});

export const updateTemplateSchema = z
  .object({
    title: title.optional(),
    body: body.optional(),
    changeNote: changeNote.nullable().optional(),
    requiresReacceptance: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Nothing to change',
  });

export const acceptanceFilterSchema = z.object({
  publisherId: z.string().min(1).optional(),
  advertiserId: z.string().min(1).optional(),
  /** Lot D: JOB_TERMS are the agent's own. */
  agentId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  kind: agreementKindSchema.optional(),
  /** E7-3: the transaction anchors — the acceptance behind one campaign, order, sale or attempt. */
  campaignId: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  packageSaleId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
});

/** E7-3: `POST /templates/:id/activate` may carry the re-acceptance switch, applied with the activation. */
export const activateTemplateSchema = z
  .object({ requiresReacceptance: z.boolean().optional() })
  .partial()
  .default({});

/** `GET /agreements/stale?kind=` — only the platform-scope kinds can be behind. */
export const staleQuerySchema = z.object({
  kind: z.enum(['PLATFORM', 'ADVERTISER_PLATFORM']),
});
