import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { createAdvertisementSchema, updateAdvertisementSchema } from './advertisements.schema';
import type { Caller } from './advertisements.policy';
import {
  createAdvertisement,
  deleteAdvertisement,
  getAccessibleAdvertisement,
  listAdvertisements,
  updateAdvertisement,
} from './advertisements.service';

function callerOf(req: Request): Caller {
  return { userId: req.user!.sub, isAdmin: (req.user?.roles ?? []).includes('ADMIN') };
}

export async function createAdvertisementHandler(req: Request, res: Response): Promise<void> {
  const parsed = createAdvertisementSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const ad = await createAdvertisement(callerOf(req), parsed.data);
  res.status(201).json({ success: true, data: ad });
}

export async function getAllAdvertisementsHandler(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));
  const advertiserId = req.query['advertiserId'] ? String(req.query['advertiserId']) : undefined;

  const { items, meta } = await listAdvertisements(callerOf(req), { page, pageSize, advertiserId });

  // `meta` is a sibling of `data`, not nested inside it. Clients depend on this.
  res.json({ success: true, data: items, meta });
}

export async function getAdvertisementByIdHandler(req: Request, res: Response): Promise<void> {
  const ad = await getAccessibleAdvertisement(req.params['id'] as string, callerOf(req));
  res.json({ success: true, data: ad });
}

export async function updateAdvertisementHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const caller = callerOf(req);

  // Access is resolved before the body is validated, so an unreachable id
  // answers 404 even when the body is also malformed. Original ordering.
  await getAccessibleAdvertisement(id, caller);

  const parsed = updateAdvertisementSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const ad = await updateAdvertisement(id, caller, parsed.data);
  res.json({ success: true, data: ad });
}

export async function deleteAdvertisementHandler(req: Request, res: Response): Promise<void> {
  await deleteAdvertisement(req.params['id'] as string, callerOf(req));
  res.json({ success: true, data: { message: 'Advertisement deleted' } });
}
