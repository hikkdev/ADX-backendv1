import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may act on an advertiser's account.
 *
 * What is pinned: the owner and an admin may do anything; the attributed
 * agent may read, and may write only while the owner's approval is live —
 * and that write is logged against the grant; anyone else is refused; a
 * stranger cannot even read.
 */

const { service, agents, grants, audit } = vi.hoisted(() => ({
  service: { getAdvertiser: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  grants: { liveGrantFor: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../advertisers.service', () => service);
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../../shared/audit', () => audit);

import { assertMayActFor } from '../advertisers.policy';

const advertiser = { id: 'adv_1', userId: 'usr_owner', agentId: 'agt_1' };
const req = (sub: string, roles: string[] = []) => ({ user: { sub, roles } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  service.getAdvertiser.mockResolvedValue(advertiser);
  agents.findAgentProfile.mockResolvedValue(null);
  grants.liveGrantFor.mockResolvedValue(null);
});

describe('the owner and an admin', () => {
  it('may read and write', async () => {
    expect(await assertMayActFor(req('usr_owner'), 'adv_1', 'WRITE')).toEqual({ as: 'OWNER', grantId: null });
    expect(await assertMayActFor(req('usr_admin', ['ADMIN']), 'adv_1', 'WRITE')).toEqual({ as: 'ADMIN', grantId: null });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});

describe('the attributed agent', () => {
  beforeEach(() => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  });

  it('may read without a grant', async () => {
    expect(await assertMayActFor(req('usr_agent'), 'adv_1', 'READ')).toEqual({ as: 'AGENT', grantId: null });
    expect(grants.liveGrantFor).not.toHaveBeenCalled();
  });

  it('may write only while the approval is live, and the write is logged against it', async () => {
    await expect(assertMayActFor(req('usr_agent'), 'adv_1', 'WRITE', 'ADVERTISER_PROFILE_UPDATED')).rejects.toMatchObject({ statusCode: 403 });

    grants.liveGrantFor.mockResolvedValue({ id: 'grant_1' });
    expect(await assertMayActFor(req('usr_agent'), 'adv_1', 'WRITE', 'ADVERTISER_PROFILE_UPDATED')).toEqual({ as: 'AGENT', grantId: 'grant_1' });
    expect(grants.liveGrantFor).toHaveBeenCalledWith('agt_1', { advertiserId: 'adv_1' }, 'PROFILE');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_agent', 'ADVERTISER_PROFILE_UPDATED', expect.anything(), { advertiserId: 'adv_1', grantId: 'grant_1' });
  });

  it('is somebody else’s agent when the account is not attributed to them', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(assertMayActFor(req('usr_agent'), 'adv_1', 'READ')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('anyone else', () => {
  it('cannot even read', async () => {
    await expect(assertMayActFor(req('usr_stranger'), 'adv_1', 'READ')).rejects.toMatchObject({ statusCode: 403 });
  });
});
