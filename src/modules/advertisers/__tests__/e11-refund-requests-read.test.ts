import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E11-1: `GET /advertisers/:id/wallet/refund-requests` pinned over the
 * handler — the list contract `{ items, total, page, pageSize, counts }`, and
 * on every row the seven fields the phone's refund screen prints:
 * `destination`, `status`, `amount` (decimal string), `consentNote`,
 * `railReference`, `paidAt`, `createdAt`.
 */

const repository = vi.hoisted(() => ({ listRefundRequestsPage: vi.fn(), findAdvertiserById: vi.fn() }));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => ({ move: vi.fn(), findWallet: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn(), findAgentProfile: vi.fn() }));
vi.mock('../../agreements', () => ({ acceptInsertionOrder: vi.fn(), isCurrentAcceptance: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));

import { listAdvertiserRefundRequestsHandler } from '../advertisers.controller';

const ROW_FIELDS = ['destination', 'status', 'amount', 'consentNote', 'railReference', 'paidAt', 'createdAt'] as const;

const paid = {
  id: 'rfr_1',
  walletId: 'wal_1',
  amount: new Decimal('1500'),
  reason: 'OVERPAYMENT',
  note: 'Paid twice',
  status: 'PAID',
  holdId: null,
  ticketId: null,
  raisedByUserId: 'usr_support',
  decidedByUserId: 'usr_ops',
  decidedAt: new Date('2026-09-02T00:00:00Z'),
  decisionNote: 'Approved',
  destination: 'BANK_TRANSFER',
  consentNote: 'Agreed on the call',
  payoutMethodId: 'pm_1',
  rail: 'RAZORPAYX',
  railReference: 'UTR123456',
  paidAt: new Date('2026-09-03T00:00:00Z'),
  paidByUserId: 'usr_finance',
  ledgerTransactionId: 'ltx_1',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-03T00:00:00Z'),
  advertiser: { id: 'adv_1', displayId: 'ADX-ADV-000001', name: 'Anita Coffee' },
};

const pending = {
  ...paid,
  id: 'rfr_2',
  amount: new Decimal('250.5'),
  status: 'PENDING',
  decidedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  destination: 'WALLET_CREDIT',
  consentNote: null,
  payoutMethodId: null,
  rail: null,
  railReference: null,
  paidAt: null,
  paidByUserId: null,
  ledgerTransactionId: null,
};

const res = () => {
  const out = { body: undefined as { success: boolean; data: Record<string, unknown> } | undefined };
  return Object.assign(out, { json: vi.fn((body: never) => (out.body = body)) });
};

const asOwner = (query: Record<string, string> = {}) =>
  ({ params: { id: 'adv_1' }, query, user: { sub: 'usr_owner', roles: ['ADVERTISER'] } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserById.mockResolvedValue({ id: 'adv_1', userId: 'usr_owner', agentId: null, name: 'Anita Coffee' });
  repository.listRefundRequestsPage.mockResolvedValue({
    items: [paid, pending],
    total: 2,
    page: 1,
    pageSize: 20,
    counts: { PENDING: 1, APPROVED: 0, REJECTED: 0, WITHDRAWN: 0, PAID: 1, FAILED: 0 },
  });
});

describe('GET /advertisers/:id/wallet/refund-requests', () => {
  it('answers the list contract', async () => {
    const response = res();
    await listAdvertiserRefundRequestsHandler(asOwner(), response as never);
    const data = response.body!.data;
    expect(Object.keys(data).sort()).toEqual(['counts', 'items', 'page', 'pageSize', 'total']);
    expect(data).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(data['counts']).toEqual({ PENDING: 1, APPROVED: 0, REJECTED: 0, WITHDRAWN: 0, PAID: 1, FAILED: 0 });
    expect(repository.listRefundRequestsPage).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1' }));
  });

  it('carries destination, status, amount, consentNote, railReference, paidAt and createdAt on every row', async () => {
    const response = res();
    await listAdvertiserRefundRequestsHandler(asOwner(), response as never);
    const items = response.body!.data['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const row of items) for (const field of ROW_FIELDS) expect(row).toHaveProperty(field);

    expect(items[0]).toMatchObject({
      id: 'rfr_1',
      destination: 'BANK_TRANSFER',
      status: 'PAID',
      amount: '1500.00',
      consentNote: 'Agreed on the call',
      railReference: 'UTR123456',
      paidAt: new Date('2026-09-03T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    // A request nobody has paid keeps the nulls rather than dropping the keys.
    expect(items[1]).toMatchObject({
      id: 'rfr_2',
      destination: 'WALLET_CREDIT',
      status: 'PENDING',
      amount: '250.50',
      consentNote: null,
      railReference: null,
      paidAt: null,
    });
    expect(typeof items[1]!['amount']).toBe('string');
  });

  it('passes the status facet and the page through, scoped to the one advertiser', async () => {
    await listAdvertiserRefundRequestsHandler(asOwner({ status: 'PAID', page: '2', pageSize: '10' }), res() as never);
    expect(repository.listRefundRequestsPage).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: 'adv_1', status: ['PAID'], page: 2, pageSize: 10 }),
    );
  });

  it('refuses a stranger before reading anything', async () => {
    const stranger = { params: { id: 'adv_1' }, query: {}, user: { sub: 'usr_other', roles: ['ADVERTISER'] } } as never;
    await expect(listAdvertiserRefundRequestsHandler(stranger, res() as never)).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.listRefundRequestsPage).not.toHaveBeenCalled();
  });
});
