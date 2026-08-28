import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';
import { initiateDigioKyc, handleDigioWebhook, getDigioKycStatus, type DigioWebhookPayload } from '../services/digio.service';

// POST /publishers/:publisherId/kyc/digio/initiate
export async function initiateDigioKycHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;

  const [publisher, agent] = await Promise.all([
    prisma.publisher.findUnique({
      where: { id: publisherId },
      include: { agent: { include: { user: true } } },
    }),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || publisher.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');

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
  const userId = req.user!.sub;
  const [publisher, agent] = await Promise.all([
    prisma.publisher.findUnique({ where: { id: publisherId } }),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || publisher.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');
  const status = await getDigioKycStatus(publisherId);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}

// POST /webhooks/digio  — called by Digio, no auth middleware
const webhookSchema = z.object({
  id: z.string(),
  customer_identifier: z.string().optional(),
  status: z.enum(['approved', 'rejected', 'pending', 'cancelled']),
  message: z.string().optional(),
  kyc_documents: z.array(z.object({
    type: z.string(),
    status: z.enum(['approved', 'rejected', 'pending', 'cancelled']),
    name: z.string().optional(),
    dob: z.string().optional(),
    id_number: z.string().optional(),
  })).optional(),
  completed_at: z.string().optional(),
});

export async function digioWebhookHandler(req: Request, res: Response): Promise<void> {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    // Acknowledge anyway so Digio doesn't retry with bad data
    res.json({ success: true });
    return;
  }
  await handleDigioWebhook(parsed.data as DigioWebhookPayload);
  res.json({ success: true });
}
