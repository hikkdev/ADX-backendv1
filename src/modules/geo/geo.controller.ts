import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { autocompletePlaces, geocodeAddress, placeDetails, reverseGeocode } from '../../shared/maps';
import {
  autocompleteQuerySchema,
  directionsQuerySchema,
  geocodeQuerySchema,
  placeParamsSchema,
  placeQuerySchema,
  reverseQuerySchema,
} from './geo.schema';
import { directionsBetween } from './directions.service';

function invalid(details: unknown): never {
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', details);
}

/** GET /geo/geocode?address= */
export async function geocodeHandler(req: Request, res: Response): Promise<void> {
  const parsed = geocodeQuerySchema.safeParse(req.query);
  if (!parsed.success) invalid(parsed.error.flatten());
  const place = await geocodeAddress(parsed.data.address);
  if (!place) throw new ApiError(404, 'NOT_FOUND', 'No place matches that address.');
  res.json({ success: true, data: place });
}

/** GET /geo/reverse?latitude=&longitude= */
export async function reverseHandler(req: Request, res: Response): Promise<void> {
  const parsed = reverseQuerySchema.safeParse(req.query);
  if (!parsed.success) invalid(parsed.error.flatten());
  const place = await reverseGeocode(parsed.data);
  if (!place) throw new ApiError(404, 'NOT_FOUND', 'No address is known for that point.');
  res.json({ success: true, data: place });
}

/** GET /geo/autocomplete?input=&session=&latitude=&longitude=&radiusM= */
export async function autocompleteHandler(req: Request, res: Response): Promise<void> {
  const parsed = autocompleteQuerySchema.safeParse(req.query);
  if (!parsed.success) invalid(parsed.error.flatten());
  const { input, session, latitude, longitude, radiusM } = parsed.data;
  const predictions = await autocompletePlaces(input, {
    ...(session ? { sessionToken: session } : {}),
    ...(latitude !== undefined && longitude !== undefined ? { near: { latitude, longitude } } : {}),
    ...(radiusM !== undefined ? { radiusM } : {}),
  });
  res.json({ success: true, data: predictions });
}

/** GET /geo/places/:placeId?session= */
export async function placeHandler(req: Request, res: Response): Promise<void> {
  const params = placeParamsSchema.safeParse(req.params);
  if (!params.success) invalid(params.error.flatten());
  const query = placeQuerySchema.safeParse(req.query);
  if (!query.success) invalid(query.error.flatten());
  const place = await placeDetails(params.data.placeId, query.data.session);
  if (!place) throw new ApiError(404, 'NOT_FOUND', 'That place id names nothing.');
  res.json({ success: true, data: place });
}

/**
 * GET /geo/directions?from=lat,lng&to=lat,lng&mode=driving|two_wheeler
 *
 * Q137: the route line the agent app draws for a job. One call per opened
 * job — the answer is cached fifteen minutes per rounded pair, so a refresh
 * never reaches the vendor (see `directions.service.ts`).
 */
export async function directionsHandler(req: Request, res: Response): Promise<void> {
  const parsed = directionsQuerySchema.safeParse(req.query);
  if (!parsed.success) invalid(parsed.error.flatten());
  const directions = await directionsBetween(parsed.data.from, parsed.data.to, parsed.data.mode);
  if (!directions) throw new ApiError(404, 'NOT_FOUND', 'No route is known between those points.');
  res.json({ success: true, data: directions });
}
