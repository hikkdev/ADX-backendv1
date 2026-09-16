import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { confirmOldMobile, startMobileChange, verifyMobileChange } from './mobile-change.service';

const mobile = z.string().trim().min(8).max(20);

export const startSchema = z.object({ newMobile: mobile });
const withCode = z.object({ newMobile: mobile, code: z.string().trim().regex(/^\d{4,8}$/) });
/** Lot F (Q18): the old number's code — the same shape as verify, a different code. */
export const confirmOldSchema = withCode;
export const verifySchema = withCode;

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

export async function startHandler(req: Request, res: Response): Promise<void> {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const result = await startMobileChange(req.user!.sub, parsed.data.newMobile);
  res.json({ success: true, data: result });
}

export async function confirmOldHandler(req: Request, res: Response): Promise<void> {
  const parsed = confirmOldSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const result = await confirmOldMobile(req.user!.sub, parsed.data.newMobile, parsed.data.code);
  res.json({ success: true, data: result });
}

export async function verifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const result = await verifyMobileChange(req.user!.sub, parsed.data.newMobile, parsed.data.code);
  res.json({ success: true, data: result });
}
