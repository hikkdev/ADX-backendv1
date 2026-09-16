import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B — what `move()` now decides inside its own transaction.
 *
 * The Lot A verifier found the freeze check sitting outside the movement
 * transaction: a read, then a write, with a window between them. These cases
 * drive the Prisma repository against a fake transaction client so the order
 * of operations is the thing under test — the freeze is read on the row about
 * to be written, a short wallet is refused before anything moves, goodwill is
 * spent ahead of settled balance, and a captured hold settles in the same act.
 */

const { prisma, tx, ledger, lock } = vi.hoisted(() => {
  /*
   * Lot J2 (g): the advisory lock, as Postgres holds it — one holder per key
   * until that transaction ends. `$executeRaw` queues behind the current
   * holder; `$transaction` releases what its callback took when it settles.
   */
  const lock = { chain: Promise.resolve(), release: null as (() => void) | null, acquired: 0 };
  const tx = {
    $executeRaw: vi.fn(async () => {
      const previous = lock.chain;
      let release!: () => void;
      lock.chain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      lock.release = release;
      lock.acquired += 1;
      return 1;
    }),
    wallet: { findUnique: vi.fn(), update: vi.fn() },
    walletEntry: { create: vi.fn(), findMany: vi.fn() },
    walletHold: { findUnique: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    withdrawalRequest: { aggregate: vi.fn() },
    ledgerTransaction: { findUnique: vi.fn() },
  };
  return {
    tx,
    lock,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
        try {
          return await fn(tx);
        } finally {
          const release = lock.release;
          lock.release = null;
          release?.();
        }
      }),
    },
    ledger: {
      walletAccountWithin: vi.fn(),
      platformAccountWithin: vi.fn(),
      postWithin: vi.fn(),
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../../ledger', () => ledger);

import { prismaWalletsRepository as repository } from '../prisma-wallets.repository';

const FROZEN_AT = new Date('2026-09-12T00:00:00Z');

const wallet = (over: Record<string, unknown> = {}) => ({
  id: 'wal_1',
  balance: new Decimal('1000.00'),
  goodwill: new Decimal('0.00'),
  frozenAt: null,
  frozenReason: null,
  ...over,
});

const movement = (over: Record<string, unknown> = {}) => ({
  walletId: 'wal_1',
  walletLabel: 'Nilgiri Coffee · advertiser',
  amount: '-250.00',
  entryType: 'CAMPAIGN_DEBIT' as const,
  ledgerKind: 'CAMPAIGN_SPEND' as const,
  idempotencyKey: 'test:1',
  counterLegs: [{ accountCode: 'platform:payables', amount: '250.00' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  lock.chain = Promise.resolve();
  lock.release = null;
  lock.acquired = 0;
  tx.wallet.findUnique.mockResolvedValue(wallet());
  tx.ledgerTransaction.findUnique.mockResolvedValue(null);
  tx.walletHold.aggregate.mockResolvedValue({ _sum: { amount: null } });
  tx.withdrawalRequest.aggregate.mockResolvedValue({ _sum: { amount: null } });
  tx.wallet.update.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
    const row = wallet();
    const goodwill = new Decimal(row.goodwill)
      .plus(data.goodwill?.increment ?? 0)
      .minus(data.goodwill?.decrement ?? 0);
    const balance = new Decimal(row.balance)
      .plus(data.balance?.increment ?? 0)
      .minus(data.balance?.decrement ?? 0);
    return { ...row, balance, goodwill };
  });
  let n = 0;
  tx.walletEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `ent_${(n += 1)}`,
    isGoodwill: false,
    ...data,
  }));
  ledger.walletAccountWithin.mockResolvedValue({ id: 'acc_wallet' });
  ledger.platformAccountWithin.mockImplementation(async (_tx: unknown, code: string) => ({ id: `acc_${code}` }));
  ledger.postWithin.mockResolvedValue({ id: 'ltx_1', reference: 'LGR-2026-000001', created: true });
});

describe('the freeze is read inside the transaction', () => {
  it('refuses a debit from a wallet frozen on the row it was about to write, and writes nothing', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Fraud review' }));

    await expect(repository.move(movement())).rejects.toMatchObject({
      statusCode: 409,
      code: 'WALLET_FROZEN',
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletEntry.create).not.toHaveBeenCalled();
    expect(ledger.postWithin).not.toHaveBeenCalled();
  });

  it('still lands a credit on a frozen wallet', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Fraud review' }));

    const result = await repository.move(
      movement({ amount: '250.00', entryType: 'TOPUP', ledgerKind: 'TOPUP', counterLegs: [{ accountCode: 'platform:suspense', amount: '-250.00' }] })
    );
    expect(result?.created).toBe(true);
    expect(tx.wallet.update).toHaveBeenCalled();
  });

  /* Lot A (Q21): the closure freezes the wallet and then raises the final
     payout. That one debit, and only that one, passes the freeze. */
  it('lets the closure’s own final payout through with allowFrozen', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Account closed' }));

    const result = await repository.move(movement({ allowFrozen: true, entryType: 'PAYOUT', ledgerKind: 'PAYOUT' }));
    expect(result?.created).toBe(true);
  });
});

