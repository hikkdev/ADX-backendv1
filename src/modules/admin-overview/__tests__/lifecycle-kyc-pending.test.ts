import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): the dashboard's pending-KYC numbers count working accounts only — the queues' rule. */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    publisherKyc: { count: vi.fn() },
    advertiserKyc: { count: vi.fn() },
    agentKyc: { count: vi.fn() },
    userKyc: { count: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingAdvertiserWhere, workingPublisherWhere, workingUserWhere } from '../../../shared/party-status';
import { prismaAdminOverviewRepository as repository } from '../prisma-admin-overview.repository';

beforeEach(() => {
  for (const table of Object.values(prisma)) table.count = vi.fn<AnyFn>(async () => 1);
});

describe('kycPending and kycPendingSubmittedBefore', () => {
  it('join each record to a working party', async () => {
    expect(await repository.kycPending()).toBe(4);
    expect(prisma.publisherKyc.count.mock.calls[0]![0].where).toMatchObject({ status: 'PENDING', publisher: workingPublisherWhere() });
    expect(prisma.advertiserKyc.count.mock.calls[0]![0].where.OR).toEqual([{ profile: { is: workingAdvertiserWhere() } }, { advertiserProfileId: null, advertiser: { is: workingUserWhere() } }]);
    expect(prisma.agentKyc.count.mock.calls[0]![0].where.agent.AND[1]).toEqual({ stage: { notIn: ['REJECTED', 'WITHDRAWN', 'EXITED'] } });
    expect(prisma.userKyc.count.mock.calls[0]![0].where).toMatchObject({ user: workingUserWhere() });

    const cutoff = new Date('2026-10-01T00:00:00Z');
    await repository.kycPendingSubmittedBefore(cutoff);
    expect(prisma.publisherKyc.count.mock.calls[1]![0].where).toMatchObject({ submittedAt: { lt: cutoff }, publisher: workingPublisherWhere() });
  });
});
