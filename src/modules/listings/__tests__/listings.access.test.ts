import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may change a listing.
 *
 * There was no check at all: `PATCH /listings/:id` was gated on the role
 * `AGENT_PUBLISHER` and nothing compared the caller to the listing. Any agent
 * account could edit any listing — and because listings are read live as
 * comparables, repricing someone else's spot moves the range every neighbour in
 * that 200 m circle is measured against. Not a data-integrity bug: a way to
 * move a market from an ordinary field account.
 */

const repository = vi.hoisted(() => ({
  findWithPublisher: vi.fn(),
  findPublisherById: vi.fn(),
}));
const findAgentProfile = vi.hoisted(() => vi.fn());
const holdsLiveGrant = vi.hoisted(() => vi.fn());

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../agents', () => ({ findAgentProfile }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant }));
vi.mock('../../pricing', () => ({ classifySpot: vi.fn(), activeSurge: vi.fn() }));

import { assertCanCreateForPublisher, assertCanEditListing } from '../listings.service';

const OWNER = { userId: 'usr_publisher', isAdmin: false };
const STRANGER = { userId: 'usr_other_agent', isAdmin: false };

const listing = (overrides: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisher: { id: 'pub_1', userId: 'usr_publisher', agentId: 'agt_theirs' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithPublisher.mockResolvedValue(listing());
  findAgentProfile.mockResolvedValue(null);
  holdsLiveGrant.mockResolvedValue(false);
});

describe('who may edit a listing', () => {
  it('lets ADX through without even reading the listing', async () => {
    await expect(
      assertCanEditListing('lst_1', { userId: 'usr_ops', isAdmin: true })
    ).resolves.toBeUndefined();
    expect(repository.findWithPublisher).not.toHaveBeenCalled();
  });

  it('lets the publisher edit their own', async () => {
    await expect(assertCanEditListing('lst_1', OWNER)).resolves.toBeUndefined();
  });

  /**
   * `Publisher.agentId`, not `Listing.agentId`. A publisher who has moved to
   * another agent has moved; the agent who happened to key the listing in last
   * year has not kept a claim on it.
   */
  it('lets the agent who onboarded that publisher edit it', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanEditListing('lst_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).not.toHaveBeenCalled();
  });

  it('refuses an agent with no relationship to the publisher', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses a signed-in user who is not an agent at all', async () => {
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('lets an agent through on a live delegated grant', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    holdsLiveGrant.mockResolvedValue(true);
    await expect(assertCanEditListing('lst_1', STRANGER)).resolves.toBeUndefined();
    // Narrowed to this listing, so a grant naming three others does not cover it.
    expect(holdsLiveGrant).toHaveBeenCalledWith('agt_someone_else', 'pub_1', 'LISTINGS', 'lst_1');
  });

  /** A scraped listing belongs to nobody yet, so it belongs to ADX. */
  it('refuses everyone but ADX on an unclaimed listing', async () => {
    repository.findWithPublisher.mockResolvedValue(listing({ publisher: null }));
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('answers 404 for a listing that does not exist', async () => {
    repository.findWithPublisher.mockResolvedValue(null);
    await expect(assertCanEditListing('lst_missing', OWNER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

/**
 * The same question, one verb earlier.
 *
 * `POST /listings` took a `publisherId` from the body and asked nothing about
 * it, so any agent-publisher account could file a listing — at a price of their
 * choosing — under somebody else's name. That price then enters the comparable
 * pool for every spot within 200 m, so the damage is not confined to the account
 * it was filed against.
 */
describe('who may add a spot to a publisher', () => {
  beforeEach(() => {
    repository.findPublisherById.mockResolvedValue({
      id: 'pub_1',
      userId: 'usr_publisher',
      agentId: 'agt_theirs',
    });
  });

  it('lets ADX through without reading the publisher', async () => {
    await expect(
      assertCanCreateForPublisher('pub_1', { userId: 'usr_ops', isAdmin: true })
    ).resolves.toBeUndefined();
    expect(repository.findPublisherById).not.toHaveBeenCalled();
  });

  it('lets the agent who onboarded that publisher add one', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).not.toHaveBeenCalled();
  });

  it('refuses an agent with no relationship to the publisher', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  /** "Help me with my listings" covers adding one, and only for that publisher. */
  it('lets an agent through on a live delegated grant', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    holdsLiveGrant.mockResolvedValue(true);
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).toHaveBeenCalledWith('agt_someone_else', 'pub_1', 'LISTINGS');
  });

  it('answers 404 for a publisher that does not exist', async () => {
    repository.findPublisherById.mockResolvedValue(null);
    await expect(assertCanCreateForPublisher('pub_missing', STRANGER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
