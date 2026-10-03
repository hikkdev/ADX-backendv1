import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the agent roster's `status=` facet (ACTIVE
 * by default; EXITED is its own value; ALL for everyone) with
 * `statusCounts`, and work only going to working agents — the dispatch sweep
 * reads the one working-agent predicate (stage and status ACTIVE, no
 * BLOCK_NEW, signing in, not closed).
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { agentProfile: { findMany: vi.fn(), count: vi.fn() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { agentStateWhere, workingAgentWhere } from '../../../shared/party-status';
import { prismaAgentsRepository as repository } from '../prisma-agents.repository';
import { listAgentsQuerySchema } from '../agents.schema';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentProfile.findMany.mockResolvedValue([]);
  prisma.agentProfile.count.mockResolvedValue(4);
});

describe('the agent roster status facet', () => {
  it('takes EXITED beside the four, and ALL', () => {
    expect(listAgentsQuerySchema.parse({ status: 'exited' })).toMatchObject({ status: 'EXITED' });
    expect(listAgentsQuerySchema.parse({ status: 'ALL' })).toMatchObject({ status: 'ALL' });
    expect(listAgentsQuerySchema.safeParse({ status: 'RETIRED' }).success).toBe(false);
  });

  it('defaults to ACTIVE and counts the five states with the facet removed', async () => {
    const { statusCounts } = await repository.findPage({}, 50, 0);
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where.AND).toContainEqual(agentStateWhere('ACTIVE'));
    expect(statusCounts).toEqual({ ACTIVE: 4, SUSPENDED: 4, DEACTIVATED: 4, CLOSED: 4, EXITED: 4 });
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].include.user.select).toMatchObject({ isActive: true, closedAt: true });
  });

  it('EXITED narrows to the departed; ALL is everyone', async () => {
    await repository.findPage({ status: 'EXITED' }, 50, 0);
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where.AND).toContainEqual({ stage: 'EXITED' });
    await repository.findPage({ status: 'ALL' }, 50, 0);
    expect(JSON.stringify(prisma.agentProfile.findMany.mock.calls[1]![0].where)).not.toContain('EXITED');
  });
});

describe('work only goes to working agents', () => {
  it('the dispatch sweep reads the working-agent predicate, the role and the exclusions', async () => {
    await repository.findAssignable(['agt_x']);
    const where = prisma.agentProfile.findMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([{ id: { notIn: ['agt_x'] } }, workingAgentWhere(), { user: { roles: { some: { role: 'AGENT_PUBLISHER' } } } }]);
  });
});
