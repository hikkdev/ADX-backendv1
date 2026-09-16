import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q127/142) — KYC escalation, three sources, one landing.
 *
 * What is pinned: the case is stamped with when, why, from where, by whom
 * and to whom; the escalatee comes from the Compliance role, else the
 * seeded KYC reviewer, else Super admin, else any ADMIN, and never the
 * reviewer escalating their own case while someone else is in the pool;
 * they are told and KYC_ESCALATED is audited; a reviewer's escalation is
 * strict (409 on a decided or already-escalated case) while the job's and
 * the fraud link's are idempotent; the age job escalates PENDING rows past
 * multiplier × SLA on both queues; the fraud link resolves a listing to its
 * publisher and ignores an agent.
 */

type AnyFn = (...args: any[]) => any;
const { repository, roles, settings, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findPublisherCase: vi.fn<AnyFn>(),
    findPublisherCaseByListing: vi.fn<AnyFn>(),
    findAdvertiserCaseById: vi.fn<AnyFn>(),
    findAdvertiserCaseByAdvertiserId: vi.fn<AnyFn>(),
    // Lot N: the print partner's row.
    findPrintPartnerCaseById: vi.fn<AnyFn>(),
    markEscalated: vi.fn<AnyFn>(async () => undefined),
    findAgedPending: vi.fn<AnyFn>(async () => []),
    adminUserIds: vi.fn<AnyFn>(async () => ['usr_admin']),
  },
  roles: { findRoleMemberUserIds: vi.fn<AnyFn>(async () => []) },
  settings: { getPlatformSettings: vi.fn<AnyFn>(async () => ({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2 } })) },
  notifications: { createNotification: vi.fn<AnyFn>(async () => undefined) },
  audit: { logActivity: vi.fn<AnyFn>(async () => undefined) },
}));

vi.mock('../prisma-kyc-escalation.repository', () => ({ prismaKycEscalationRepository: repository }));
vi.mock('../../access-control', () => roles);
vi.mock('../../app-config', () => settings);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);

import { escalateAgedKycCases, escalateKyc, escalateKycForFraudLink, resolveEscalatee } from '../escalation.service';

