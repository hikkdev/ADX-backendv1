import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): the publisher plan renewal sweep neither reminds nor renews a publisher who is not a working account. */

const { prisma } = vi.hoisted(() => ({ prisma: { publisherSubscription: { findMany: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingPublisherWhere } from '../../../shared/party-status';
import { prismaPublisherPlansRepository as repository } from '../prisma-publisher-plans.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisherSubscription.findMany.mockResolvedValue([]);
});

describe('findEndingBetween', () => {
  it('reads only subscriptions whose publisher is a working account', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-08T00:00:00Z');
    await repository.findEndingBetween(from, to);
    expect(prisma.publisherSubscription.findMany.mock.calls[0]![0].where).toEqual({ endsAt: { gt: from, lte: to }, publisher: workingPublisherWhere() });
  });
});
