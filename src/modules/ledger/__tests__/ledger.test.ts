import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The ledger.
 *
 * Three properties carry everything else: a transaction balances, a movement
 * happens once however many times it is posted, and nothing is ever edited.
 * The database enforces all three with triggers and constraints — these tests
 * cover the service half, and the sign conventions that make a statement
 * readable.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findAccountByCode: vi.fn(),
    findAccountByWallet: vi.fn(),
    createAccount: vi.fn(),
    listAccounts: vi.fn(),
    append: vi.fn(),
    findTransaction: vi.fn(),
    findTransactionByKey: vi.fn(),
    listTransactions: vi.fn(),
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    balanceOf: vi.fn(),
    findUnbalanced: vi.fn(),
    findWalletDrift: vi.fn(),
  },
}));

vi.mock('../prisma-ledger.repository', () => ({ prismaLedgerRepository: repository }));

import {
  PLATFORM_ACCOUNTS,
  assertBalanced,
  ensureAccounts,
  post,
  resetAccountCache,
  reverse,
  verifyLedger,
  walletAccount,
  walletBalance,
} from '../ledger.service';

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc_pub',
  code: 'wallet:wal_1',
  name: "Sharma Hoardings' wallet",
  kind: 'WALLET',
  walletId: 'wal_1',
  createdAt: new Date(),
  ...over,
});

const NOW = new Date('2026-09-09T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountCache();
  repository.findAccountByCode.mockImplementation(async (code: string) =>
    account({ id: `acc_${code}`, code, kind: 'PLATFORM', walletId: null })
  );
  repository.createAccount.mockImplementation(async (data: Record<string, unknown>) =>
    account({ id: `acc_new`, ...data })
  );
  repository.findAccountByWallet.mockResolvedValue(null);
  repository.findTransactionByKey.mockResolvedValue(null);
  repository.referenceExists.mockResolvedValue(false);
  repository.countForYear.mockResolvedValue(411);
  repository.append.mockImplementation(async (data: Record<string, any>) => ({
    transaction: { id: 'ltx_1', ...data, legs: data.legs },
    created: true,
  }));
  repository.findUnbalanced.mockResolvedValue([]);
  repository.findWalletDrift.mockResolvedValue([]);
});

describe('a transaction balances', () => {
  it('accepts a pair that sums to zero', () => {
    expect(() =>
      assertBalanced([{ amount: '1000.00' }, { amount: '-1000.00' }])
    ).not.toThrow();
  });

  /* A split is the normal case, not the exception: an earning is the party's
     share, ADX's commission and the tax withheld, all from one gross. */
  it('accepts a split across more than two legs', () => {
    expect(() =>
      assertBalanced([
        { amount: '-10000.00' },
        { amount: '8500.00' },
        { amount: '1200.00' },
        { amount: '300.00' },
      ])
    ).not.toThrow();
  });

  it('refuses legs that do not sum to zero', () => {
    expect(() => assertBalanced([{ amount: '1000.00' }, { amount: '-999.99' }])).toThrowError(
      /do not balance/i
    );
  });

  it('refuses a single-sided movement', () => {
    expect(() => assertBalanced([{ amount: '1000.00' }])).toThrowError(/at least two legs/i);
  });

  it('refuses a leg that moves nothing', () => {
    expect(() =>
      assertBalanced([{ amount: '0.00' }, { amount: '1000.00' }, { amount: '-1000.00' }])
    ).toThrowError(/cannot move nothing/i);
  });

  it('never reaches the database with an unbalanced set', async () => {
    await expect(
      post({
        kind: 'ADJUSTMENT',
        idempotencyKey: 'adj:1',
        legs: [
          { accountId: 'acc_a', amount: '500.00' },
          { accountId: 'acc_b', amount: '-400.00' },
        ],
      })
    ).rejects.toThrowError(/do not balance/i);
    expect(repository.append).not.toHaveBeenCalled();
  });
});

describe('posting', () => {
  it('mints a readable reference from the year and the count', async () => {
    await post(
      {
        kind: 'PUBLISHER_EARNING',
        idempotencyKey: 'earning:ord_1:2026-09-09',
        legs: [
          { accountId: 'acc_pub', amount: '850.00' },
          { accountId: 'acc_platform:payables', amount: '-850.00' },
        ],
      },
      NOW
    );

    expect(repository.append.mock.calls[0]![0].reference).toBe('LGR-2026-000412');
  });

  it('signs a leg from its own account, so a statement reads the right way round', async () => {
    await post(
      {
        kind: 'PUBLISHER_EARNING',
        idempotencyKey: 'earning:ord_2:2026-09-09',
        legs: [
          { accountId: 'acc_pub', amount: '850.00', orderId: 'ord_2' },
          { accountId: 'acc_platform:payables', amount: '-850.00' },
        ],
      },
      NOW
    );

    const legs = repository.append.mock.calls[0]![0].legs;
    // Money arriving in the publisher's account is positive; leaving ADX's is negative.
    expect(legs[0].amount).toEqual(new Decimal('850.00'));
    expect(legs[1].amount).toEqual(new Decimal('-850.00'));
    expect(legs[0].orderId).toBe('ord_2');
  });

  /* A retried webhook, a double-tapped button and a replayed job are all this
     case, and none of them may mint a second movement. */
  it('is idempotent on the key, and says so', async () => {
    const existing = { id: 'ltx_first', reference: 'LGR-2026-000001', legs: [] };
    repository.findTransactionByKey.mockResolvedValue(existing);

    const result = await post({
      kind: 'PACKAGE_SPEND',
      idempotencyKey: 'package-debit:sale_1',
      legs: [
        { accountId: 'acc_adv', amount: '-33038.82' },
        { accountId: 'acc_platform:revenue', amount: '33038.82' },
      ],
    });

    expect(result.created).toBe(false);
    expect(result.transaction).toBe(existing);
    expect(repository.append).not.toHaveBeenCalled();
  });
});

