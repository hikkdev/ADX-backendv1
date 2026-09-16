import { ApiError } from '../../../shared/errors';
import { Decimal, money, type Money } from '../../../shared/money';
import { toListPage, type ListPage, type ListQuery } from '../../../shared/pagination';
import { creditCampaignRefund } from '../../advertisers';
import { prismaCampaignsRepository as repository } from '../prisma-campaigns.repository';
import type { CampaignRefundRow, CampaignRefundView } from '../campaigns.repository';

/**
 * The refund desk — Lot B (Q41).
 *
 * A campaign cancelled after its money was captured owes the advertiser its
 * unused days, and that credit is a decision with a person behind it. The
 * cancel records what is owed as a PENDING `CampaignRefund`; finance releases
 * or rejects it here. Releasing credits the wallet through `advertisers`,
 * which posts the REFUND legs (wallet + / payables −) out of the payables the
 * capture put the money into — a hand-written wallet update would leave the
 * books disagreeing with the wallet.
 *
 * Four eyes: the person who releases may not be the person who asked. There
 * is no distinct finance role on the API yet, so the rule is on the user
 * rather than the role — weaker than a capability check, and not nothing.
 */

export type CampaignRefundInput = {
  campaignId: string;
  amount: Money;
  reason: string;
  requestedByUserId: string;
};

/**
 * Records what a cancelled campaign owes. One per campaign: a second cancel
 * of the same campaign finds the first record rather than raising another.
 * Nothing is owed on a campaign whose unused value is zero, and no record is
 * written for it.
 */
export async function openCampaignRefund(input: CampaignRefundInput): Promise<CampaignRefundRow | null> {
  if (new Decimal(input.amount).lessThanOrEqualTo(0)) return null;
  const existing = await repository.findCampaignRefundByCampaign(input.campaignId);
  if (existing) return existing;
  return repository.createCampaignRefund({
    campaignId: input.campaignId,
    amount: new Decimal(money(input.amount)),
    reason: input.reason,
    requestedByUserId: input.requestedByUserId,
  });
}

export async function getCampaignRefund(id: string): Promise<CampaignRefundView> {
  const refund = await repository.findCampaignRefund(id);
  if (!refund) throw new ApiError(404, 'NOT_FOUND', 'Campaign refund not found');
  return refund;
}

export async function listCampaignRefunds(query: ListQuery & { campaignId?: string | undefined }): Promise<ListPage<CampaignRefundView>> {
  const { items, total, counts } = await repository.listCampaignRefunds(query);
  return toListPage(items, total, counts, query);
}

/**
 * Finance releases the credit. The wallet is credited through `advertisers`
 * — REFUND legs, statement line and idempotency on this record — and the
 * record then says who released it and which ledger transaction did.
 */
export async function releaseCampaignRefund(
  id: string,
  input: { byUserId: string; note?: string | null },
  now = new Date()
): Promise<CampaignRefundView> {
  const refund = await getCampaignRefund(id);
  if (refund.status === 'RELEASED') return refund;
  if (refund.status !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', `This refund is already ${refund.status.toLowerCase()}`);
  }
  if (refund.requestedByUserId === input.byUserId) {
    // E6: four eyes is a state of the record, not a permission — 409 like the batches.
    throw new ApiError(
      409,
      'FOUR_EYES',
      'A campaign refund must be released by someone other than the person who requested it'
    );
  }
  if (!refund.campaign) {
    throw new ApiError(409, 'CONFLICT', 'The campaign behind this refund no longer exists');
  }

  const credited = await creditCampaignRefund({
    advertiserId: refund.campaign.advertiserId,
    campaignId: refund.campaignId,
    campaignRefundId: refund.id,
    amount: money(refund.amount),
    note: input.note?.trim() || `Refund for campaign ${refund.campaign.reference}: ${refund.reason}`,
    byUserId: input.byUserId,
  });

  await repository.updateCampaignRefund(id, {
    status: 'RELEASED',
    releasedByUserId: input.byUserId,
    releasedAt: now,
    ledgerTransactionId: credited.ledgerTransactionId,
  });
  return getCampaignRefund(id);
}

/** Finance refuses it. Nothing moved, so nothing is reversed; the reason is kept. */
export async function rejectCampaignRefund(
  id: string,
  input: { byUserId: string; reason: string },
  now = new Date()
): Promise<CampaignRefundView> {
  const reason = input.reason.trim();
  if (!reason) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the refund was refused.');
  const refund = await getCampaignRefund(id);
  if (refund.status === 'REJECTED') return refund;
  if (refund.status !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', `This refund is already ${refund.status.toLowerCase()}`);
  }
  if (refund.requestedByUserId === input.byUserId) {
    throw new ApiError(
      409,
      'FOUR_EYES',
      'A campaign refund must be decided by someone other than the person who requested it'
    );
  }
  await repository.updateCampaignRefund(id, {
    status: 'REJECTED',
    releasedByUserId: input.byUserId,
    releasedAt: now,
    reason: `${refund.reason} — refused: ${reason}`,
  });
  return getCampaignRefund(id);
}
