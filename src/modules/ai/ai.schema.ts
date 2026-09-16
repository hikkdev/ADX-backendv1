import { z } from 'zod';

/**
 * A draft key is the client's own identifier for a listing it has not created
 * yet. Bounded and pattern-checked because it becomes part of a storage key.
 */
const draftKey = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque key of letters, digits, dashes or underscores');

const descriptionContextSchema = z.object({
  title: z.string().max(200).optional(),
  venueType: z.string().max(120).optional(),
  mediaType: z.string().max(120).optional(),
  placement: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  address: z.string().max(400).optional(),
  widthFt: z.string().max(20).optional(),
  heightFt: z.string().max(20).optional(),
  material: z.string().max(120).optional(),
  targetAudience: z.string().max(400).optional(),
  footfallNote: z.string().max(400).optional(),
  uniqueSellingPoint: z.string().max(400).optional(),
});

export const generateDescriptionSchema = z
  .object({
    listingId: z.string().min(1).optional(),
    draftKey: draftKey.optional(),
    /**
     * What is in the field right now. Required rather than optional: the blank
     * rule is enforced on this, and a missing value must not read as "blank"
     * for a client that simply forgot to send it.
     */
    current: z.string().max(5000),
    context: descriptionContextSchema.default({}),
  })
  .refine((body) => Boolean(body.listingId) || Boolean(body.draftKey), {
    message: 'Either listingId or draftKey is required',
  });

export const quotaQuerySchema = z.object({
  listingId: z.string().min(1).optional(),
  draftKey: draftKey.optional(),
});
