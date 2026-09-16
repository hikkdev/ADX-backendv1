import { z } from 'zod';
import { DIRECTIONS_MODES } from '../../shared/maps';

/**
 * Query shapes for the four lookups. All GET, all query-string: these are
 * reads a phone fires as somebody types, and a cache in front of them one
 * day wants them addressable.
 */

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

export const geocodeQuerySchema = z.object({
  address: z.string().trim().min(3).max(300),
});

export const reverseQuerySchema = z.object({
  latitude,
  longitude,
});

export const autocompleteQuerySchema = z.object({
  input: z.string().trim().min(2).max(120),
  /** One search, one session, one bill — the client mints it per search box. */
  session: z.string().trim().min(8).max(64).optional(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  radiusM: z.coerce.number().int().min(100).max(200_000).optional(),
});

export const placeParamsSchema = z.object({
  placeId: z.string().trim().min(4).max(300),
});

export const placeQuerySchema = z.object({
  session: z.string().trim().min(8).max(64).optional(),
});

/**
 * Q137: `from` and `to` as "lat,lng" — one token each, the way a phone
 * pastes a position into a query string. Parsed here into the seam's point.
 */
const latLng = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'Expected "lat,lng"')
  .transform((value) => {
    const [lat, lng] = value.split(',').map(Number) as [number, number];
    return { latitude: lat, longitude: lng };
  })
  .refine((p) => p.latitude >= -90 && p.latitude <= 90 && p.longitude >= -180 && p.longitude <= 180, 'Out of range');

export const directionsQuerySchema = z.object({
  from: latLng,
  to: latLng,
  mode: z.enum(DIRECTIONS_MODES).default('driving'),
});
