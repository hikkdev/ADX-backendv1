import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): lead routing offers leads to working
 * agents only (the shared predicate), and a suspended agent's open leads —
 * assigned or claimed — go back to the pool with a note on each.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    agentProfile: { findMany: vi.fn() },
    lead: { groupBy: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    leadClaim: { updateMany: vi.fn() },
    leadActivity: { create: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingAgentWhere } from '../../../shared/party-status';
import { prismaLeadsRepository as repository } from '../prisma-leads.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentProfile.findMany.mockResolvedValue([]);
  prisma.lead.findMany.mockResolvedValue([]);
});

describe('lead routing', () => {
  it('reads the working-agent predicate, the side’s role and the city', async () => {
    await repository.candidateAgents('ADVERTISER', 'city_pune');
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where).toEqual({
      AND: [workingAgentWhere(), { user: { roles: { some: { role: 'AGENT_ADVERTISER' } } } }, { cityId: 'city_pune' }],
    });
  });

  it('without a city the city part is left out', async () => {
    await repository.candidateAgents('PUBLISHER', null);
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where.AND).toHaveLength(2);
  });
});

describe('the leads an agent holds', () => {
  it('are the open ones assigned to or claimed by them', async () => {
    await repository.findOpenHeldBy('agt_1');
    expect(prisma.lead.findMany).toHaveBeenCalledWith({
      where: { status: { notIn: ['CONVERTED', 'LOST'] }, OR: [{ assignedAgentId: 'agt_1' }, { claimedByAgentId: 'agt_1' }] },
      select: { id: true },
    });
  });
});
