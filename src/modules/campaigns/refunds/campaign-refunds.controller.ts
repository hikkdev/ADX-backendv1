import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { auditDiff, logActivity } from '../../../shared/audit';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import { ApiError } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { money } from '../../../shared/money';
import { listQuerySchema } from '../../../shared/pagination';
import { CAMPAIGN_REFUND_STATUSES, type CampaignRefundView } from '../campaigns.repository';
import {
  listCampaignRefunds,
  rejectCampaignRefund,
  releaseCampaignRefund,
} from './campaign-refunds.service';

/**
 * `/finance/campaign-refunds` — the refund desk's campaign queue (Lot B, Q41).
 *
 * ADMIN at the router, and `finance.approve` on the two decisions: releasing
 * is money leaving payables for a wallet, and refusing is the same authority
 * saying no. Every decision is audited against the CampaignRefund with the
 * status before and after.
 */

// E7-3: `?campaignId=` — the one campaign's refund, from its detail page.
const querySchema = listQuerySchema(CAMPAIGN_REFUND_STATUSES, ['newest'] as const).extend({
  campaignId: z.string().trim().min(1).optional(),
});
const releaseSchema = z.object({ note: z.string().trim().min(1).max(400).optional() });
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(400) });

function parse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const shape = (row: CampaignRefundView) => ({ ...row, amount: money(row.amount) });

export async function listCampaignRefundsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof querySchema>>(querySchema, req.query);
  const page = await listCampaignRefunds(query);
  res.json({ success: true, data: { ...page, items: page.items.map(shape) } });
}

export async function releaseCampaignRefundHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof releaseSchema>>(releaseSchema, req.body ?? {});
  const byUserId = req.user!.sub;
  const released = await releaseCampaignRefund(req.params['id'] as string, { byUserId, note: body.note ?? null });
  await logActivity(byUserId, 'CAMPAIGN_REFUND_RELEASED', {
    req,
    module: 'campaigns',
    targetType: 'CampaignRefund',
    targetId: released.id,
    diff: auditDiff({ status: 'PENDING' }, { status: released.status }),
    metadata: {
      campaignId: released.campaignId,
      advertiserId: released.campaign?.advertiserId ?? null,
      amount: money(released.amount),
      ledgerTransactionId: released.ledgerTransactionId,
      note: body.note ?? null,
    },
  });
  res.json({ success: true, data: shape(released) });
}

export async function rejectCampaignRefundHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof rejectSchema>>(rejectSchema, req.body);
  const byUserId = req.user!.sub;
  const rejected = await rejectCampaignRefund(req.params['id'] as string, { byUserId, reason: body.reason });
  await logActivity(byUserId, 'CAMPAIGN_REFUND_REJECTED', {
    req,
    module: 'campaigns',
    targetType: 'CampaignRefund',
    targetId: rejected.id,
    diff: auditDiff({ status: 'PENDING' }, { status: rejected.status }),
    metadata: { campaignId: rejected.campaignId, amount: money(rejected.amount), reason: body.reason },
  });
  res.json({ success: true, data: shape(rejected) });
}

export const campaignRefundRouter = Router();
campaignRefundRouter.use(authenticate);
campaignRefundRouter.use(requireRole('ADMIN'));

campaignRefundRouter.get('/', asyncHandler(listCampaignRefundsHandler));
campaignRefundRouter.post('/:id/release', requirePermission('finance.approve'), asyncHandler(releaseCampaignRefundHandler));
campaignRefundRouter.post('/:id/reject', requirePermission('finance.approve'), asyncHandler(rejectCampaignRefundHandler));
