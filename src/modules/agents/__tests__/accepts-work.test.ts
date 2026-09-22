import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A BLOCK_NEW on an agent, asked once.
 *
 * Four places put work in front of an agent — the order lane, a field visit,
 * an order milestone and a lead — and all four ask this. Both halves are
 * checked on purpose: suspension sets the profile status as well as the scope,
 * and a status hand-edited back to ACTIVE must not let work through a
 * suspension that is still on the record.
 */

const repository = vi.hoisted(() => ({ findWorkState: vi.fn() }));

vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));

import { agentAcceptsWork, assertAgentAcceptsWork } from '../agents.service';

beforeEach(() => vi.clearAllMocks());

describe('agentAcceptsWork', () => {
  it('is true only for an ACTIVE profile with no BLOCK_NEW on it', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: [], stage: 'ACTIVE' });
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(true);
  });

  it('is false while BLOCK_NEW is on the record, whatever the status says', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: ['BLOCK_NEW'], stage: 'ACTIVE' });
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(false);
  });

  it('is false for an agent who is away or suspended', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ON_LEAVE', scopes: [], stage: 'ACTIVE' });
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(false);
    repository.findWorkState.mockResolvedValue({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], stage: 'ACTIVE' });
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(false);
  });

  it('leaves the other scopes alone: a frozen wallet is not a reason to stop offering work', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: ['FREEZE_WALLET', 'STOP_OPEN_WORK'], stage: 'ACTIVE' });
    await expect(agentAcceptsWork('agt_1')).resolves.toBe(true);
  });

  it('AG-1: is false until the application ladder reaches ACTIVE, whatever the status says', async () => {
    for (const stage of ['PROFILE', 'DOCUMENTS', 'UNDER_REVIEW', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'EXITED']) {
      repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: [], stage });
      await expect(agentAcceptsWork('agt_1')).resolves.toBe(false);
    }
  });

  it('AG-1: the refusal names the ladder, not a suspension, for an agent who is not through it', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: [], stage: 'UNDER_REVIEW' });
    await expect(assertAgentAcceptsWork('agt_1')).rejects.toMatchObject({ statusCode: 409, code: 'AGENT_NOT_ACTIVE' });
  });

  it('is false for an agent that does not exist — a dispatch to nobody is not work offered', async () => {
    repository.findWorkState.mockResolvedValue(null);
    await expect(agentAcceptsWork('agt_gone')).resolves.toBe(false);
  });
});

describe('assertAgentAcceptsWork', () => {
  it('raises 409 AGENT_SUSPENDED, the code every dispatch point answers with', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], stage: 'ACTIVE' });
    await expect(assertAgentAcceptsWork('agt_1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'AGENT_SUSPENDED',
    });
  });

  it('passes silently for an agent being offered work', async () => {
    repository.findWorkState.mockResolvedValue({ status: 'ACTIVE', scopes: [], stage: 'ACTIVE' });
    await expect(assertAgentAcceptsWork('agt_1')).resolves.toBeUndefined();
  });
});