const now = new Date('2026-09-14T03:00:00.000Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

const publisherCase = (over: Record<string, unknown> = {}) => ({
  party: 'PUBLISHER' as const,
  kycId: 'pkyc_1',
  partyId: 'pub_1',
  partyName: 'Ramesh',
  userId: 'usr_pub',
  status: 'PENDING',
  submittedAt: hoursAgo(10),
  assignedToId: null,
  escalatedAt: null,
  escalationSource: null,
  escalationReason: null,
  escalatedToUserId: null,
  escalatedById: null,
  targetType: 'Publisher' as const,
  targetId: 'pub_1',
  ...over,
});

const advertiserCase = (over: Record<string, unknown> = {}) =>
  publisherCase({ party: 'ADVERTISER', kycId: 'akyc_1', partyId: 'usr_adv', partyName: 'Acme', userId: 'usr_adv', targetType: 'AdvertiserKyc', targetId: 'akyc_1', ...over });

/* Lot N: the third party. */
const printPartnerCase = (over: Record<string, unknown> = {}) =>
  publisherCase({ party: 'PRINT_PARTNER', kycId: 'ppk_1', partyId: 'prt_1', partyName: 'Sharma Prints', userId: 'usr_prt', targetType: 'PrintPartnerKyc', targetId: 'ppk_1', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  roles.findRoleMemberUserIds.mockImplementation(async (name: string) => (name === 'Compliance' ? ['usr_comp1', 'usr_comp2'] : []));
  repository.adminUserIds.mockResolvedValue(['usr_admin']);
  repository.findPublisherCase.mockResolvedValue(publisherCase());
  repository.findAdvertiserCaseById.mockResolvedValue(advertiserCase());
  repository.findPrintPartnerCaseById.mockResolvedValue(printPartnerCase());
  repository.findAgedPending.mockResolvedValue([]);
});

describe('the pool', () => {
  it('takes Compliance first, minus the person escalating', async () => {
    const picked = await resolveEscalatee('pkyc_1', 'usr_comp1');
    expect(picked).toBe('usr_comp2');
  });

  it('falls to KYC reviewer, then Super admin, then any ADMIN; only the escalator when nobody else exists', async () => {
    roles.findRoleMemberUserIds.mockImplementation(async (name: string) => (name === 'KYC reviewer' ? ['usr_kyc'] : []));
    expect(await resolveEscalatee('pkyc_1', 'usr_ops')).toBe('usr_kyc');
    roles.findRoleMemberUserIds.mockImplementation(async (name: string) => (name === 'Super admin' ? ['usr_super'] : []));
    expect(await resolveEscalatee('pkyc_1', 'usr_ops')).toBe('usr_super');
    roles.findRoleMemberUserIds.mockResolvedValue([]);
    expect(await resolveEscalatee('pkyc_1', 'usr_ops')).toBe('usr_admin');
    expect(await resolveEscalatee('pkyc_1', 'usr_admin')).toBe('usr_admin');
    repository.adminUserIds.mockResolvedValue([]);
    expect(await resolveEscalatee('pkyc_1', 'usr_admin')).toBeNull();
  });
});

describe('a reviewer escalating (REVIEWER)', () => {
  it('stamps the publisher row, audits KYC_ESCALATED against the publisher, and tells the escalatee', async () => {
    const result = await escalateKyc({ party: 'PUBLISHER', publisherId: 'pub_1' }, { reason: 'Documents look edited', byUserId: 'usr_comp1' }, now);
    expect(repository.markEscalated).toHaveBeenCalledWith('PUBLISHER', 'pkyc_1', {
      escalatedAt: now,
      escalationSource: 'REVIEWER',
      escalationReason: 'Documents look edited',
      escalatedToUserId: 'usr_comp2',
      escalatedById: 'usr_comp1',
    });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_comp1', 'KYC_ESCALATED', expect.objectContaining({ module: 'kyc', targetType: 'Publisher', targetId: 'pub_1', metadata: expect.objectContaining({ source: 'REVIEWER', escalatedToUserId: 'usr_comp2' }) }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_comp2', type: 'KYC', relatedId: 'pub_1', relatedType: 'PUBLISHER' }));
    expect(result).toMatchObject({ party: 'PUBLISHER', kycId: 'pkyc_1', escalationSource: 'REVIEWER', escalatedToUserId: 'usr_comp2' });
  });

  it('works the advertiser row by its KYC id, against AdvertiserKyc', async () => {
    await escalateKyc({ party: 'ADVERTISER', kycId: 'akyc_1' }, { reason: 'PAN mismatch', byUserId: 'usr_ops' }, now);
    expect(repository.markEscalated).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', expect.objectContaining({ escalationSource: 'REVIEWER' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_ops', 'KYC_ESCALATED', expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ relatedType: 'ADVERTISER' }));
  });

  it('Lot N: works the print partner row by its KYC id, against PrintPartnerKyc, with no relatedType (the apps open no partner screen)', async () => {
    const result = await escalateKyc({ party: 'PRINT_PARTNER', kycId: 'ppk_1' }, { reason: 'GST certificate looks altered', byUserId: 'usr_ops' }, now);
    expect(repository.findPrintPartnerCaseById).toHaveBeenCalledWith('ppk_1');
    expect(repository.markEscalated).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', expect.objectContaining({ escalationSource: 'REVIEWER', escalatedById: 'usr_ops' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_ops', 'KYC_ESCALATED', expect.objectContaining({ module: 'kyc', targetType: 'PrintPartnerKyc', targetId: 'ppk_1', metadata: expect.objectContaining({ party: 'PRINT_PARTNER', partyId: 'prt_1' }) }));
    const notice = notifications.createNotification.mock.calls[0]![0];
    expect(notice).toMatchObject({ type: 'KYC', relatedId: 'prt_1', subtitle: 'Sharma Prints' });
    expect(notice).not.toHaveProperty('relatedType');
    expect(result).toMatchObject({ party: 'PRINT_PARTNER', kycId: 'ppk_1', partyId: 'prt_1' });

    repository.findPrintPartnerCaseById.mockResolvedValue(printPartnerCase({ status: 'REJECTED' }));
    await expect(escalateKyc({ party: 'PRINT_PARTNER', kycId: 'ppk_1' }, { reason: 'x', byUserId: 'u' }, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findPrintPartnerCaseById.mockResolvedValue(null);
    await expect(escalateKyc({ party: 'PRINT_PARTNER', kycId: 'ppk_x' }, { reason: 'x', byUserId: 'u' }, now)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a decided case, an already-escalated one, and a party with no row', async () => {
    repository.findPublisherCase.mockResolvedValue(publisherCase({ status: 'VERIFIED' }));
    await expect(escalateKyc({ party: 'PUBLISHER', publisherId: 'pub_1' }, { reason: 'x', byUserId: 'u' }, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findPublisherCase.mockResolvedValue(publisherCase({ escalatedAt: hoursAgo(1), escalationSource: 'AGE' }));
    await expect(escalateKyc({ party: 'PUBLISHER', publisherId: 'pub_1' }, { reason: 'x', byUserId: 'u' }, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findPublisherCase.mockResolvedValue(null);
    await expect(escalateKyc({ party: 'PUBLISHER', publisherId: 'pub_x' }, { reason: 'x', byUserId: 'u' }, now)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.markEscalated).not.toHaveBeenCalled();
  });

  it('escalates a NEEDS_INFO case too — it is still open', async () => {
    repository.findPublisherCase.mockResolvedValue(publisherCase({ status: 'NEEDS_INFO' }));
    await escalateKyc({ party: 'PUBLISHER', publisherId: 'pub_1' }, { reason: 'Third re-upload ask', byUserId: 'usr_ops' }, now);
    expect(repository.markEscalated).toHaveBeenCalled();
  });
});

describe('the fraud link (FRAUD_LINK)', () => {
  it('escalates a PENDING publisher case when a fraud case is opened, naming the case', async () => {
    const result = await escalateKycForFraudLink({ subjectType: 'PUBLISHER', subjectId: 'pub_1', caseDisplayId: 'FRD-1409-0007', byUserId: 'usr_admin' }, now);
    expect(repository.markEscalated).toHaveBeenCalledWith('PUBLISHER', 'pkyc_1', expect.objectContaining({ escalationSource: 'FRAUD_LINK', escalationReason: expect.stringContaining('FRD-1409-0007'), escalatedById: 'usr_admin' }));
    expect(result?.escalationSource).toBe('FRAUD_LINK');
  });

  it('resolves a listing to its publisher, an advertiser through its login, and ignores an agent', async () => {
    repository.findPublisherCaseByListing.mockResolvedValue(publisherCase());
    await escalateKycForFraudLink({ subjectType: 'LISTING', subjectId: 'lst_1', caseDisplayId: 'FRD-1', byUserId: 'u' }, now);
    expect(repository.findPublisherCaseByListing).toHaveBeenCalledWith('lst_1');
    repository.findAdvertiserCaseByAdvertiserId.mockResolvedValue(advertiserCase());
    await escalateKycForFraudLink({ subjectType: 'ADVERTISER', subjectId: 'adv_1', caseDisplayId: 'FRD-2', byUserId: 'u' }, now);
    expect(repository.markEscalated).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', expect.objectContaining({ escalationSource: 'FRAUD_LINK' }));
    expect(await escalateKycForFraudLink({ subjectType: 'AGENT', subjectId: 'agt_1', caseDisplayId: 'FRD-3', byUserId: 'u' }, now)).toBeNull();
  });

  it('is idempotent: nothing on a decided, NEEDS_INFO or already-escalated case', async () => {
    repository.findPublisherCase.mockResolvedValue(publisherCase({ status: 'VERIFIED' }));
    expect(await escalateKycForFraudLink({ subjectType: 'PUBLISHER', subjectId: 'pub_1', caseDisplayId: 'FRD-1', byUserId: 'u' }, now)).toBeNull();
    repository.findPublisherCase.mockResolvedValue(publisherCase({ escalatedAt: hoursAgo(1) }));
    expect(await escalateKycForFraudLink({ subjectType: 'PUBLISHER', subjectId: 'pub_1', caseDisplayId: 'FRD-1', byUserId: 'u' }, now)).toBeNull();
    expect(repository.markEscalated).not.toHaveBeenCalled();
  });
});

describe('the nightly age sweep (AGE)', () => {
  it('escalates PENDING rows past multiplier × SLA on both queues, under the system user, and reports the cutoff', async () => {
    // Lot N: the print partner's queue walks the same night.
    repository.findAgedPending.mockImplementation(async (party: string) =>
      party === 'PUBLISHER'
        ? [publisherCase({ submittedAt: hoursAgo(100) })]
        : party === 'PRINT_PARTNER'
          ? [printPartnerCase({ submittedAt: hoursAgo(130) })]
          : [advertiserCase({ submittedAt: hoursAgo(120) })],
    );
    const report = await escalateAgedKycCases('usr_system', now);
    expect(repository.findAgedPending).toHaveBeenCalledWith('PUBLISHER', hoursAgo(96), 200);
    expect(repository.findAgedPending).toHaveBeenCalledWith('ADVERTISER', hoursAgo(96), 200);
    expect(repository.findAgedPending).toHaveBeenCalledWith('PRINT_PARTNER', hoursAgo(96), 200);
    expect(report).toMatchObject({ slaHours: 48, multiplier: 2, cutoff: hoursAgo(96), publishers: ['pkyc_1'], advertisers: ['akyc_1'], printPartners: ['ppk_1'] });
    expect(repository.markEscalated).toHaveBeenCalledWith('PUBLISHER', 'pkyc_1', expect.objectContaining({ escalationSource: 'AGE', escalatedById: 'usr_system', escalationReason: expect.stringContaining('2× the 48 h') }));
    expect(repository.markEscalated).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', expect.objectContaining({ escalationSource: 'AGE' }));
    expect(audit.logActivity).toHaveBeenCalledTimes(3);
  });

  it('writes no audit row when no actor is known, but still escalates and tells the pool', async () => {
    repository.findAgedPending.mockImplementation(async (party: string) => (party === 'PUBLISHER' ? [publisherCase()] : []));
    await escalateAgedKycCases(null, now);
    expect(repository.markEscalated).toHaveBeenCalledTimes(1);
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });
});
