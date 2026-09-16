import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';

/** Lot D (Q53): WAITING is "on the requester" — the SLA clock is paused. */
export const TICKET_STATUSES = ['OPEN', 'WAITING', 'CLOSED'] as const;
/** What the owner's own status route may set: they open and close, never pause. */
export const OWNER_TICKET_STATUSES = ['OPEN', 'CLOSED'] as const;
export const TICKET_KINDS = ['ISSUE', 'FEEDBACK'] as const;
export const TICKET_PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

/**
 * What a ticket can be about — pinned, the way the order rejection reasons
 * are, so the desk sorts by a fixed set rather than by whatever a screen
 * typed. Read off DR 07: the Report-an-issue chips (App bug, Order issue,
 * Payment), the Support & Help topic tiles (Orders, Payouts, Listings,
 * Account), and ACCESS for the request a publisher raises when they want an
 * agent let into their account (the QR-grant flow, which predates this set).
 */
export const TICKET_CATEGORIES = ['APP_BUG', 'ORDER', 'PAYMENT', 'LISTING', 'ACCOUNT', 'ACCESS', 'OTHER'] as const;
/** The Suggest-a-feature chips: Idea, Problem, Content issue. */
export const FEEDBACK_CATEGORIES = ['IDEA', 'PROBLEM', 'CONTENT'] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Older callers sent lower-case plurals ("listings", "payouts"); the set is
 * upper-case singulars. Known synonyms fold in; anything else is unknown and
 * the schema refuses it, which is the point of pinning the set.
 */
const SYNONYMS: Record<string, string> = {
  LISTINGS: 'LISTING',
  ORDERS: 'ORDER',
  PAYMENTS: 'PAYMENT',
  PAYOUT: 'PAYMENT',
  PAYOUTS: 'PAYMENT',
  BUG: 'APP_BUG',
  APP: 'APP_BUG',
  APP_ISSUE: 'APP_BUG',
  ORDER_ISSUE: 'ORDER',
  PAYMENT_ISSUE: 'PAYMENT',
  LISTING_ISSUE: 'LISTING',
  ACCOUNT_ISSUE: 'ACCOUNT',
  OTHERS: 'OTHER',
  CONTENT_ISSUE: 'CONTENT',
};

export function normaliseCategory(raw: string | undefined, kind: (typeof TICKET_KINDS)[number]): string | null {
  const key = (raw ?? (kind === 'FEEDBACK' ? 'IDEA' : 'OTHER')).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const value = SYNONYMS[key] ?? key;
  const allowed: readonly string[] = kind === 'FEEDBACK' ? FEEDBACK_CATEGORIES : TICKET_CATEGORIES;
  return allowed.includes(value) ? value : null;
}

export const listTicketsQuerySchema = z.object({
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
  status: upperEnum(TICKET_STATUSES).optional(),
  kind: upperEnum(TICKET_KINDS).optional(),
  search: z.string().optional(),
});

export const createTicketSchema = z
  .object({
    kind: upperEnum(TICKET_KINDS).default('ISSUE'),
    /** Optional for feedback, whose title is its first line. */
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(4000),
    category: z.string().optional(),
    relatedOrderId: z.string().optional(),
    /** The report's upload or the feedback's screenshot, already stored through POST /upload. */
    attachmentUrls: z.array(z.string().url()).max(5).default([]),
    /** DR 07's Rate your experience: 1–5, and only on feedback. */
    rating: z.coerce.number().int().min(1).max(5).optional(),
    /** What stood out — that frame's chips, as short labels. */
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  })
  .transform((input, ctx) => {
    const category = normaliseCategory(input.category, input.kind);
    if (!category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message:
          input.kind === 'FEEDBACK'
            ? `Feedback is one of ${FEEDBACK_CATEGORIES.join(', ')}`
            : `Category is one of ${TICKET_CATEGORIES.join(', ')}`,
      });
      return z.NEVER;
    }
    // A score on an issue would be a number nobody asked for and nobody reads.
    if (input.rating !== undefined && input.kind !== 'FEEDBACK') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rating'], message: 'Only feedback carries a rating' });
      return z.NEVER;
    }
    const title = input.title ?? firstLine(input.description);
    return { ...input, category, title };
  });

