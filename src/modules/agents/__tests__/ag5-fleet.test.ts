import { describe, expect, it, vi } from 'vitest';

/**
 * AG-5 (the owner, 20 Sep 2026): "we will be using existing network of
 * delivery agents as our publisher agent."
 *
 * Pinned: the pasted list is normalised, the duplicates on the partner's
 * list skipped and the unreadable rows returned; one SMS per fresh number
 * with the app link; a switched-off partner takes no invites; the
 * provenance is found by the applicant's number.
 */

const { repository, sms, audit } = vi.hoisted(() => ({
  repository: {
    createPartner: vi.fn(),
    updatePartner: vi.fn(),
    findPartner: vi.fn(),
    listPartners: vi.fn(),
    listInvites: vi.fn(async () => []),
    addInvites: vi.fn(),
    findOpenInviteByMobile: vi.fn(),
    setInviteStatus: vi.fn(),
    findInviteByAgent: vi.fn(),
    userMobile: vi.fn(),
  },
  sms: { sendSms: vi.fn(async () => ({ skipped: true, reason: 'DEV' })) },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../application/prisma-fleet.repository', () => ({ prismaFleetRepository: repository }));
vi.mock('../../../shared/sms', () => sms);
vi.mock('../../../shared/audit', () => audit);

import { fleetProvenanceFor, inviteFleet, markFleetInviteActivated } from '../application/fleet.service';

describe('the bulk invite', () => {
  it('normalises, dedupes, rejects what is not a number, and texts each fresh one', async () => {
    repository.findPartner.mockResolvedValue({ id: 'fp_1', name: 'Swift Riders', isActive: true });
    repository.addInvites.mockImplementation(async (_id: string, rows: { mobile: string; name: string | null }[]) => rows.filter((r) => r.mobile !== '+919000000002').map((r, i) => ({ id: `inv_${i}`, mobile: r.mobile, name: r.name })));
    const result = await inviteFleet('fp_1', { rows: [{ mobile: '90000 00001', name: 'Ravi' }, { mobile: '+91 9000000001' }, { mobile: '9000000002' }, { mobile: '12345' }, { mobile: '9000000003' }] }, 'adm_1');
    expect(repository.addInvites).toHaveBeenCalledWith('fp_1', [{ mobile: '+919000000001', name: 'Ravi' }, { mobile: '+919000000002', name: null }, { mobile: '+919000000003', name: null }], 'adm_1');
    expect(result).toMatchObject({ invited: 2, duplicates: 1, rejected: [{ mobile: '12345', reason: 'Not an Indian mobile number' }], sent: 2 });
    expect(sms.sendSms).toHaveBeenCalledTimes(2);
    expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: '+919000000001', kind: 'AGENT_FLEET_INVITE', body: expect.stringContaining('Swift Riders and ADX invite you') }));
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'FLEET_INVITES_SENT', expect.objectContaining({ metadata: expect.objectContaining({ pasted: 5, invited: 2, duplicates: 1, rejected: 1 }) }));

    repository.findPartner.mockResolvedValue({ id: 'fp_2', name: 'Old Fleet', isActive: false });
    await expect(inviteFleet('fp_2', { rows: [{ mobile: '9000000009' }] }, 'adm_1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('finds the provenance by the applicant\'s number, and marks the invite activated once', async () => {
    repository.userMobile.mockResolvedValue('+919000000001');
    repository.findOpenInviteByMobile.mockResolvedValue({ id: 'inv_1', partner: { id: 'fp_1', name: 'Swift Riders' } });
    expect(await fleetProvenanceFor('usr_1')).toEqual({ partnerId: 'fp_1', partnerName: 'Swift Riders', inviteId: 'inv_1' });
    repository.findOpenInviteByMobile.mockResolvedValue(null);
    expect(await fleetProvenanceFor('usr_1')).toBeNull();

    repository.findInviteByAgent.mockResolvedValueOnce({ id: 'inv_1', status: 'APPLIED' });
    await markFleetInviteActivated('agt_1');
    expect(repository.setInviteStatus).toHaveBeenCalledWith('inv_1', 'ACTIVATED', 'agt_1');
    repository.findInviteByAgent.mockResolvedValueOnce({ id: 'inv_1', status: 'ACTIVATED' });
    repository.setInviteStatus.mockClear();
    await markFleetInviteActivated('agt_1');
    expect(repository.setInviteStatus).not.toHaveBeenCalled();
  });
});
