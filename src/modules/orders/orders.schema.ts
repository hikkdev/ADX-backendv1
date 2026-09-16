import { z } from 'zod';
import type { ListingCategory } from '../../shared/database';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE, listQuerySchema } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';
import { AGENT_REJECTION_REASONS } from './assignment/rejection-reasons';

export const placeOrderSchema = z.object({
  listingId: z.string().min(1),
  campaignName: z.string().optional(),
  designUrl: z.string().url().optional(),
  budget: z.number().positive().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

/**
 * Every state an order can be in. Named here so the board's chip row can count
 * each one, and so `?status=` is checked against the enum rather than cast.
 */
export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_PUBLISHER',
  'PUBLISHER_REJECTED',
  'PENDING_PRINT',
  'SELF_INSTALL',
  'PENDING_AGENT',
  'AGENT_REJECTED',
  'SLOT_PROPOSED',
  'SLOT_CONFIRMED',
  'IN_PROGRESS',
  'PENDING_OTP',
  'PENDING_APPROVAL',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * DR 10's order board (`5102:39707`).
 *
 * Replaces a schema whose `status` was a bare `z.string()` the repository cast
 * `status as any` — a typo or a comma list reached Postgres as an invalid enum
 * and came back a 500 — and whose `limit` had no maximum, so the endpoint
 * would attempt the whole table on request.
 *
 * `DUE` sorts on `slotTime`, the confirmed appointment; orders with no slot yet
 * sort last, because the column exists to work the day.
 */
export const adminOrdersQuerySchema = listQuerySchema(ORDER_STATUSES, ['NEWEST', 'OLDEST', 'DUE'])
  .extend({
    agentId: z.string().trim().min(1).max(64).optional(),
    /** Every order on one spot — the listing page's Bookings tab. */
    listingId: z.string().trim().min(1).max(64).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    /** E7-2: the advertiser account, reached through the campaign the order was raised from. */
    advertiserId: z.string().trim().min(1).max(64).optional(),
    /**
     * E7-2: a window. An order is in it when its slot falls inside, or its
     * startDate..endDate flight overlaps it. Either bound alone is open-ended.
     */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: 'from must not be after to', path: ['to'] });
export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;

/** The four places a spot can be — `listings`' vocabulary, pinned to the generated enum. */
export const CALENDAR_CATEGORIES = ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const satisfies readonly ListingCategory[];

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DEFAULT_DAYS = 30;
const CALENDAR_MAX_DAYS = 366;

/**
 * Lot G (Q114): the booking calendar's query — a window over the ACTIVE
 * listings in a filter. Today for thirty days when no window is asked for;
 * a `to` alone runs from today; never more than a year, because the grid
 * draws every day of it. Listings, not orders, are what is paged, so the
 * facets are a listing's: city, category, and a search over its title,
 * address, city and display id.
 */
export const calendarQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    city: z.string().trim().min(1).max(80).optional(),
    category: z.enum(CALENDAR_CATEGORIES).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  })
  .transform((query) => {
    const now = new Date();
    const from = query.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = query.to ?? new Date(from.getTime() + CALENDAR_DEFAULT_DAYS * DAY_MS - 1);
    return { ...query, from, to };
  })
  .refine((query) => query.from <= query.to, { message: 'from must not be after to', path: ['to'] })
  .refine((query) => query.to.getTime() - query.from.getTime() <= CALENDAR_MAX_DAYS * DAY_MS, {
    message: `The calendar shows at most ${CALENDAR_MAX_DAYS} days at a time`,
    path: ['to'],
  });
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

/**
 * DR 06's two "my orders" lists — the publisher's Bookings (`4428:1833`) and
 * the agent's Orders (`4420:483`).
 *
 * Both draw four chips over the fourteen-state machine, so the facet has to be
 * a comma list of real statuses; `?as=` stays exactly as it was, including its
 * deliberate 403 when a caller asks for a lane it does not hold.
 */
export const myOrdersQuerySchema = listQuerySchema(ORDER_STATUSES, ['NEWEST', 'OLDEST', 'DUE']).extend({
  as: z.enum(['publisher', 'advertiser', 'agent']).optional(),
});
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;


/*
 * Optional, because the default is the address the publisher gave at sign-up.
 * A publisher meeting an agent somewhere else for one booking can say so; the
 * ordinary case sends nothing and the accept still works.
 */
export const meetingPlaceSchema = z.object({
  meetingPlace: z.string().trim().min(1).optional(),
});
export const reasonSchema = z.object({ reason: z.string().optional() });

/*
 * Lot D (Q51/Q90): the ops moves. Every one carries a mandatory reason — it
 * goes on the audit row, and an override with no reason is an override nobody
 * can answer for later. The publisher's out-of-band acceptance also records
 * how they said yes.
 */
