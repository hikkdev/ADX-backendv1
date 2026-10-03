import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — `POST /j/:code/link` answers a re-signed `accessToken`
 * when the link put the account on a side its token did not carry, the way
 * `POST /users/me/party` does (QR-2). Without it the website's next request
 * as the new publisher or advertiser was 403 until the token expired.
 */

const { invites, auth } = vi.hoisted(() => ({
  invites: { linkInviteToAccount: vi.fn() },
  auth: { reissueAccessToken: vi.fn(async () => 'fresh.jwt') },
}));

vi.mock('../invites.service', () => invites);
vi.mock('../../auth', () => auth);
vi.mock('../outreach.service', () => ({ actorOf: vi.fn() }));
vi.mock('../prisma-leads.repository', () => ({ prismaLeadsRepository: {} }));
vi.mock('../prisma-outreach.repository', () => ({ prismaOutreachRepository: {} }));
vi.mock('../proposals.service', () => ({ acceptProposal: vi.fn(), listProposalsFor: vi.fn(), proposalView: vi.fn(), PROPOSAL_KINDS: [], sendProposal: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ auditDiff: vi.fn(), logActivity: vi.fn() }));

import { landingLinkHandler } from '../landing.controller';

const linked = (side: 'PUBLISHER' | 'ADVERTISER', created: boolean) => ({
  party: { party: side, profileId: 'pub_1', displayId: 'ADX-P-1', created },
  lead: { id: 'lead_1', displayId: 'LED-1', converted: true },
  appLink: 'adx://join/ABCDEFGH',
  agentName: 'Ravi',
});

const call = async (roles: string[], sid: string | null = 'ses_1') => {
  const res = { json: vi.fn() };
  await landingLinkHandler({ params: { code: 'ABCDEFGH' }, body: {}, user: { sub: 'usr_1', roles, sid: sid ?? undefined } } as never, res as never);
  return res.json.mock.calls[0]?.[0].data;
};

beforeEach(() => {
  vi.clearAllMocks();
  invites.linkInviteToAccount.mockResolvedValue(linked('PUBLISHER', true));
});

describe('POST /j/:code/link — the token', () => {
  it('re-signs the session token when the link granted a side the token lacks', async () => {
    const data = await call(['ADVERTISER']);
    expect(auth.reissueAccessToken).toHaveBeenCalledWith('usr_1', 'ses_1');
    expect(data).toMatchObject({ party: { party: 'PUBLISHER', created: true }, accessToken: 'fresh.jwt' });
  });

  it('answers no token when the account already held the side', async () => {
    invites.linkInviteToAccount.mockResolvedValue(linked('PUBLISHER', false));
    const data = await call(['PUBLISHER']);
    expect(auth.reissueAccessToken).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('accessToken');
  });

  it('answers no token for a token with no session to re-sign', async () => {
    const data = await call([], null);
    expect(auth.reissueAccessToken).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('accessToken');
  });
});
