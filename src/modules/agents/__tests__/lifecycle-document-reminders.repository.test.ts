import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the paper-expiry sweep reminds working
 * agents only — a suspended, deactivated or closed agent's papers wait for
 * the first run after they are reinstated. And the exit's sign-in decision
 * reads what else the account works as.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    agentDocument: { findMany: vi.fn() },
    publisher: { findUnique: vi.fn() },
    advertiser: { findUnique: vi.fn() },
    employee: { findUnique: vi.fn() },
    printPartner: { findUnique: vi.fn() },
    user: { update: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingAgentAccountWhere } from '../../../shared/party-status';
import { prismaApplicationRepository as repository } from '../application/prisma-application.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.agentDocument.findMany.mockResolvedValue([]);
});

describe('documentsExpiring', () => {
  it('reads only working agents past none of the dead ends', async () => {
    await repository.documentsExpiring(new Date());
    expect(prisma.agentDocument.findMany.mock.calls[0]![0].where.agent).toEqual({
      AND: [{ stage: { notIn: ['REJECTED', 'WITHDRAWN', 'EXITED'] } }, workingAgentAccountWhere()],
    });
  });
});

describe('otherWorkingRoles', () => {
  it('names the publisher and advertiser not blocked from new work, the HR record on and the shop on the roster', async () => {
    prisma.publisher.findUnique.mockResolvedValue({ suspensionScopes: [] });
    prisma.advertiser.findUnique.mockResolvedValue({ suspensionScopes: ['BLOCK_NEW'] });
    prisma.employee.findUnique.mockResolvedValue({ isActive: true });
    prisma.printPartner.findUnique.mockResolvedValue(null);
    expect(await repository.otherWorkingRoles('usr_1')).toEqual(['PUBLISHER', 'EMPLOYEE']);
  });

  it('switchOffSignIn writes the account’s switch', async () => {
    await repository.switchOffSignIn('usr_1');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'usr_1' }, data: { isActive: false } });
  });
});
