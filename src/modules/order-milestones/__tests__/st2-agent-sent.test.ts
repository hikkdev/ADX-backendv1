import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ST-2 (28 Sep 2026) — is this agent sent to this listing?
 *
 * The rule the verification drawer's own read applies (the milestone is
 * assigned to them), widened to the listing: a visit of theirs on one of its
 * orders, open or completed within thirty days, or the order's own agent.
 * What it opens is the listing's venue papers, which went private in ST-2.
 * Pinned: the window handed to the repository is thirty days back from now,
 * and the answer is the repository's.
 */

const { repository, orders } = vi.hoisted(() => ({
  repository: { agentHasWorkOnListing: vi.fn() },
  orders: { getAgentOrderIdsAwaitingWork: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({ prismaOrderMilestonesRepository: repository }));
vi.mock('../../orders', () => orders);

import { LISTING_VISIT_WINDOW_DAYS, agentSentToListing } from '../agent/agent-execution.service';

const NOW = new Date('2026-09-28T06:00:00.000Z');

beforeEach(() => vi.clearAllMocks());

describe('ST-2: the agent sent to a listing', () => {
  it('asks for work on the listing since thirty days ago', async () => {
    repository.agentHasWorkOnListing.mockResolvedValue(true);
    await expect(agentSentToListing('agt_1', 'lst_1', NOW)).resolves.toBe(true);
    expect(LISTING_VISIT_WINDOW_DAYS).toBe(30);
    expect(repository.agentHasWorkOnListing).toHaveBeenCalledWith('agt_1', 'lst_1', new Date('2026-08-29T06:00:00.000Z'));
  });

  it('is no when the agent has no visit or order on the listing', async () => {
    repository.agentHasWorkOnListing.mockResolvedValue(false);
    await expect(agentSentToListing('agt_2', 'lst_1', NOW)).resolves.toBe(false);
  });
});
