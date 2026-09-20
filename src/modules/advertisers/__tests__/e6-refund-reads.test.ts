import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E6: the refund-request reads — the desk's rows name the advertiser and
 * carry money as decimal strings; the party read is the same rows scoped to
 * one wallet.
 */

const repository = vi.hoisted(() => ({ listRefundRequestsPage: vi.fn(), findAdvertiserById: vi.fn(), findUserClosure: vi.fn(), findUserPerson: vi.fn(async () => null), findKycSummary: vi.fn(async () => null) }));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => ({ move: vi.fn(), findWallet: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../agreements', () => ({ acceptInsertionOrder: vi.fn(), isCurrentAcceptance: vi.fn() }));

import { listAdvertiserRefundRequests, listRefundRequestsPage } from '../advertisers.service';

const row = {
  id: 'rfr_1',
  walletId: 'wal_1',
  amount: new Decimal('500'),
  reason: 'OVERPAYMENT',
  note: 'Paid twice',
  status: 'APPROVED',
  destination: 'BANK_TRANSFER',
  consentNote: 'Agreed on the call',
  railReference: null,
  paidAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  advertiser: { id: 'adv_1', displayId: 'ADX-ADV-000001', name: 'Anita Coffee' },
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.listRefundRequestsPage.mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 20,
    counts: { PENDING: 0, APPROVED: 1, REJECTED: 0, WITHDRAWN: 0, PAID: 0, FAILED: 0 },
  });
});

describe('GET /finance/refund-requests', () => {
  it('names the advertiser and sends the money as a decimal string', async () => {
    const page = await listRefundRequestsPage({ page: 1, pageSize: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 'rfr_1',
      amount: '500.00',
      destination: 'BANK_TRANSFER',
      consentNote: 'Agreed on the call',
      advertiser: { id: 'adv_1', displayId: 'ADX-ADV-000001', name: 'Anita Coffee' },
    });
    expect(repository.listRefundRequestsPage).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });
});

describe('GET /advertisers/:id/wallet/refund-requests', () => {
  it('is the same list scoped to the one advertiser', async () => {
    const page = await listAdvertiserRefundRequests('adv_1', { page: 2, pageSize: 10, status: ['APPROVED'] });
    expect(repository.listRefundRequestsPage).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      status: ['APPROVED'],
      advertiserId: 'adv_1',
    });
    expect(page.items[0]).toMatchObject({ amount: '500.00', status: 'APPROVED', paidAt: null, railReference: null });
    expect(page.counts.APPROVED).toBe(1);
  });
});

/* E6: GET /advertisers/:id carries the account's closure state. */
describe('GET /advertisers/:id', () => {
  it('carries user { closedAt, closeReason }, null when no account backs the profile', async () => {
    const { getAdvertiserDetail } = await import('../advertisers.service');
    const prisma = (await import('../prisma-advertisers.repository')).prismaAdvertisersRepository as unknown as {
      findAdvertiserById: ReturnType<typeof vi.fn>;
      findUserClosure: ReturnType<typeof vi.fn>;
    };
    prisma.findAdvertiserById.mockResolvedValue({ id: 'adv_1', userId: 'usr_1', name: 'Anita' });
    prisma.findUserClosure.mockResolvedValue({ closedAt: null, closeReason: null });
    await expect(getAdvertiserDetail('adv_1')).resolves.toMatchObject({ id: 'adv_1', user: { closedAt: null, closeReason: null } });

    prisma.findAdvertiserById.mockResolvedValue({ id: 'adv_2', userId: null, name: 'Held open' });
    await expect(getAdvertiserDetail('adv_2')).resolves.toMatchObject({ id: 'adv_2', user: null });
    expect(prisma.findUserClosure).toHaveBeenCalledTimes(1);
  });
});
