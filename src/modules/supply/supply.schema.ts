import { z } from 'zod';

/** A calendar day, YYYY-MM-DD — the way a permit prints its end date. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const acceptPlatformSchema = z.object({
  publisherId: z.string().min(1),
});

export const acceptListingSchema = z.object({
  attemptId: z.string().min(1),
});

export const createAttemptSchema = z.object({
  publisherId: z.string().min(1).optional(),
  origin: z.enum(['SELF', 'AGENT', 'ADMIN_SINGLE', 'ADMIN_BULK', 'SCRAPE']),
  sourceFilename: z.string().max(255).optional(),
  note: z.string().max(500).optional(),
});

/**
 * One imported row. Coordinates are optional because a spreadsheet often only
 * carries an address — geocoding fills them in, and a listing cannot be
 * site-verified until it has them.
 */
export const attemptListingSchema = z.object({
  title: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  city: z.string().max(120).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  category: z.enum(['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA']),
  subType: z.string().max(120).optional(),
  size: z.string().max(120).optional(),
  monthlyPrice: z.number().positive().optional(),
  /** Canonical. Either this or `monthlyPrice`; the other is derived. */
  ratePerDay: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/)
    .refine((v) => Number(v) > 0, 'A rate must be greater than zero')
    .optional(),
  /* Structured attributes the pricing engine matches comparables on. */
  sizeClassId: z.string().min(1).optional(),
  sizeClassSlug: z.string().min(1).max(80).optional(),
  materialId: z.string().min(1).optional(),
  materialSlug: z.string().min(1).max(80).optional(),
  mediaTypeId: z.string().min(1).optional(),
  /** Resolved through the similarity threshold, once per distinct name. */
  mediaTypeName: z.string().min(2).max(120).optional(),
  removability: z.enum(['PERMANENT', 'REMOVABLE']).optional(),
}).refine((v) => v.monthlyPrice !== undefined || v.ratePerDay !== undefined, {
  message: 'A listing needs a price — send ratePerDay, or monthlyPrice for the old shape',
  path: ['ratePerDay'],
});

export const addListingsSchema = z.object({
  listings: z.array(attemptListingSchema).min(1).max(500),
});

export const submitDocumentSchema = z.object({
  kind: z.enum([
    'DISPLAY_AGREEMENT',
    'OWNER_NOC',
    'ADDRESS_PROOF',
    'MUNICIPAL_PERMIT',
    'OTHER',
  ]),
  url: z.string().url(),
  /** QR-24: when this permit or agreement runs out — a renewal carries the new date; approved, it extends the listing's term. */
  expiresAt: isoDay.optional(),
});

/* ── QR-24: the right to sell a space, and its term ──────────────────── */

export const RIGHTS_BASES = ['OWNED', 'LEASED', 'LICENSED', 'PERMIT'] as const;

export const rightsSchema = z
  .object({
    basis: z.enum(RIGHTS_BASES),
    /** The day the lease, licence or permit runs out; none for a space the publisher owns. */
    validUntil: isoDay.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.basis !== 'OWNED' && !value.validUntil) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validUntil'], message: 'A lease, licence or permit needs the day it runs out.' });
    }
  });
export type RightsInput = z.infer<typeof rightsSchema>;

export const reviewDocumentSchema = z
  .object({
    approve: z.boolean(),
    rejectionReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.approve || !!v.rejectionReason, {
    message: 'A rejection needs a reason',
    path: ['rejectionReason'],
  });

/** One named shot. The label is the milestone requirement it answers. */
const verificationPhotoSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1).max(200).optional(),
});

/**
 * Two shapes, one endpoint.
 *
 * `photoUrl` is the original single-shot submission and still what a
 * publisher's own re-verification sends. `photos` is the guided agent visit,
 * which walks a template's named proofs one at a time and then submits them
 * together — four calls would have been four verifications for one visit, and a
 * reviewer would have had to guess which four belonged to each other.
 *
 * Twelve is a ceiling rather than a rule: no template asks for that many, and
 * an unbounded array on a public write is how a mobile retry loop fills a table.
 */
export const submitVerificationSchema = z
  .object({
    type: z.enum(['AGENT_INITIAL', 'SELF_REVERIFICATION']),
    photoUrl: z.string().url().optional(),
    photos: z.array(verificationPhotoSchema).min(1).max(12).optional(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    qrScanned: z.boolean().optional(),
    capturedAt: z.coerce.date(),
    orderId: z.string().optional(),
  })
  .refine((v) => v.photoUrl !== undefined || (v.photos?.length ?? 0) > 0, {
    message: 'A verification needs at least one photo',
    path: ['photos'],
  });

export const reviewVerificationSchema = z
  .object({
    approve: z.boolean(),
    rejectionReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.approve || !!v.rejectionReason, {
    message: 'A rejection needs a reason',
    path: ['rejectionReason'],
  });

export const createClaimSchema = z.object({
  listingId: z.string().min(1),
  claimantPublisherId: z.string().min(1),
  evidenceNote: z.string().max(1000).optional(),
});

export const decideClaimSchema = z
  .object({
    approve: z.boolean(),
    decisionNote: z.string().max(1000).optional(),
  })
  .refine((v) => v.approve || !!v.decisionNote, {
    message: 'A rejected claim needs a decision note',
    path: ['decisionNote'],
  });

export const contactAttemptSchema = z.object({
  channel: z.enum(['CALL', 'SMS', 'EMAIL', 'WHATSAPP', 'IN_APP']),
  outcome: z.string().min(1).max(200),
  note: z.string().max(1000).optional(),
});
