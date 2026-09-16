import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot K (B2): the free trial cannot race.
 *
 * `startTrial` runs in one Prisma transaction whose FIRST statement takes a
 * per-publisher advisory lock — `pg_advisory_xact_lock(hashtext(publisherId))`,
 * released with the commit, the way `wallets.move` serialises a wallet — and
 * only then re-reads "has this publisher ever held anything". Two starts
 * arriving together queue at the lock: the second counts the first's row and
 * answers `started: false`, which the service turns into 409. Driven here
 * against a fake transaction client whose lock is a real queue, so the order
 * of statements and the serialised re-check are the things under test; the
 * real lock is the verifier's read-only probe.
 */

const { prisma, tx, state } = vi.hoisted(() => {
  const state = { rows: 0, lockQueue: Promise.resolve() as Promise<unknown>, release: null as null | (() => void) };
  const tx = {
    $executeRaw: vi.fn(),
    publisherSubscription: { count: vi.fn(), create: vi.fn() },
    publisherSubscriptionOrder: { create: vi.fn() },
  };
  return { tx, state, prisma: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { Decimal } from '../../../shared/money';
import { prismaPublisherPlansRepository as repository } from '../prisma-publisher-plans.repository';

const NOW = new Date('2026-09-14T06:00:00.000Z');
const ENDS = new Date('2026-09-28T06:00:00.000Z');
const zero = new Decimal(0);
const input = () => ({
  publisherId: 'pub_1',
  now: NOW,
  startsAt: NOW,
  endsAt: ENDS,
  order: {
    reference: 'SUB-2026-000001',
    publisherId: 'pub_1',
    createdByUserId: 'usr_pub',
    tier: 'PLUS' as const,
    planName: 'Plus',
    pricePerMonth: new Decimal('2499'),
    ratePct: new Decimal('0.1250'),
    cycle: 'MONTHLY' as const,
    months: 0,
    subtotal: zero,
    discountPct: zero,
    discountAmount: zero,
    gstPct: zero,
    gstAmount: zero,
    total: zero,
    startsAt: NOW,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = 0;
  // The lock: every caller waits for the one before it to "commit" (release).
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
  tx.publisherSubscription.count.mockImplementation(async () => state.rows);
  tx.publisherSubscription.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    state.rows += 1;
    return { id: `sub_${state.rows}`, ...data };
  });
  tx.publisherSubscriptionOrder.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ord_1', ...data, publisher: { id: 'pub_1', name: 'Asha', userId: 'usr_pub', displayId: null } }));
  // The commit releases the lock for the next caller.
  prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } finally {
      state.release?.();
    }
  });
});

describe('startTrial', () => {
  it('takes pg_advisory_xact_lock(hashtext(publisherId)) as the first statement of the transaction, then counts, then writes the subscription and the PAID (TRIAL) order on it', async () => {
    const result = await repository.startTrial(input());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    expect(values).toEqual(['pub_1']);
    const [lockAt] = tx.$executeRaw.mock.invocationCallOrder;
    const [countAt] = tx.publisherSubscription.count.mock.invocationCallOrder;
    const [subAt] = tx.publisherSubscription.create.mock.invocationCallOrder;
    const [orderAt] = tx.publisherSubscriptionOrder.create.mock.invocationCallOrder;
    expect(lockAt!).toBeLessThan(countAt!);
    expect(countAt!).toBeLessThan(subAt!);
    expect(subAt!).toBeLessThan(orderAt!);
    expect(tx.publisherSubscription.count.mock.calls[0]![0]).toEqual({ where: { publisherId: 'pub_1' } });
    expect(tx.publisherSubscription.create.mock.calls[0]![0].data).toMatchObject({ publisherId: 'pub_1', tier: 'PLUS', startsAt: NOW, endsAt: ENDS, source: 'SELF_SERVICE', autoRenew: false });
    expect(tx.publisherSubscriptionOrder.create.mock.calls[0]![0].data).toMatchObject({ status: 'PAID', paidAt: NOW, paidMethod: 'TRIAL', paidReference: null, startsAt: NOW, subscriptionId: 'sub_1' });
    expect(result).toMatchObject({ started: true, order: { id: 'ord_1', status: 'PAID' }, subscription: { id: 'sub_1' } });
  });

  it('answers started: false without writing when the publisher has ever held a subscription', async () => {
    state.rows = 1;
    expect(await repository.startTrial(input())).toEqual({ started: false, order: null, subscription: null });
    expect(tx.publisherSubscription.create).not.toHaveBeenCalled();
    expect(tx.publisherSubscriptionOrder.create).not.toHaveBeenCalled();
  });

  it('two concurrent starts: the second queues at the lock, re-reads the history the first just wrote, and answers started: false — one trial, never two', async () => {
    const [first, second] = await Promise.all([repository.startTrial(input()), repository.startTrial(input())]);
    const outcomes = [first, second].map((r) => r.started).sort();
    expect(outcomes).toEqual([false, true]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.publisherSubscription.count).toHaveBeenCalledTimes(2);
    expect(tx.publisherSubscription.create).toHaveBeenCalledTimes(1);
    expect(tx.publisherSubscriptionOrder.create).toHaveBeenCalledTimes(1);
    expect(state.rows).toBe(1);
  });
});
