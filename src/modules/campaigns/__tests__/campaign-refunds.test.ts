import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The refund desk's campaign queue — Lot B (Q41).
 *
 * A cancel after capture records what is owed; a different person releases
 * it, and the wallet is credited through `advertisers` so the REFUND legs and
 * the statement line come from the one movement path. Nothing here writes a
 * balance.
 */

const { repository, advertisers } = vi.hoisted(() => ({
  repository: {
    createCampaignRefund: vi.fn(),
    findCampaignRefund: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
    listCampaignRefunds: vi.fn(),
    updateCampaignRefund: vi.fn(),
  },
  advertisers: { creditCampaignRefund: vi.fn() },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../advertisers', () => advertisers);

import {
  listCampaignRefunds,
  openCampaignRefund,
  rejectCampaignRefund,
  releaseCampaignRefund,
} from '../refunds/campaign-refunds.service';

const NOW = new Date('2026-09-12T10:00:00Z');

const refund = (over: Record<string, unknown> = {}) => ({
  id: 'cref_1',
  campaignId: 'cmp_1',
  amount: new Decimal('6000.00'),
  status: 'PENDING',
  reason: 'Site vandalised',
  requestedByUserId: 'usr_adv',
  releasedByUserId: null,
  releasedAt: null,
  ledgerTransactionId: null,
  campaign: { id: 'cmp_1', reference: 'CMP-2026-000001', name: 'Diwali', advertiserId: 'adv_1', status: 'CANCELLED' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCampaignRefund.mockResolvedValue(refund());
  repository.findCampaignRefundByCampaign.mockResolvedValue(null);
  repository.createCampaignRefund.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'cref_1', status: 'PENDING', ...data }));
  repository.updateCampaignRefund.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    repository.findCampaignRefund.mockResolvedValue(refund(patch));
    return refund(patch);
  });
  advertisers.creditCampaignRefund.mockResolvedValue({ ledgerTransactionId: 'ltx_9', walletEntryId: 'ent_9', created: true });
});

describe('opening', () => {
  it('records what is owed, once per campaign', async () => {
    await openCampaignRefund({ campaignId: 'cmp_1', amount: '6000.00', reason: 'Site vandalised', requestedByUserId: 'usr_adv' });
    expect(repository.createCampaignRefund).toHaveBeenCalledWith({
      campaignId: 'cmp_1',
      amount: new Decimal('6000.00'),
      reason: 'Site vandalised',
      requestedByUserId: 'usr_adv',
    });

    repository.createCampaignRefund.mockClear();
    repository.findCampaignRefundByCampaign.mockResolvedValue(refund());
    const again = await openCampaignRefund({ campaignId: 'cmp_1', amount: '6000.00', reason: 'again', requestedByUserId: 'usr_adv' });
    expect(again?.id).toBe('cref_1');
    expect(repository.createCampaignRefund).not.toHaveBeenCalled();
  });

  it('records nothing when nothing is owed', async () => {
    await expect(
      openCampaignRefund({ campaignId: 'cmp_1', amount: '0.00', reason: 'Last day', requestedByUserId: 'usr_adv' })
    ).resolves.toBeNull();
    expect(repository.createCampaignRefund).not.toHaveBeenCalled();
  });
});

describe('releasing', () => {
  it('credits the wallet through advertisers and records who released it and which transaction did', async () => {
    const released = await releaseCampaignRefund('cref_1', { byUserId: 'usr_finance' }, NOW);

    expect(advertisers.creditCampaignRefund).toHaveBeenCalledWith({
      advertiserId: 'adv_1',
      campaignId: 'cmp_1',
      campaignRefundId: 'cref_1',
      amount: '6000.00',
      note: 'Refund for campaign CMP-2026-000001: Site vandalised',
      byUserId: 'usr_finance',
    });
    expect(repository.updateCampaignRefund).toHaveBeenCalledWith('cref_1', {
      status: 'RELEASED',
      releasedByUserId: 'usr_finance',
      releasedAt: NOW,
      ledgerTransactionId: 'ltx_9',
    });
    expect(released.status).toBe('RELEASED');
  });

  /* Four eyes: the person who asked for the money back may not be the person
     who hands it over. */
  it('refuses a release from whoever requested it', async () => {
    // E6: 409 FOUR_EYES, the same answer the payout batches give.
    await expect(releaseCampaignRefund('cref_1', { byUserId: 'usr_adv' })).rejects.toMatchObject({ statusCode: 409, code: 'FOUR_EYES' });
    expect(advertisers.creditCampaignRefund).not.toHaveBeenCalled();
  });

  it('is a no-op the second time', async () => {
    repository.findCampaignRefund.mockResolvedValue(refund({ status: 'RELEASED' }));
    await releaseCampaignRefund('cref_1', { byUserId: 'usr_finance' });
    expect(advertisers.creditCampaignRefund).not.toHaveBeenCalled();
  });

  it('will not release a refused refund', async () => {
    repository.findCampaignRefund.mockResolvedValue(refund({ status: 'REJECTED' }));
    await expect(releaseCampaignRefund('cref_1', { byUserId: 'usr_finance' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s an unknown refund', async () => {
    repository.findCampaignRefund.mockResolvedValue(null);
    await expect(releaseCampaignRefund('nope', { byUserId: 'usr_finance' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('refusing', () => {
  it('keeps the reason and moves no money', async () => {
    const rejected = await rejectCampaignRefund('cref_1', { byUserId: 'usr_finance', reason: 'Delivered in full' }, NOW);
    expect(advertisers.creditCampaignRefund).not.toHaveBeenCalled();
    expect(repository.updateCampaignRefund).toHaveBeenCalledWith('cref_1', {
      status: 'REJECTED',
      releasedByUserId: 'usr_finance',
      releasedAt: NOW,
      reason: 'Site vandalised — refused: Delivered in full',
    });
    expect(rejected.status).toBe('REJECTED');
  });

  it('needs a reason', async () => {
    await expect(rejectCampaignRefund('cref_1', { byUserId: 'usr_finance', reason: '  ' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a decision from whoever requested it', async () => {
    await expect(rejectCampaignRefund('cref_1', { byUserId: 'usr_adv', reason: 'no' })).rejects.toMatchObject({ statusCode: 409, code: 'FOUR_EYES' });
  });
});

describe('the queue', () => {
  it('answers on the list contract with the chip histogram', async () => {
    repository.listCampaignRefunds.mockResolvedValue({ items: [refund()], total: 1, counts: { PENDING: 1, RELEASED: 0, REJECTED: 0 } });
    const page = await listCampaignRefunds({ status: ['PENDING'], page: 1, pageSize: 20 });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20, counts: { PENDING: 1, RELEASED: 0, REJECTED: 0 } });
    expect(page.items[0]!.id).toBe('cref_1');
  });

  it('E7-3: narrows to one campaign when the detail page asks', async () => {
    repository.listCampaignRefunds.mockResolvedValue({ items: [refund()], total: 1, counts: { PENDING: 1, RELEASED: 0, REJECTED: 0 } });
    const page = await listCampaignRefunds({ campaignId: 'cmp_1', page: 1, pageSize: 20 });
    expect(repository.listCampaignRefunds).toHaveBeenCalledWith({ campaignId: 'cmp_1', page: 1, pageSize: 20 });
    expect(page.items[0]!.campaignId).toBe('cmp_1');
  });
});
