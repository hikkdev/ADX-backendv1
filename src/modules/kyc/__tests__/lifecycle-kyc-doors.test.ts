import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the desk's "Request KYC" refuses a closed
 * account (409 ACCOUNT_CLOSED) and one suspended from new work (409
 * ACCOUNT_SUSPENDED) on the agent, employee and advertiser desks; and a
 * decided KYC case (VERIFIED or REJECTED) is kept — `DELETE /advertiser-kyc/:id`
 * and `DELETE /user-kyc/:id` answer 409 KYC_DECIDED.
 */

const { agentRepo, employeeRepo, advertiserRepo, userRepo, prisma, advertisers, agentDigio, employeeDigio, advertiserDigio } = vi.hoisted(() => ({
  agentRepo: { findAgentContact: vi.fn(), findByAgentId: vi.fn(), requestKyc: vi.fn() },
  employeeRepo: { findEmployeeContact: vi.fn(), findByEmployeeId: vi.fn(), requestKyc: vi.fn() },
  advertiserRepo: { findById: vi.fn(), findByProfileId: vi.fn(), findByAdvertiserId: vi.fn(), requestKyc: vi.fn(), remove: vi.fn() },
  userRepo: { findById: vi.fn(), removeById: vi.fn() },
  prisma: { user: { findUnique: vi.fn() } },
  advertisers: { applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(async () => null), findAdvertiser: vi.fn() },
  agentDigio: { initiateAgentDigioKyc: vi.fn(), agentDigioStatus: vi.fn(), startAgentKyc: vi.fn() },
  employeeDigio: { initiateEmployeeDigioKyc: vi.fn() },
  advertiserDigio: { initiateAdvertiserDigioKyc: vi.fn(), noteEntityTypeForManualRequest: vi.fn() },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../agent/prisma-agent-kyc.repository', () => ({ prismaAgentKycRepository: agentRepo }));
vi.mock('../employee/prisma-employee-kyc.repository', () => ({ prismaEmployeeKycRepository: employeeRepo }));
vi.mock('../advertiser/prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: advertiserRepo }));
vi.mock('../user/prisma-user-kyc.repository', () => ({ prismaUserKycRepository: userRepo }));
vi.mock('../agent/agent-digio.service', () => agentDigio);
vi.mock('../employee/employee-digio.service', () => employeeDigio);
vi.mock('../advertiser/advertiser-digio.service', () => advertiserDigio);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../agents', () => ({ agentExists: vi.fn(), findAgentProfile: vi.fn(), upsertDocumentsFromKyc: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));
vi.mock('../../uploads', () => ({ fileIdFromUrl: vi.fn(), findUploadedFile: vi.fn(), purgeStoredFile: vi.fn() }));

import { requestAgentKyc } from '../agent/agent-kyc.service';
import { requestEmployeeKyc } from '../employee/employee-kyc.service';
import { deleteAdvertiserKyc, requestAdvertiserKyc } from '../advertiser/advertiser-kyc.service';
import { deleteUserKycById } from '../user/user-kyc.service';

const CLOSED = new Date('2026-09-30T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ isActive: true, closedAt: null });
  agentRepo.findAgentContact.mockResolvedValue({ id: 'agt_1', userId: 'usr_1', displayId: 'AGT-1', suspensionScopes: [], user: { name: 'R', email: null, mobile: '+91', closedAt: null } });
  agentRepo.findByAgentId.mockResolvedValue(null);
  employeeRepo.findEmployeeContact.mockResolvedValue({ id: 'emp_1', userId: 'usr_2', displayId: 'EMP-1', user: { name: 'E', email: null, mobile: '+91', closedAt: null } });
  employeeRepo.findByEmployeeId.mockResolvedValue(null);
  advertiserRepo.findById.mockResolvedValue(null);
  advertiserRepo.findByProfileId.mockResolvedValue(null);
  advertisers.findAdvertiser.mockResolvedValue({ id: 'adv_1', userId: 'usr_3', suspensionScopes: [], name: 'M', companyName: null, type: 'INDIVIDUAL', kycStatus: 'PENDING' });
});

describe('Request KYC refuses a closed or blocked party', () => {
  it('agent: a closed account is 409 ACCOUNT_CLOSED, nothing started', async () => {
    agentRepo.findAgentContact.mockResolvedValue({ id: 'agt_1', userId: 'usr_1', displayId: null, suspensionScopes: [], user: { name: 'R', email: null, mobile: '+91', closedAt: CLOSED } });
    await expect(requestAgentKyc('agt_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    expect(agentDigio.initiateAgentDigioKyc).not.toHaveBeenCalled();
    expect(agentRepo.requestKyc).not.toHaveBeenCalled();
  });

  it('agent: suspended from new work is 409 ACCOUNT_SUSPENDED', async () => {
    agentRepo.findAgentContact.mockResolvedValue({ id: 'agt_1', userId: 'usr_1', displayId: null, suspensionScopes: ['BLOCK_NEW'], user: { name: 'R', email: null, mobile: '+91', closedAt: null } });
    await expect(requestAgentKyc('agt_1', { channel: 'MANUAL' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_SUSPENDED' });
  });

  it('employee: a closed account is 409 ACCOUNT_CLOSED', async () => {
    employeeRepo.findEmployeeContact.mockResolvedValue({ id: 'emp_1', userId: 'usr_2', displayId: null, user: { name: 'E', email: null, mobile: '+91', closedAt: CLOSED } });
    await expect(requestEmployeeKyc('emp_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    expect(employeeDigio.initiateEmployeeDigioKyc).not.toHaveBeenCalled();
  });

  it('advertiser: the account behind the profile is read, and a closed one is refused', async () => {
    prisma.user.findUnique.mockResolvedValue({ isActive: false, closedAt: CLOSED });
    await expect(requestAdvertiserKyc('adv_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'usr_3' } }));
    expect(advertiserDigio.initiateAdvertiserDigioKyc).not.toHaveBeenCalled();
  });

  it('advertiser: suspended from new work is refused', async () => {
    advertisers.findAdvertiser.mockResolvedValue({ id: 'adv_1', userId: 'usr_3', suspensionScopes: ['BLOCK_NEW'], name: 'M', companyName: null, type: 'INDIVIDUAL', kycStatus: 'PENDING' });
    await expect(requestAdvertiserKyc('adv_1', { channel: 'MANUAL' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_SUSPENDED' });
    expect(advertiserRepo.requestKyc).not.toHaveBeenCalled();
  });
});

describe('a decided case is kept', () => {
  it('DELETE /advertiser-kyc/:id refuses VERIFIED and REJECTED, and removes an undecided one', async () => {
    for (const status of ['VERIFIED', 'REJECTED']) {
      advertiserRepo.findById.mockResolvedValue({ id: 'akyc_1', status });
      await expect(deleteAdvertiserKyc('akyc_1')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_DECIDED' });
    }
    expect(advertiserRepo.remove).not.toHaveBeenCalled();
    advertiserRepo.findById.mockResolvedValue({ id: 'akyc_1', status: 'PENDING' });
    await deleteAdvertiserKyc('akyc_1');
    expect(advertiserRepo.remove).toHaveBeenCalledWith('akyc_1');
  });

  it('DELETE /user-kyc/:id refuses a decided one', async () => {
    userRepo.findById.mockResolvedValue({ id: 'ukyc_1', status: 'VERIFIED' });
    await expect(deleteUserKycById('ukyc_1')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_DECIDED' });
    expect(userRepo.removeById).not.toHaveBeenCalled();
    userRepo.findById.mockResolvedValue({ id: 'ukyc_1', status: 'NEEDS_INFO' });
    await deleteUserKycById('ukyc_1');
    expect(userRepo.removeById).toHaveBeenCalledWith('ukyc_1');
  });
});