const opsReason = z.string().trim().min(3, 'Say why — it goes on the record').max(500);
export const opsReasonSchema = z.object({ reason: opsReason });
export const opsAcceptPublisherSchema = z.object({
  reason: opsReason,
  consentNote: z.string().trim().min(3, 'Record how the publisher agreed').max(500),
});
export const reassignAgentSchema = z.object({ agentId: z.string().trim().min(1), reason: opsReason });
/** The ADMIN cancel. The reason is no longer optional: it is written on the order. */
export const adminCancelSchema = z.object({ reason: opsReason });

/**
 * A8 — the agent's rejection, one of the five drawn reasons. OTHER carries the
 * agent's own words and is refused without them; the note is otherwise
 * optional colour on a coded reason.
 */
export const agentRejectSchema = z
  .object({
    reason: upperEnum(AGENT_REJECTION_REASONS),
    note: z.string().trim().max(300).optional(),
  })
  .refine((body) => body.reason !== 'OTHER' || Boolean(body.note && body.note.length > 0), {
    message: 'Say what the reason is',
    path: ['note'],
  });
/**
 * Lot B (Q102): the per-order installation figure ops may type when the
 * platform is on PER_ORDER. A decimal string in rupees, like every other
 * amount on the wire; ignored by the resolver while the platform is on FLAT,
 * but stored either way so switching modes later reads what was typed.
 */
const agentFee = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount in rupees');
export const agentIdSchema = z.object({ agentId: z.string().min(1), agentFee: agentFee.optional() });
export const printReadySchema = z.object({ agentFee: agentFee.optional() });
/* The frame's accuracy checkbox. Required rather than defaulted: an attestation
   nobody actively made is not an attestation. */
export const attestationSchema = z.object({ attested: z.boolean() });
/*
 * P2. Who puts the advertisement up, chosen once per booking.
 *
 * A closed pair rather than a boolean, because the two answers are not each
 * other's negation on the money: `PUBLISHER` is the publisher's own labour and
 * `ADX` is a job ADX dispatches an agent to. The old `Listing.agentCanInstall`
 * boolean said neither, defaulted to true and was never written by anything —
 * which is exactly why the self-install branch could not be reached.
 */
export const chooseFulfilmentSchema = z.object({
  installBy: z.enum(['PUBLISHER', 'ADX']),
});

export const slotTimeSchema = z.object({ slotTime: z.string().datetime() });
export const counterNoteSchema = z.object({ counterNote: z.string().optional() });
export const photoUrlSchema = z.object({ photoUrl: z.string().url() });
export const photoUrlsSchema = z.object({ photoUrls: z.array(z.string().url()).min(1) });

/*
 * The pickup photograph is optional.
 *
 * `agentCollectPrints` already treats it that way — the shot is evidence of what
 * was handed over, not the gate on starting the job — and an agent whose camera
 * permission was refused must still be able to record the collection. Requiring
 * it here would have made that agent unable to start at all.
 */
export const optionalPhotoUrlSchema = z.object({ photoUrl: z.string().url().optional() });
/** A2 with A9: the collected-material photo, and the package code if it was scanned. */
export const collectPrintsSchema = z.object({
  photoUrl: z.string().url().optional(),
  qrId: z.string().min(1).optional(),
});

/**
 * Condition photos, each carrying the frame's own name for that shot.
 *
 * `labels` is positional and may be shorter than `photoUrls`, or absent: the
 * guided sequence names four proofs, and an agent who adds a fifth of their own
 * has nothing to call it. Losing a photograph that is already taken over a
 * missing caption would be the wrong trade, so unnamed shots are stored unnamed.
 */
export const conditionPhotosSchema = z.object({
  photoUrls: z.array(z.string().url()).min(1),
  labels: z.array(z.string().min(1).nullable()).optional(),
});

/** The installed-advertisement shot, with which guided shot it answers. */
export const installationPhotoSchema = z.object({
  photoUrl: z.string().url(),
  label: z.string().min(1).optional(),
});
export const rejectConditionSchema = z.object({
  reason: z.string().min(1),
  photoUrls: z.array(z.string().url()).min(1),
});
export const completionOtpSchema = z.object({ otp: z.string().length(6) });

export const checkInSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  qrToken: z.string().min(1),
});

export const locationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

/**
 * The publisher's own check-in on the self-install lane.
 *
 * Everything is optional, unlike the agent's `checkInSchema`. The agent's scan
 * is proof they are at the right place and the whole point of the call; the
 * publisher already owns the spot, so this records when the work happened and,
 * if the device offered a fix, where from. The endpoint used to parse no body
 * at all, which made the app's declared `{latitude, longitude, qrToken}`
 * fiction — this is that body, taken seriously.
 */
export const selfCheckInSchema = z.object({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  qrToken: z.string().min(1).optional(),
});