/** The first sentence or line of a description, as a title for feedback that gave none. */
export function firstLine(text: string, limit = 80): string {
  const line = text.split(/\r?\n/).find((part) => part.trim())?.trim() ?? text.trim();
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

/**
 * `internal` (Lot D, Q53) is an ops note the requester never sees; ADMIN
 * only, enforced by the service. Lot I: `attachmentFileId` is a private
 * SUPPORT_ATTACHMENT file already stored through `POST /upload`, the
 * caller's own; with one, the text may be empty (the file is the message).
 */
export const addReplySchema = z
  .object({
    message: z.string().trim().max(4000).default(''),
    internal: z.boolean().default(false),
    attachmentFileId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((body) => body.message.length > 0 || body.attachmentFileId !== undefined, {
    message: 'A reply needs a message or an attachment',
    path: ['message'],
  });
export type AddReplyInput = z.infer<typeof addReplySchema>;

/* ── Lot I: live chat ─────────────────────────────────────────────── */

/** The first message of a live chat — the thread it opens is titled from its first line. */
export const liveStartSchema = z.object({
  message: z.string().trim().max(4000).default(''),
  relatedOrderId: z.string().trim().min(1).max(64).optional(),
  attachmentFileId: z.string().trim().min(1).max(64).optional(),
}).refine((body) => body.message.length > 0 || body.attachmentFileId !== undefined, {
  message: 'Say something, or attach a file',
  path: ['message'],
});
export type LiveStartInput = z.infer<typeof liveStartSchema>;

export const presenceSchema = z.object({ online: z.boolean() });
export const typingSchema = z.object({ typing: z.boolean() });
export const reassignSchema = z.object({ adminUserId: z.string().trim().min(1).max(64) });
export const convertSchema = z.object({ to: z.literal('TICKET') });

export const cannedReplyCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  team: z.string().trim().min(1).max(60).nullable().default(null),
});
export const cannedReplyPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
    team: z.string().trim().min(1).max(60).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export const cannedQuerySchema = z.object({
  team: z.string().trim().min(1).max(60).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/** The live inbox: OPEN live chats on the list contract — `mine` is the caller's, `unassigned` the ones nobody holds. */
export const liveInboxQuerySchema = listQuerySchema(['OPEN'], ['WAITING', 'NEWEST', 'OLDEST']).extend({
  mine: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type LiveInboxQuery = z.infer<typeof liveInboxQuerySchema>;

export const updateTicketStatusSchema = z.object({ status: upperEnum(OWNER_TICKET_STATUSES) });

/**
 * Lot D (Q53/Q91): the ops patch. WAITING pauses the clock; OPEN resumes it;
 * a priority change resets both due dates; `assignedAdminUserId` is the ops
 * owner (distinct from the field agent `assign` puts on the request) and
 * `null` takes them off; `team` is a free label the desk sorts by.
 */
export const patchTicketSchema = z
  .object({
    status: upperEnum(TICKET_STATUSES).optional(),
    priority: upperEnum(TICKET_PRIORITIES).optional(),
    team: z.string().trim().min(1).max(60).nullable().optional(),
    assignedAdminUserId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchTicketInput = z.infer<typeof patchTicketSchema>;

/**
 * Putting an agent on a request.
 *
 * `null` unassigns, which is a real thing ops needs — an agent goes off shift,
 * or the wrong one was picked. It is not the same as closing the ticket, and
 * conflating the two would leave a request nobody owns looking resolved.
 */
export const assignTicketSchema = z.object({
  assignedAgentId: z.string().min(1).nullable(),
});

/**
 * The ops queue on the list contract (Lot D, Q53): `?q=&status=&sort=&page=&pageSize=`
 * plus the desk's own facets. `mine` is the caller's own tickets (the ops
 * owner, not the field agent); `breached` is either clock run out; `q`
 * searches the number, the title and the description.
 */
const flag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();
export const opsTicketQuerySchema = listQuerySchema(TICKET_STATUSES, ['OLDEST', 'NEWEST', 'DUE']).extend({
  kind: upperEnum(TICKET_KINDS).optional(),
  priority: upperEnum(TICKET_PRIORITIES).optional(),
  /** Only the ones no field agent is on yet. */
  unassigned: flag,
  mine: flag,
  breached: flag,
  team: z.string().trim().min(1).max(60).optional(),
});
export type OpsTicketQuery = z.infer<typeof opsTicketQuerySchema>;
