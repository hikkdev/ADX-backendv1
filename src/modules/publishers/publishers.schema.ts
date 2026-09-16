import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';
import { kycQueueStateSchema } from '../../shared/kyc-state';

/**
 * DR 06's Publisher · Listings chips (`4428:1741`): All / Available /
 * Occupied / Inactive.
 *
 * Not `ListingStatus` values. A spot is AVAILABLE when it is live and nothing
 * is running on it, OCCUPIED when it is live and something is, and INACTIVE
 * when it is not live at all — so the facet is the shelf the publisher sees
 * rather than the lifecycle the platform keeps.
 */
export const LISTING_SHELVES = ['AVAILABLE', 'OCCUPIED', 'INACTIVE'] as const;
export type ListingShelf = (typeof LISTING_SHELVES)[number];

export const myListingsQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  shelf: z.enum(LISTING_SHELVES).optional(),
  sort: z.enum(['NEWEST', 'OLDEST', 'RATE_ASC', 'RATE_DESC', 'TITLE']).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type MyListingsQuery = z.infer<typeof myListingsQuerySchema>;

export const PUBLISHER_TYPES = ['INDIVIDUAL', 'BUSINESS', 'NGO', 'POLITICAL'] as const;

/**
 * E10-1: `GET /publishers` for ADMIN — the console's roster. `q` searches
 * name, display id, city and mobile; `category=KYC` is the tab name the UI
 * always sent (verified only). The page pair turns the answer into the list
 * contract; without `page` in the query the bare array stays, one release.
 */
export const PUBLISHER_KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'] as const;
export const publisherRosterQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(DEFAULT_LIST_PAGE_SIZE).transform((value) => Math.min(MAX_LIST_PAGE_SIZE, value)),
});
export type PublisherRosterQuery = z.infer<typeof publisherRosterQuerySchema>;

