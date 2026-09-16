import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D6 — ops oversight of the door-to-door authority.
 *
 * Two admin views the console did not have: every grant an agent has ever
 * held, with the party's name on it, and a party's whole record (scans,
 * grants, writes) by type and id. Neither is the agent's own `/mine` nor the
 * owner's own log; both are ADMIN's, and the routes say so.
 */

const { repository, qr, audit } = vi.hoisted(() => ({
  repository: {
    listForAgentWithNames: vi.fn(),
    listForSubject: vi.fn(),
  },
  qr: { listScansFor: vi.fn(), registerAccessGrantPort: vi.fn(), deactivateQr: vi.fn(), generateQr: vi.fn() },
  audit: { findActivityByMetadata: vi.fn(), logActivity: vi.fn() },
}));

vi.mock('../prisma-access-grants.repository', () => ({ prismaAccessGrantsRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));

import { listGrantsHeldByAgent, partyAccessLog } from '../access-grants.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.listForAgentWithNames.mockResolvedValue([{ id: 'grant_1', publisher: { id: 'pub_1', name: 'Asha Rao', userId: 'usr_1' } }]);
  repository.listForSubject.mockResolvedValue([]);
  qr.listScansFor.mockResolvedValue([]);
  audit.findActivityByMetadata.mockResolvedValue([]);
});

describe('listGrantsHeldByAgent', () => {
  it('is every grant the agent held, with the party named', async () => {
    const grants = await listGrantsHeldByAgent('agt_1');
    expect(repository.listForAgentWithNames).toHaveBeenCalledWith('agt_1');
    expect(grants[0]).toMatchObject({ id: 'grant_1', publisher: { name: 'Asha Rao' } });
  });
});

describe('partyAccessLog', () => {
  it('composes the log for a publisher or an advertiser by type', async () => {
    await partyAccessLog('publisher', 'pub_1');
    expect(qr.listScansFor).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
    await partyAccessLog('advertiser', 'adv_1');
    expect(qr.listScansFor).toHaveBeenCalledWith('ADVERTISER', 'adv_1');
  });

  it('refuses a party type it does not know', async () => {
    await expect(partyAccessLog('agent' as never, 'agt_1')).rejects.toMatchObject({ statusCode: 400 });
  });
});
