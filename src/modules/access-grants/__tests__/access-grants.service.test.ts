import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one sanctioned way an agent touches someone else's account.
 *
 * Everything here is arranged so the publisher is the one granting it: they
 * generate the code from their own app, they say what it is for, only the agent
 * ADX assigned can claim it, and the window closes on its own. Each of those is
 * a check somewhere below, because a mechanism that depends on anyone
 * remembering to switch access off is not a mechanism.
 */

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  attachQr: vi.fn(),
  findById: vi.fn(),
  findLiveForAgent: vi.fn(),
  claim: vi.fn(),
  setStatus: vi.fn(),
  listForPublisher: vi.fn(),
  listForAgent: vi.fn(),
  listOpen: vi.fn(),
  listingIdsFor: vi.fn(),
  publisherFor: vi.fn(),
  ticketFor: vi.fn(),
}));
const generateQr = vi.hoisted(() => vi.fn());
const deactivateQr = vi.hoisted(() => vi.fn());
const findAgentProfile = vi.hoisted(() => vi.fn());
const logActivity = vi.hoisted(() => vi.fn());

vi.mock('../prisma-access-grants.repository', () => ({
  prismaAccessGrantsRepository: repository,
}));
vi.mock('../../qr', () => ({ generateQr, deactivateQr }));
vi.mock('../../agents', () => ({ findAgentProfile }));
vi.mock('../../../shared/audit', () => ({ logActivity }));

import {
  holdsLiveGrant,
  issueGrant,
  prepareGrantClaim,
  revokeGrant,
} from '../access-grants.service';

const PUBLISHER = { id: 'pub_1', userId: 'usr_publisher' };
const OWNER = { userId: 'usr_publisher', isAdmin: false };
const OPS = { userId: 'usr_ops', isAdmin: true };

const input = (overrides: Record<string, unknown> = {}) => ({
  publisherId: 'pub_1',
  reason: 'The rate on my gym decal is wrong and I cannot change it',
  scope: 'LISTINGS' as const,
  listingIds: [],
  supportTicketId: 'tkt_1',
  durationMinutes: 60,
  ...overrides,
});

/** A ticket the publisher raised, with ADX's chosen agent already on it. */
const assignedTicket = {
  id: 'tkt_1',
  userId: 'usr_publisher',
  title: 'Wrong rate',
  status: 'OPEN',
  assignedAgentId: 'agt_assigned',
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.publisherFor.mockResolvedValue(PUBLISHER);
  repository.ticketFor.mockResolvedValue(assignedTicket);
  repository.listingIdsFor.mockResolvedValue(['lst_1', 'lst_2']);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({
    id: 'grant_1',
    status: 'PENDING',
    ...data,
  }));
  generateQr.mockResolvedValue({ qrId: 'qr_1', token: 'signed.token' });
  repository.claim.mockResolvedValue({ id: 'grant_1', status: 'ACTIVE' });
  repository.setStatus.mockResolvedValue({ id: 'grant_1', status: 'REVOKED' });
});

