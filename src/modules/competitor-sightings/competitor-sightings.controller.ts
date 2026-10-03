import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createSightingSchema, exportSightingsQuerySchema, listSightingsQuerySchema } from './competitor-sightings.schema';
import { analyseSighting, exportSightings, getSighting, listSightings, logSighting, sightingBrands } from './competitor-sightings.service';

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

export async function logSightingHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof createSightingSchema.parse>>(createSightingSchema, req.body ?? {});
  res.status(201).json({ success: true, data: await logSighting(req.user!.sub, input, req) });
}

export async function listSightingsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<ReturnType<typeof listSightingsQuerySchema.parse>>(listSightingsQuerySchema, req.query);
  res.json({ success: true, data: await listSightings(query) });
}

export async function sightingBrandsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await sightingBrands() });
}

export async function exportSightingsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<ReturnType<typeof exportSightingsQuerySchema.parse>>(exportSightingsQuerySchema, req.query);
  const out = await exportSightings(query);
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.body);
}

export async function getSightingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSighting(req.params['id'] as string) });
}

export async function analyseSightingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await analyseSighting(req.params['id'] as string, { userId: req.user!.sub, req }) });
}