describe('funds are checked and spent in one act', () => {
  it('refuses 402 when balance + goodwill − open holds cannot cover the debit', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ balance: new Decimal('300.00') }));
    tx.walletHold.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('100.00') } });

    await expect(repository.move(movement({ requireFunds: true }))).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  /* Lot B (Q140): a withdrawal reserved and awaiting its batch is on its way
     to the bank, so a debit cannot spend it. */
  it('refuses 402 when a reserved withdrawal leaves too little', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ balance: new Decimal('300.00') }));
    tx.withdrawalRequest.aggregate.mockResolvedValue({ _sum: { amount: new Decimal('100.00') } });

    await expect(repository.move(movement({ requireFunds: true }))).rejects.toMatchObject({ statusCode: 402 });
    expect(tx.withdrawalRequest.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wal_1', status: { in: ['REQUESTED', 'APPROVED'] } } })
    );
  });

  it('counts goodwill as spendable', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ balance: new Decimal('100.00'), goodwill: new Decimal('200.00') }));

    await expect(repository.move(movement({ requireFunds: true, spendGoodwillFirst: true }))).resolves.toMatchObject({ created: true });
  });
});

describe('goodwill spends first', () => {
  it('writes a goodwill line and a balance line under one ledger transaction', async () => {
    tx.wallet.findUnique.mockResolvedValue(wallet({ balance: new Decimal('1000.00'), goodwill: new Decimal('100.00') }));

    const result = await repository.move(movement({ spendGoodwillFirst: true, note: 'Campaign CMP-1' }));

    expect(tx.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goodwill: { decrement: new Decimal('100.00') },
          balance: { decrement: new Decimal('150.00') },
        }),
      })
    );
    const [first, second] = tx.walletEntry.create.mock.calls.map((call) => call[0].data);
    expect(first).toMatchObject({ isGoodwill: true, amount: new Decimal('-100.00'), note: 'Campaign CMP-1 (credit applied)' });
    expect(second).toMatchObject({ amount: new Decimal('-150.00'), note: 'Campaign CMP-1' });
    expect(second.isGoodwill).toBeUndefined();
    expect(result?.entries).toHaveLength(2);
    // The books see one movement of the whole amount.
    expect(ledger.postWithin).toHaveBeenCalledTimes(1);
    expect(ledger.postWithin.mock.calls[0]![1].legs[0]).toMatchObject({ accountId: 'acc_wallet', amount: '-250.00' });
  });

  it('writes only the balance line when there is no goodwill', async () => {
    await repository.move(movement({ spendGoodwillFirst: true }));
    expect(tx.walletEntry.create).toHaveBeenCalledTimes(1);
  });
});

describe('capturing a hold', () => {
  it('marks the hold CAPTURED in the same transaction and pins it to the balance line', async () => {
    tx.walletHold.findUnique.mockResolvedValue({ id: 'hld_1', walletId: 'wal_1', status: 'HELD', campaignId: 'cmp_1', amount: new Decimal('250.00') });

    await repository.move(movement({ captureHoldId: 'hld_1', spendGoodwillFirst: true }));

    expect(tx.walletHold.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'hld_1' }, data: expect.objectContaining({ status: 'CAPTURED' }) })
    );
    const line = tx.walletEntry.create.mock.calls[0]![0].data;
    expect(line).toMatchObject({ holdId: 'hld_1', campaignId: 'cmp_1' });
  });

  it('refuses a hold that is not HELD before anything moves', async () => {
    tx.walletHold.findUnique.mockResolvedValue({ id: 'hld_1', walletId: 'wal_1', status: 'RELEASED', campaignId: 'cmp_1', amount: new Decimal('250.00') });

    await expect(repository.move(movement({ captureHoldId: 'hld_1' }))).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it('answers the earlier movement on a replayed key rather than capturing twice', async () => {
    tx.ledgerTransaction.findUnique.mockResolvedValue({ id: 'ltx_seen' });
    tx.walletEntry.findMany.mockResolvedValue([{ id: 'ent_old', isGoodwill: false }]);

    const result = await repository.move(movement({ captureHoldId: 'hld_1' }));
    expect(result).toMatchObject({ created: false, ledgerTransactionId: 'ltx_seen' });
    expect(tx.walletHold.findUnique).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });
});

/* ── Lot J2 (g): one movement at a time per wallet ───────────────── */

describe('the per-wallet advisory lock', () => {
  it('is taken on the wallet id before the row is read, inside the transaction', async () => {
    await repository.move(movement());
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // A tagged template: the SQL around the wallet id, and the id as its one parameter.
    const [strings, ...values] = tx.$executeRaw.mock.calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toBe('SELECT pg_advisory_xact_lock(hashtext(?))');
    expect(values).toEqual(['wal_1']);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.wallet.findUnique.mock.invocationCallOrder[0]!);
  });

  it('serialises two simultaneous debits against a balance that covers one: the second reads what the first left, and is refused', async () => {
    // A live balance the fake rows share, read after a tick so that without
    // the lock both debits would see ₹1,000 and both would pass.
    let balance = new Decimal('1000.00');
    tx.wallet.findUnique.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return wallet({ balance });
    });
    tx.wallet.update.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      balance = balance.plus(data.balance?.increment ?? 0).minus(data.balance?.decrement ?? 0);
      return wallet({ balance });
    });

    const debit = (key: string) => repository.move(movement({ amount: '-600.00', requireFunds: true, idempotencyKey: key, counterLegs: [{ accountCode: 'platform:payables', amount: '600.00' }] }));
    const outcomes = await Promise.allSettled([debit('debit:1'), debit('debit:2')]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ statusCode: 402, code: 'INSUFFICIENT_FUNDS' });
    expect(balance.toFixed(2)).toBe('400.00');
    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
    expect(lock.acquired).toBe(2);
  });
});