describe('issuing a grant', () => {
  it('issues for the publisher who owns the account', async () => {
    const { token } = await issueGrant(input(), OWNER);
    expect(token).toBe('signed.token');
    expect(repository.attachQr).toHaveBeenCalledWith('grant_1', 'qr_1');
  });

  it('lets ops issue on a ticket', async () => {
    await expect(issueGrant(input(), OPS)).resolves.toBeDefined();
  });

  /**
   * The agent cannot mint themselves a grant. If they could, the whole
   * mechanism would be an agent asking their own permission.
   */
  it('refuses anybody who is not the publisher', async () => {
    await expect(
      issueGrant(input(), { userId: 'usr_agent', isAdmin: false })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  /**
   * The agent is never named by the publisher. It is read off the ticket, which
   * is what makes the assignment ADX's decision rather than a field somebody
   * could be talked into changing.
   */
  it('takes the agent from the ticket', async () => {
    await issueGrant(input(), OWNER);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAgentId: 'agt_assigned', supportTicketId: 'tkt_1' }),
    );
  });

  it('refuses a ticket ADX has not put anyone on yet', async () => {
    repository.ticketFor.mockResolvedValue({ ...assignedTicket, assignedAgentId: null });
    await expect(issueGrant(input(), OWNER)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  /** Otherwise a publisher could point at somebody else's request and borrow
   *  whichever agent happened to be on it. */
  it('refuses a ticket raised on another account', async () => {
    repository.ticketFor.mockResolvedValue({ ...assignedTicket, userId: 'usr_someone_else' });
    await expect(issueGrant(input(), OWNER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a ticket that does not exist', async () => {
    repository.ticketFor.mockResolvedValue(null);
    await expect(issueGrant(input(), OWNER)).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * A narrowing that names somebody else's listing is not a narrowing — it sits
   * in the array looking like a restriction while granting and hiding nothing.
   */
  it('refuses listings the publisher does not own', async () => {
    await expect(
      issueGrant(input({ listingIds: ['lst_1', 'lst_elsewhere'] }), OWNER)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('locks the code to agent publishers at the QR layer too', async () => {
    await issueGrant(input(), OWNER);
    expect(generateQr).toHaveBeenCalledWith(
      'ACCESS_GRANT',
      'grant_1',
      ['AGENT_PUBLISHER'],
      expect.objectContaining({ scope: 'LISTINGS' })
    );
  });
});

describe('claiming a grant', () => {
  const pending = {
    id: 'grant_1',
    publisherId: 'pub_1',
    publisher: { id: 'pub_1', name: 'Fit Republic', userId: 'usr_publisher' },
    assignedAgentId: 'agt_assigned',
    reason: 'The rate on my gym decal is wrong',
    scope: 'LISTINGS',
    listingIds: [],
    durationMinutes: 60,
    status: 'PENDING',
  };

  beforeEach(() => {
    repository.findById.mockResolvedValue(pending);
    findAgentProfile.mockResolvedValue({ id: 'agt_assigned' });
  });

  it('starts the window for the assigned agent', async () => {
    const prepared = await prepareGrantClaim('grant_1', 'usr_agent');
    expect(prepared.grantId).toBe('grant_1');
    // The clock starts on the scan, not on generation — a publisher who
    // generates a code and puts their phone down has not started a timer they
    // cannot see.
    expect(prepared.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /** A forwarded QR image is a picture of a code somebody else cannot use. */
  it('refuses an agent the ticket did not name', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    await expect(prepareGrantClaim('grant_1', 'usr_agent')).rejects.toThrow('QR_ACCESS_DENIED');
  });

  it('refuses a scanner with no agent profile', async () => {
    findAgentProfile.mockResolvedValue(null);
    await expect(prepareGrantClaim('grant_1', 'usr_random')).rejects.toThrow('QR_ACCESS_DENIED');
  });

  it('refuses a second claim', async () => {
    repository.findById.mockResolvedValue({ ...pending, status: 'ACTIVE' });
    await expect(prepareGrantClaim('grant_1', 'usr_agent')).rejects.toThrow('QR_ALREADY_CLAIMED');
  });

  it('refuses one the publisher has withdrawn', async () => {
    repository.findById.mockResolvedValue({ ...pending, status: 'REVOKED' });
    await expect(prepareGrantClaim('grant_1', 'usr_agent')).rejects.toThrow('QR_ACCESS_DENIED');
  });
});

describe('withdrawing a grant', () => {
  beforeEach(() => {
    repository.findById.mockResolvedValue({
      id: 'grant_1',
      status: 'ACTIVE',
      qrId: 'qr_1',
      publisher: { id: 'pub_1', name: 'Fit Republic', userId: 'usr_publisher' },
    });
  });

  it('kills the code along with the grant', async () => {
    await revokeGrant('grant_1', OWNER);
    // A revoked grant whose QR still resolves would hand the next scanner a
    // claim on something that is no longer granted.
    expect(deactivateQr).toHaveBeenCalledWith('qr_1');
    expect(repository.setStatus).toHaveBeenCalledWith(
      'grant_1',
      'REVOKED',
      expect.objectContaining({ revokedById: 'usr_publisher' })
    );
  });

  it('refuses anybody but the publisher or ops', async () => {
    await expect(
      revokeGrant('grant_1', { userId: 'usr_agent', isAdmin: false })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('whether a grant is live', () => {
  it('covers every listing when none were named', async () => {
    repository.findLiveForAgent.mockResolvedValue([{ listingIds: [] }]);
    await expect(holdsLiveGrant('agt_1', 'pub_1', 'LISTINGS', 'lst_9')).resolves.toBe(true);
  });

  it('covers only the listings that were named', async () => {
    repository.findLiveForAgent.mockResolvedValue([{ listingIds: ['lst_1'] }]);
    await expect(holdsLiveGrant('agt_1', 'pub_1', 'LISTINGS', 'lst_1')).resolves.toBe(true);
    await expect(holdsLiveGrant('agt_1', 'pub_1', 'LISTINGS', 'lst_2')).resolves.toBe(false);
  });

  /**
   * Expiry is filtered in the query, not here. A window that has run out is not
   * a grant that needs closing — it is simply not a grant, and leaving that to a
   * sweep would mean access outliving its window for as long as the sweep is late.
   */
  it('holds nothing when the query returns nothing', async () => {
    repository.findLiveForAgent.mockResolvedValue([]);
    await expect(holdsLiveGrant('agt_1', 'pub_1', 'LISTINGS', 'lst_1')).resolves.toBe(false);
  });
});