/**
 * E12-B: the bare path — no `page` in the query — is the old handler's, and
 * the old handler ignored what it did not read. An empty `q=` (a cleared
 * search box), an empty `category=`, and a `pageSize` that is not a number
 * (nobody asked for a page) are dropped here, not refused: `q` and
 * `category` trim to nothing and become absent, and the page pair is not
 * in the schema at all, so `z.object` strips it. The list-contract path
 * keeps `publisherRosterQuerySchema` and its validation.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
export const publisherBareQuerySchema = z.object({
  q: optionalText(120),
  category: optionalText(40),
});
export type PublisherBareQuery = z.infer<typeof publisherBareQuerySchema>;

export const createPublisherSchema = z.object({
  /**
   * Q29: an ADMIN may open a publisher account from the desk, and may say
   * whose book it belongs to. Ignored on the agent path — an agent's own
   * publishers are attributed to them by their session, never by a body field.
   */
  attributeToAgentId: z.string().trim().min(1).max(64).optional(),
  /** Where to meet them. Optional at creation, asked for before a booking. */
  address: z.string().trim().min(1).optional(),
  name: z.string().min(1),
  mobile: z.string().min(10),
  email: z.string().email().optional(),
  type: upperEnum(PUBLISHER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

// Mobile is absent on purpose: it identifies the publisher and is not editable
// through this endpoint.
export const updatePublisherSchema = z.object({
  address: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  type: upperEnum(PUBLISHER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const registerPublisherSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

/**
 * PATCH /publishers/me — DR 08 Steps 2–4, typed by the publisher. Mobile is
 * absent on purpose: it is the identity, not a detail.
 */
export const updateMyProfileSchema = z.object({
  name: z.string().trim().min(1).optional(),
  email: z.string().email().optional(),
  type: upperEnum(PUBLISHER_TYPES).optional(),
  address: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z.string().trim().min(1).optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN')
    .optional(),
  contactName: z.string().trim().min(1).optional(),
  contactMobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number').optional(),
  contactEmail: z.string().email().optional(),
});

export const GOV_ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE'] as const;
export const ADDRESS_PROOF_TYPES = ['UTILITY_BILL', 'RENT_AGREEMENT', 'BANK_STATEMENT'] as const;

export const submitKycSchema = z.object({
  /** Lot F: the onboarding-manifest version the phone rendered — pinned on the row at the first submission. */
  manifestVersion: z.number().int().positive().optional(),
  aadhaarFrontUrl: z.string().url().optional(),
  aadhaarBackUrl: z.string().url().optional(),
  panFrontUrl: z.string().url().optional(),
  panBackUrl: z.string().url().optional(),
  gstUrl: z.string().url().optional(),
  addressProofUrl: z.string().url().optional(),
  bankStatement: z.string().url().optional(),
  // DR 08 self-service capture, Steps 6–10.
  govIdType: upperEnum(GOV_ID_TYPES).optional(),
  govIdFrontUrl: z.string().url().optional(),
  govIdBackUrl: z.string().url().optional(),
  panNumber: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').optional(),
  panSignatureUrl: z.string().url().optional(),
  addressProofType: upperEnum(ADDRESS_PROOF_TYPES).optional(),
  selfieUrl: z.string().url().optional(),
  // Business / NGO documents ported from legacy AdSpaceKyc — optional, only
  // relevant for COMMERCIAL / NGO publisher types
  businessRegCertUrl: z.string().url().optional(),
  directorIdUrl: z.string().url().optional(),
  businessAddressProofUrl: z.string().url().optional(),
  adAuthLetterUrl: z.string().url().optional(),
  ngoRegCertUrl: z.string().url().optional(),
  ngoAddressProofUrl: z.string().url().optional(),
  ngoTaxExemptionCertUrl: z.string().url().optional(),
  ngoOperationalOverviewUrl: z.string().url().optional(),
});

/** Lot D (Q42): the document columns a per-document decision may name. */
export const PUBLISHER_KYC_DOCUMENT_FIELDS: readonly string[] = Object.keys(submitKycSchema.shape).filter(
  (key) => key.endsWith('Url') || key === 'bankStatement',
);

// A rejection without a reason is useless to the publisher, so the schema
// requires one rather than leaving it to the caller.
/** D7: the ADMIN queue's filters. `unassigned` is the self-onboarded switch. N3-B: `state` is the facet, `status` its alias; `q` the search box. */
export const kycQueueQuerySchema = z.object({
  status: upperEnum(['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'] as const).optional(),
  /** N3-B: one of the six party states — AWAITING_DOCUMENTS, REQUESTED, PENDING, NEEDS_INFO, REJECTED, VERIFIED. */
  state: kycQueueStateSchema,
  /** N3-B: the publisher's name, display id, mobile, email or contact mobile contains. */
  q: z.string().trim().min(1).max(120).optional(),
  /** Lot D (Q119): who is working the case — a filter, not ownership. */
  assignedTo: z.enum(['me', 'none']).optional(),
  /** Lot D (Q129): the Digio facets — `stuck` is initiated over 24 h ago with no webhook. */
  method: upperEnum(['MANUAL', 'DIGIO'] as const).optional(),
  digioStatus: z.enum(['pending', 'stuck']).optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Lot G (Q127/142): the escalated only (`true`), or none of them (`false`). */
  escalated: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Lot N: only the requested-and-not-yet-submitted (`true`) — the desk's ask with no documents in — or none of them (`false`). */
  requested: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /**
   * Absent means "what needs me now": breaches of the KYC review SLA first,
   * then oldest submission. Naming a sort takes that away and gives the plain
   * submission order, which is what a reviewer working a backlog in order
   * wants.
   */
  sort: z.enum(['oldest', 'newest']).optional(),
});
export type KycQueueQuery = z.infer<typeof kycQueueQuerySchema>;

export const reviewKycSchema = z
  .object({
    status: upperEnum(['VERIFIED', 'REJECTED'] as const),
    rejectionReason: z.string().optional(),
    /** Lot D (Q42): what the reviewer said, kept on the record beside who they were. */
    reviewNote: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => d.status !== 'REJECTED' || (d.rejectionReason && d.rejectionReason.trim().length > 0),
    { message: 'rejectionReason is required when status is REJECTED', path: ['rejectionReason'] },
  );
