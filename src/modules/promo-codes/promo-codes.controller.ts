import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createPromoCodeSchema, updatePromoCodeSchema } from './promo-codes.schema';
import { createPromoCode, getPromoCode, listPromoCodes, updatePromoCode } from './promo-codes.service';

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

export async function listHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listPromoCodes() });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getPromoCode(req.params['id'] as string) });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const input = parse(createPromoCodeSchema, req.body);
  res.status(201).json({ success: true, data: await createPromoCode(input, req.user!.sub) });
}

export async function updateHandler(req: Request, res: Response): Promise<void> {
  const input = parse(updatePromoCodeSchema, req.body);
  res.json({ success: true, data: await updatePromoCode(req.params['id'] as string, input, req.user!.sub) });
}
