import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot K (B2): the free trial cannot race — the advertiser twin of
 * `revenue/__tests__/trial-lock.repository.test.ts`.
 *
 * `startTrial` runs in one Prisma transaction whose FIRST statement takes a
 * per-advertiser advisory lock — `pg_advisory_xact_lock(hashtext(advertiserId))`
 * — and only then re-reads "has this advertiser ever held a term". Two starts
 * arriving together queue at the lock: the second counts the first's sale and
 * answers `started: false`, which the service turns into 409. Driven against
 * a fake transaction client whose lock is a real queue.
 */

const { prisma, tx, state } = vi.hoisted(() => {
  const state = { rows: 0, lockQueue: Promise.resolve() as Promise<unknown>, release: null as null | (() => void) };
  const tx = {
    $executeRaw: vi.fn(),
    packageSale: { count: vi.fn(), create: vi.fn() },
  };
  return { tx, state, prisma: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { Decimal } from '../../../shared/money';
import { prismaPackagesRepository as repository } from '../prisma-packages.repository';

const NOW = new Date('2026-09-14T06:00:00.000Z');
const ENDS = new Date('2026-09-28T06:00:00.000Z');
const zero = new Decimal(0);
const input = () => ({
  advertiserId: 'adv_1',
  now: NOW,
  startsAt: NOW,
  endsAt: ENDS,
  sale: {
    reference: 'PKG-2026-482913',
    advertiserId: 'adv_1',
    agentId: null,
    visitId: null,
    createdByUserId: 'usr_adv',
    packageId: 'pkg_growth',
    tier: 'GROWTH' as const,
    packageName: 'Growth',
    pricePerMonth: new Decimal('24999'),
    cycle: 'MONTHLY' as const,
    months: 0,
    addOnsPerMonth: zero,
    subtotal: zero,
    discountPct: zero,
    discountAmount: zero,
    gstPct: zero,
    gstAmount: zero,
    total: zero,
    paymentToken: 'tok_trial',
    lines: [{ kind: 'PLAN', code: 'GROWTH', label: 'Growth plan (free trial)', pricePerMonth: new Decimal('24999'), months: 0, amount: zero }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = 0;
  state.lockQueue = Promise.resolve();
  tx.$executeRaw.mockImplementation(() => {
    const previous = state.lockQueue;
    let release!: () => void;
    state.lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      state.release = release;
      return 1;
    });
  });
  tx.packageSale.count.mockImplementation(async () => state.rows);
  tx.packageSale.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    state.rows += 1;
    return { id: `sale_${state.rows}`, ...data };
  });
  prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } finally {
      state.release?.();
    }
  });
});

describe('startTrial', () => {
  it('takes pg_advisory_xact_lock(hashtext(advertiserId)) as the first statement of the transaction, then counts the held terms, then writes the ACTIVE (TRIAL) sale with its lines', async () => {
    const result = await repository.startTrial(input());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    expect(values).toEqual(['adv_1']);
    const [lockAt] = tx.$executeRaw.mock.invocationCallOrder;
    const [countAt] = tx.packageSale.count.mock.invocationCallOrder;
    const [createAt] = tx.packageSale.create.mock.invocationCallOrder;
    expect(lockAt!).toBeLessThan(countAt!);
    expect(countAt!).toBeLessThan(createAt!);
    expect(tx.packageSale.count.mock.calls[0]![0]).toEqual({ where: { advertiserId: 'adv_1', status: { in: ['ACTIVE', 'EXPIRED'] } } });
    const { data } = tx.packageSale.create.mock.calls[0]![0];
    expect(data).toMatchObject({ advertiserId: 'adv_1', tier: 'GROWTH', status: 'ACTIVE', paidAt: NOW, paidMethod: 'TRIAL', paidReference: null, startsAt: NOW, endsAt: ENDS, nextBillingAt: ENDS, incentiveId: null });
    expect(data.lines).toEqual({ create: input().sale.lines });
    expect(result).toMatchObject({ started: true, sale: { id: 'sale_1', status: 'ACTIVE', paidMethod: 'TRIAL' } });
  });

  it('answers started: false without writing when the advertiser has ever held a term', async () => {
    state.rows = 1;
    expect(await repository.startTrial(input())).toEqual({ started: false, sale: null });
    expect(tx.packageSale.create).not.toHaveBeenCalled();
  });

  it('two concurrent starts: the second queues at the lock, re-reads the history the first just wrote, and answers started: false — one trial, never two', async () => {
    const [first, second] = await Promise.all([repository.startTrial(input()), repository.startTrial(input())]);
    expect([first, second].map((r) => r.started).sort()).toEqual([false, true]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.packageSale.count).toHaveBeenCalledTimes(2);
    expect(tx.packageSale.create).toHaveBeenCalledTimes(1);
    expect(state.rows).toBe(1);
  });
});
