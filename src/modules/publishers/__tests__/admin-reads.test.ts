import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops reading a publisher.
 *
 * Every publisher read was written for the onboarding agent: `getOwnedPublisher`
 * resolves the CALLER's agent profile and refuses anyone whose id does not match
 * the publisher's `agentId`. ADMIN has no agent profile, so ADX itself was
 * refused from its own console — `/publishers/[id]` and that page's listings
 * both 403'd in live mode, and the roster could not be read at all.
 *
 * The agent's rule is untouched: they still see only the publishers they
 * onboarded.
 */

const { repository, agents, kyc } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), findAllForAdmin: vi.fn(), findForAgent: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  kyc: { listDocumentReviews: vi.fn(async (): Promise<unknown[]> => []) },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../agents', () => ({ findAgentProfile: agents.findAgentProfile, requireAgentProfile: vi.fn() }));
vi.mock('../../kyc', () => ({
  listDocumentReviews: kyc.listDocumentReviews,
  flaggedDocuments: vi.fn(),
  clearDocumentReviews: vi.fn(),
  flagDocuments: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
}));

import { getOwnedPublisher } from '../publishers.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue({ id: 'pub_1', name: 'Suraj Kumar Prints', agentId: 'agt_1' });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
});

describe('getOwnedPublisher', () => {
  it('lets the onboarding agent through, as it always did', async () => {
    await expect(getOwnedPublisher('pub_1', 'usr_agent')).resolves.toMatchObject({ id: 'pub_1' });
  });

  it('refuses an agent who did not onboard them', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(getOwnedPublisher('pub_1', 'usr_other')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lets ADMIN through without an agent profile', async () => {
    agents.findAgentProfile.mockResolvedValue(null);
    await expect(getOwnedPublisher('pub_1', 'usr_admin', { isAdmin: true })).resolves.toMatchObject({
      id: 'pub_1',
    });
    // Ops does not need to be anybody's agent to open a record.
    expect(agents.findAgentProfile).not.toHaveBeenCalled();
  });

  /* E6: the suspend dialog says what STOP_OPEN_WORK cancels; the banner says
     whether the account is closed. */
  it('carries openOrders across the listings and the account closure', async () => {
    repository.findById.mockResolvedValue({
      id: 'pub_1',
      agentId: 'agt_1',
      listings: [{ id: 'lst_1', _count: { orders: 2 } }, { id: 'lst_2', _count: { orders: 1 } }, { id: 'lst_3' }],
      user: { closedAt: new Date('2026-09-01T00:00:00Z'), closeReason: 'Left the business' },
    });
    const view = await getOwnedPublisher('pub_1', 'usr_admin', { isAdmin: true });
    expect(view.openOrders).toBe(3);
    expect(view.user).toEqual({ closedAt: new Date('2026-09-01T00:00:00Z'), closeReason: 'Left the business' });

    repository.findById.mockResolvedValue({ id: 'pub_2', agentId: 'agt_1', listings: [], user: null });
    const bare = await getOwnedPublisher('pub_2', 'usr_admin', { isAdmin: true });
    expect(bare).toMatchObject({ openOrders: 0, user: null });
  });

  /* Lot F: the agent's on-behalf read lights the flagged tiles from the
     desk's per-document decisions — the same rows the manifest draws. */
  it('carries the desk decisions on the KYC row: kyc.flagged and kyc.documentReviews', async () => {
    repository.findById.mockResolvedValue({
      id: 'pub_1',
      agentId: 'agt_1',
      kyc: { id: 'kyc_1', status: 'NEEDS_INFO', govIdFrontUrl: 'https://adx.local/api/v1/files/f1' },
      listings: [],
      user: null,
    });
    kyc.listDocumentReviews.mockResolvedValue([
      { field: 'govIdFrontUrl', decision: 'FLAGGED', note: 'Blurred', reviewedById: 'usr_admin' },
      { field: 'selfieUrl', decision: 'APPROVED', note: null, reviewedById: 'usr_admin' },
    ]);
    const view = await getOwnedPublisher('pub_1', 'usr_agent');
    expect(kyc.listDocumentReviews).toHaveBeenCalledWith('PUBLISHER', 'kyc_1');
    expect(view.kyc).toMatchObject({
      status: 'NEEDS_INFO',
      govIdFrontUrl: 'https://adx.local/api/v1/files/f1',
      flagged: [{ field: 'govIdFrontUrl', note: 'Blurred' }],
      documentReviews: [
        { field: 'govIdFrontUrl', decision: 'FLAGGED', note: 'Blurred' },
        { field: 'selfieUrl', decision: 'APPROVED', note: null },
      ],
    });

    // No KYC row yet: nothing to decorate, nothing asked. N3-B: the read still
    // answers the six-column summary — AWAITING_DOCUMENTS, the way the queue lists them.
    kyc.listDocumentReviews.mockClear();
    repository.findById.mockResolvedValue({ id: 'pub_2', agentId: 'agt_1', kyc: null, kycStatus: 'PENDING', listings: [], user: null });
    const bare = await getOwnedPublisher('pub_2', 'usr_agent');
    expect(bare.kyc).toEqual({ state: 'AWAITING_DOCUMENTS', kycId: null, status: null, submittedAt: null, requestedAt: null, requestedChannel: null, method: null });
    expect(kyc.listDocumentReviews).not.toHaveBeenCalled();
  });

  it('still 404s an id that does not exist, for ADMIN as for anyone', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(getOwnedPublisher('pub_nope', 'usr_admin', { isAdmin: true })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
