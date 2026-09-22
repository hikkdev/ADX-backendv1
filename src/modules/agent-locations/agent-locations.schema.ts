import { z } from 'zod';

/** LT-1: the agent's ping, the live map's filters, the trail read. */

export const trailKindSchema = z.enum(['ORDER', 'MILESTONE', 'FIELD_VISIT']);

export const pingSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Metres. */
  accuracy: z.number().min(0).max(10_000).nullable().optional(),
  /** Metres per second. */
  speed: z.number().min(0).max(100).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  at: z.string().datetime({ offset: true }).nullable().optional(),
  context: z.object({ kind: trailKindSchema, id: z.string().trim().min(1) }).nullable().optional(),
});
export type PingBody = z.infer<typeof pingSchema>;

export const liveFilterSchema = z.object({
  city: z.string().trim().min(1).max(80).optional(),
  side: z.enum(['PUBLISHER', 'ADVERTISER']).optional(),
  state: z.enum(['OFFLINE', 'AVAILABLE', 'TRAVELLING', 'ON_SITE', 'STILL']).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
