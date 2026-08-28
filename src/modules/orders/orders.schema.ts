import { z } from 'zod';

export const placeOrderSchema = z.object({
  listingId: z.string().min(1),
  campaignName: z.string().optional(),
  designUrl: z.string().url().optional(),
  budget: z.number().positive().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export const listOrdersQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export const meetingPlaceSchema = z.object({ meetingPlace: z.string().min(1) });
export const reasonSchema = z.object({ reason: z.string().optional() });
export const agentIdSchema = z.object({ agentId: z.string().min(1) });
export const slotTimeSchema = z.object({ slotTime: z.string().datetime() });
export const counterNoteSchema = z.object({ counterNote: z.string().optional() });
export const photoUrlSchema = z.object({ photoUrl: z.string().url() });
export const photoUrlsSchema = z.object({ photoUrls: z.array(z.string().url()).min(1) });
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
