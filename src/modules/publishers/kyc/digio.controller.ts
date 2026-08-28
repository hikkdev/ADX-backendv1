import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { assertOwnedPublisher } from '../publishers.service';
import {
  getDigioKycStatus,
  handleDigioWebhook,
  initiateDigioKyc,
  type DigioWebhookPayload,
} from './digio.service';

// POST /publishers/:publisherId/kyc/digio/initiate
export async function initiateDigioKycHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const publisher = await assertOwnedPublisher(publisherId, req.user!.sub);

  const result = await initiateDigioKyc(
    publisherId,
    publisher.name,
    publisher.email ?? '',
    publisher.mobile,
  );

  res.json({ success: true, data: result });
}

// GET /publishers/:publisherId/kyc/digio/status
export async function getDigioKycStatusHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  await assertOwnedPublisher(publisherId, req.user!.sub);

  const status = await getDigioKycStatus(publisherId);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}

const webhookSchema = z.object({
  id: z.string(),
  customer_identifier: z.string().optional(),
  status: z.enum(['approved', 'rejected', 'pending', 'cancelled']),
  message: z.string().optional(),
  kyc_documents: z
    .array(
      z.object({
        type: z.string(),
        status: z.enum(['approved', 'rejected', 'pending', 'cancelled']),
        name: z.string().optional(),
        dob: z.string().optional(),
        id_number: z.string().optional(),
      }),
    )
    .optional(),
  completed_at: z.string().optional(),
});

/**
 * POST /webhooks/digio — called by Digio, no authentication.
 *
 * Always answers 200, even for a payload that fails validation: returning an
 * error would make Digio retry the same bad body indefinitely.
 */
export async function digioWebhookHandler(req: Request, res: Response): Promise<void> {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ success: true });
    return;
  }
  await handleDigioWebhook(parsed.data as DigioWebhookPayload);
  res.json({ success: true });
}
