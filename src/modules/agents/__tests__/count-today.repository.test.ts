import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G12-B: `GET /agents/me` → `today.visits` counts field visits beside
 * milestones.
 *
 * The day's "visits" counter only ever counted `OrderMilestone` rows — the
 * visit that is a step on an order. DR 06's `FieldVisit` (an onboarding
 * call, a renewal, an audit) is the other half of the agent's day, and the
 * day view already draws both; the header's counter now agrees with it.
 * A field visit counts when it is the agent's, SCHEDULED or IN_PROGRESS,
 * and slotted inside the Indian day the window describes, or already under
 * way whatever its slot — the milestone rule, applied to the other table.
 * Counted on the `FieldVisit` table here rather than through `visits`
 * because `visits` imports `agents`; reaching back would close the cycle.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    order: { count: vi.fn() },
    orderMilestone: { count: vi.fn() },
    fieldVisit: { count: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAgentsRepository as repository } from '../prisma-agents.repository';

const start = new Date('2026-09-11T18:30:00.000Z'); // 12 Sep 00:00 IST
const end = new Date('2026-09-12T18:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.order.count.mockResolvedValue(2);
  prisma.orderMilestone.count.mockResolvedValue(1);
  prisma.fieldVisit.count.mockResolvedValue(3);
});

describe('countToday', () => {
  it('adds the field visits of the day to the milestone visits', async () => {
    await expect(repository.countToday('agt_1', start, end)).resolves.toEqual({ orders: 2, visits: 4 });
  });

  it('asks the FieldVisit table for the agent’s SCHEDULED / IN_PROGRESS visits slotted in the window, or under way', async () => {
    await repository.countToday('agt_1', start, end);
    const [args] = prisma.fieldVisit.count.mock.calls[0]!;
    expect(args.where).toEqual({
      agentId: 'agt_1',
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      OR: [{ scheduledFor: { gte: start, lt: end } }, { status: 'IN_PROGRESS' }],
    });
    // The milestone half is unchanged.
    const [milestoneArgs] = prisma.orderMilestone.count.mock.calls[0]!;
    expect(milestoneArgs.where).toMatchObject({ assignedAgentId: 'agt_1', status: { in: ['PENDING', 'DISPATCHED', 'IN_PROGRESS'] } });
  });
});
