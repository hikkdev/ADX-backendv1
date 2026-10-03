import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): the live map's agent list is the working agents — the shared predicate, the city beside it. */

const { prisma } = vi.hoisted(() => ({ prisma: { agentProfile: { findMany: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingAgentWhere } from '../../../shared/party-status';
import { prismaAgentLocationsRepository as repository } from '../prisma-agent-locations.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentProfile.findMany.mockResolvedValue([]);
});

describe('activeAgents', () => {
  it('reads the working-agent predicate, and the city when one is asked for', async () => {
    await repository.activeAgents({});
    expect(prisma.agentProfile.findMany.mock.calls[0]![0].where).toEqual({ AND: [workingAgentWhere()] });
    await repository.activeAgents({ city: 'Pune' });
    expect(prisma.agentProfile.findMany.mock.calls[1]![0].where).toEqual({ AND: [workingAgentWhere(), { city: { equals: 'Pune', mode: 'insensitive' } }] });
  });
});
