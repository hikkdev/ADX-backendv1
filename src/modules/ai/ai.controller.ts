import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { aiIsAvailable } from '../../shared/ai';
import { generateDescriptionSchema, quotaQuerySchema } from './ai.schema';
import { descriptionQuota, generateDescription } from './ai.service';

export async function generateDescriptionHandler(req: Request, res: Response): Promise<void> {
  const parsed = generateDescriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const data = await generateDescription({ userId: req.user!.sub, ...parsed.data });
  res.json({ success: true, data });
}

/**
 * What the button should say before it is pressed.
 *
 * `available` is separate from the quota because they fail differently: no
 * provider configured is a deployment that never offers the button at all,
 * while an exhausted quota is a button that was offered and is now spent.
 */
export async function descriptionQuotaHandler(req: Request, res: Response): Promise<void> {
  const parsed = quotaQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  }

  const [quota, available] = await Promise.all([
    descriptionQuota(req.user!.sub, parsed.data.listingId, parsed.data.draftKey),
    aiIsAvailable(),
  ]);

  res.json({ success: true, data: { ...quota, available } });
}