describe('reversal is the only way back', () => {
  const original = {
    id: 'ltx_1',
    reference: 'LGR-2026-000412',
    kind: 'PUBLISHER_EARNING',
    legs: [
      { accountId: 'acc_pub', amount: new Decimal('850.00'), campaignId: 'cmp_1', orderId: 'ord_1', reference: null },
      { accountId: 'acc_pay', amount: new Decimal('-850.00'), campaignId: null, orderId: 'ord_1', reference: null },
    ],
  };

  beforeEach(() => {
    repository.findTransaction.mockResolvedValue(original);
  });

  it('posts the mirror and leaves the original alone', async () => {
    await reverse('ltx_1', { reason: 'Order was cancelled after credit' }, NOW);

    const posted = repository.append.mock.calls[0]![0];
    expect(posted.kind).toBe('REVERSAL');
    expect(posted.reversesId).toBe('ltx_1');
    expect(posted.legs[0].amount).toEqual(new Decimal('-850'));
    expect(posted.legs[1].amount).toEqual(new Decimal('850'));
    // The cause travels with the reversal, so a statement can still group them.
    expect(posted.legs[0].orderId).toBe('ord_1');
    expect(posted.note).toContain('LGR-2026-000412');
    expect(posted.note).toContain('cancelled');
  });

  /* Reversing twice would double the correction. The key makes the second call
     return the first reversal rather than post another. */
  it('reverses a transaction at most once', async () => {
    const done = { id: 'ltx_rev', reference: 'LGR-2026-000413', legs: [] };
    repository.findTransactionByKey.mockResolvedValue(done);

    const result = await reverse('ltx_1', { reason: 'again' }, NOW);
    expect(result).toBe(done);
    expect(repository.append).not.toHaveBeenCalled();
  });

  it('refuses to reverse a reversal', async () => {
    repository.findTransaction.mockResolvedValue({ ...original, kind: 'REVERSAL' });
    await expect(reverse('ltx_1', { reason: 'undo the undo' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('refuses a reversal with no reason', async () => {
    await expect(reverse('ltx_1', { reason: '   ' }, NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('refuses to reverse something that is not there', async () => {
    repository.findTransaction.mockResolvedValue(null);
    await expect(reverse('nope', { reason: 'x' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('accounts', () => {
  /* Lot B: the chart gains cash, and what a booking costs ADX to deliver.
     An account nobody planned is a number nobody reconciles, so the chart is
     pinned here and opening one is a code change. */
  it('has exactly the platform positions the cash side needs', () => {
    expect(PLATFORM_ACCOUNTS.map((account) => account.code)).toEqual([
      'platform:cash',
      'platform:revenue',
      'platform:payables',
      'platform:tax-withheld',
      'platform:goodwill',
      'platform:penalties',
      'platform:cost-of-sales',
      'platform:suspense',
    ]);
  });

  it('seeds the platform chart once, however often it is asked', async () => {
    repository.findAccountByCode.mockResolvedValue(null);
    await ensureAccounts();
    await ensureAccounts();
    expect(repository.createAccount).toHaveBeenCalledTimes(PLATFORM_ACCOUNTS.length);
  });

  /* Lazily, so wallets that predate the ledger join it when money next moves
     rather than needing a backfill that would invent opening balances. */
  it('opens a wallet account on first use and reuses it after', async () => {
    await walletAccount('wal_1', "Sharma Hoardings' wallet");
    expect(repository.createAccount).toHaveBeenCalledWith({
      code: 'wallet:wal_1',
      name: "Sharma Hoardings' wallet",
      kind: 'WALLET',
      walletId: 'wal_1',
    });

    repository.createAccount.mockClear();
    repository.findAccountByWallet.mockResolvedValue(account());
    await walletAccount('wal_1', "Sharma Hoardings' wallet");
    expect(repository.createAccount).not.toHaveBeenCalled();
  });

  it('reports nothing rather than failing for a wallet that never moved money', async () => {
    repository.findAccountByWallet.mockResolvedValue(null);
    expect(await walletBalance('wal_new')).toBe('0.00');
    expect(repository.balanceOf).not.toHaveBeenCalled();
  });
});

describe('proving the books', () => {
  it('is healthy when nothing is unbalanced and no wallet has drifted', async () => {
    const result = await verifyLedger();
    expect(result).toEqual({ unbalanced: [], drift: [], healthy: true });
  });

  /* The subtle failure: a caller moved a wallet and forgot the legs, or the
     reverse. Neither trigger catches that — only this does. */
  it('names the wallets whose balance disagrees with the books', async () => {
    repository.findWalletDrift.mockResolvedValue([
      { walletId: 'wal_1', walletTotal: new Decimal('1200.00'), ledgerTotal: new Decimal('1000.00') },
    ]);

    const result = await verifyLedger();
    expect(result.healthy).toBe(false);
    expect(result.drift).toEqual([
      { walletId: 'wal_1', walletTotal: '1200.00', ledgerTotal: '1000.00' },
    ]);
  });
});
