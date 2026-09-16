import { z } from 'zod';

const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "1200" or "1200.50"');

const grade = z.enum(['PREMIUM', 'A', 'B', 'C']);

const isoDate = z.string().datetime().nullable().optional();

export const createCardSchema = z.object({
  name: z.string().min(2).max(120),
  cityId: z.string().min(1).nullable().optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate,
  // A floor above the card rate would make every listing need signing off, and
  // a floor of zero would make the gate decorative.
  floorPct: z
    .string()
    .regex(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/, 'Expected a fraction between 0 and 1')
    .optional(),
  roundingRupees: z.number().int().min(0).max(10000).optional(),
  // Lot E (Q97): the publisher's time to raise a rate a revised card left
  // under the floor before a rejected case unpublishes it. Zero is allowed —
  // an immediate floor — but a year is not a grace, it is a policy.
  graceDays: z.number().int().min(0).max(90).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateCardSchema = createCardSchema.partial();

export const entriesSchema = z.object({
  entries: z
    .array(
      z.object({
        mediaTypeId: z.string().min(1),
        grade,
        /** Null means "not sold at this grade" — different from zero. */
        ratePerDay: money.nullable(),
      })
    )
    .max(2000),
});

export const cardListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED']).optional(),
});

export const requestApprovalSchema = z.object({
  listingId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

export const decideApprovalSchema = z.object({
  approve: z.boolean(),
  note: z.string().max(1000).optional(),
});

/**
 * E10-2: `?source=` and `?listingId=` beside `?status=`; `?page=` / `?pageSize=`
 * turn the answer into the list contract. Without either the bare array
 * stays, one release.
 */
export const approvalListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  source: z.enum(['PUBLISH_REQUEST', 'CARD_REVISION']).optional(),
  listingId: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * E10-2: `POST /rate-cards/:id/impact/dry-run` — a draft grid, and
 * optionally the floor and grace the draft would carry, measured against the
 * card's listings without touching the card.
 */
export const impactDryRunSchema = z.object({
  entries: entriesSchema.shape.entries,
  floorPct: createCardSchema.shape.floorPct,
  graceDays: createCardSchema.shape.graceDays,
});

export const quoteSchema = z.object({
  mediaTypeId: z.string().min(1),
  grade: grade.optional(),
  cityId: z.string().min(1).nullable().optional(),
  factors: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        kind: z.enum(['MULTIPLIER', 'BASE_ADJUST']),
        value: z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/, 'Expected a number'),
      })
    )
    .max(50)
    .optional(),
});
