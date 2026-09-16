import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q118/138) — the score on a case, the scan with no case, the linked
 * accounts, and the nightly scan. What is pinned: the score is recomputed
 * over the resolved subject and stored with its signals and the time; a
 * decided case keeps its score; a scan stores nothing and names the open
 * case; the linked read folds the shared signals by account; the nightly
 * scan opens exactly one SIGNAL_SCAN case per hot party with none open,
 * scored, tells the admins, escalates the pending KYC through the shared
 * opener, and never touches a suspension.
 */

type AnyFn = (...args: any[]) => any;
const { repository, index, settings, users, notifications, audit, identifiers, kyc } = vi.hoisted(() => ({
  repository: {
    findSummaryById: vi.fn<AnyFn>(),
    update: vi.fn<AnyFn>(),
    create: vi.fn<AnyFn>(),
    findOpenForSubject: vi.fn<AnyFn>(),
  },
  index: {
    resolveSubject: vi.fn<AnyFn>(),
    partiesWithPan: vi.fn<AnyFn>(async () => []),
    payoutHandlesFor: vi.fn<AnyFn>(async () => []),
    partiesWithPayoutHandle: vi.fn<AnyFn>(async () => []),
    signInSubnetsFor: vi.fn<AnyFn>(async () => []),
    partiesOnSubnets: vi.fn<AnyFn>(async () => []),
    partiesWithMobile: vi.fn<AnyFn>(async () => []),
    deviceTokensFor: vi.fn<AnyFn>(async () => []),
    partiesWithDeviceTokens: vi.fn<AnyFn>(async () => []),
    listingPhotosFor: vi.fn<AnyFn>(async () => []),
    listingPhotosOfOthers: vi.fn<AnyFn>(async () => []),
    proofPhotosFor: vi.fn<AnyFn>(async () => []),
    onboardedPublishersOf: vi.fn<AnyFn>(async () => []),
    bookingOutcomesFor: vi.fn<AnyFn>(async () => ({ bookings: 0, refunds: 0, disputes: 0 })),
    walletMovementsFor: vi.fn<AnyFn>(async () => ({ credits: [], withdrawals: [] })),
    listingCreatedAtFor: vi.fn<AnyFn>(async () => []),
    scanCandidates: vi.fn<AnyFn>(async () => []),
  },
  settings: { getPlatformSettings: vi.fn<AnyFn>(async () => ({ fraud: { scanThreshold: 0.6, scanLimitPerType: 500 } })) },
  users: { listAdminUserIds: vi.fn<AnyFn>(async () => ['usr_admin', 'usr_admin2']), userExists: vi.fn<AnyFn>(async () => true) },
  notifications: { createNotification: vi.fn<AnyFn>(async () => undefined) },
  audit: { logActivity: vi.fn<AnyFn>(async () => undefined), auditDiff: vi.fn<AnyFn>(() => ({})) },
  identifiers: { allocateIdentifier: vi.fn<AnyFn>(async () => 'FRD-1409-0007') },
  kyc: { escalateKycForFraudLink: vi.fn<AnyFn>(async () => null) },
}));

vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: repository }));
vi.mock('../prisma-fraud-signals.repository', () => ({ prismaFraudSignalsIndex: index }));
vi.mock('../../app-config', () => settings);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../kyc', () => kyc);
vi.mock('../../suspension', () => ({ suspensionOf: vi.fn(), suspendParty: vi.fn(), reinstateParty: vi.fn(), SCOPES_BY_PARTY: {} }));
// G11-1: the linked read prices each party — no wallets, nothing open, here (pinned in g11-linked-exposure.test.ts).
vi.mock('../../wallets', () => ({ findWalletFor: vi.fn(async () => null) }));
vi.mock('../../orders', () => ({ openOrderExposureFor: vi.fn(async () => ({ count: 0, value: '0.00' })) }));

import { linkedAccounts, runSignalScan, scanSubject, scoreCase } from '../fraud-signals.service';

const now = new Date('2026-09-14T02:30:00.000Z');
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };
const other = { type: 'ADVERTISER' as const, id: 'adv_9', name: 'Suresh' };

const subject = {
  type: 'PUBLISHER' as const,
  id: 'pub_1',
  userId: 'usr_pub',
  name: 'Ramesh Kumar',
  mobile: '+919999900001',
  pan: 'ABCDE1234F',
  kycStatus: 'PENDING',
  agentId: null,
  listingId: null,
};

const fraudCase = (over: Record<string, unknown> = {}) => ({
  id: 'frd_1',
  displayId: 'FRD-26-0001',
  subjectType: 'PUBLISHER',
  subjectId: 'pub_1',
  kind: 'FAKE_PROOF',
  status: 'OPEN',
  summary: 'x',
  openedByUserId: 'usr_admin',
  assignedToUserId: null,
  score: null,
  signals: null,
  scoredAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  index.resolveSubject.mockResolvedValue(subject);
  index.partiesWithPan.mockResolvedValue([]);
  index.partiesWithPayoutHandle.mockResolvedValue([]);
  index.payoutHandlesFor.mockResolvedValue([]);
  index.scanCandidates.mockResolvedValue([]);
  repository.findSummaryById.mockResolvedValue(fraudCase());
  repository.findOpenForSubject.mockResolvedValue(null);
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => fraudCase({ id, ...patch }));
  repository.create.mockImplementation(async (data: Record<string, unknown>) => fraudCase({ id: 'frd_new', ...data }));
});

describe('scoring a case', () => {
  it('recomputes over the resolved subject and stores the score, the signals and the time', async () => {
    index.partiesWithPan.mockResolvedValue([other]);
    const { after } = await scoreCase('frd_1', admin, now);
    expect(index.resolveSubject).toHaveBeenCalledWith({ type: 'PUBLISHER', id: 'pub_1' });
    const patch = repository.update.mock.calls[0]![1] as { score: string; signals: { key: string; value: number | null; links?: unknown[] }[]; scoredAt: Date };
    // SHARED_PAN .35 + SELF_DEALING .4 (an advertiser on the same PAN).
    expect(patch.score).toBe('0.750');
    expect(patch.scoredAt).toEqual(now);
    expect(patch.signals).toHaveLength(13);
    expect(patch.signals.find((s) => s.key === 'SHARED_PAN')).toMatchObject({ value: 1, links: [other] });
    expect(after.score).toBe('0.750');
  });

  it('refuses a decided case (its score is part of the record) and 404s a missing party', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'CONFIRMED' }));
    await expect(scoreCase('frd_1', admin, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValue(fraudCase());
    index.resolveSubject.mockResolvedValue(null);
    await expect(scoreCase('frd_1', admin, now)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('scanning a party with no case', () => {
  it('answers the signals and the score, stores nothing, and names the open case if there is one', async () => {
    repository.findOpenForSubject.mockResolvedValue(fraudCase({ status: 'INVESTIGATING' }));
    const result = await scanSubject('LISTING', 'lst_1', now);
    expect(index.resolveSubject).toHaveBeenCalledWith({ type: 'LISTING', id: 'lst_1' });
    expect(result).toMatchObject({ subject: { type: 'PUBLISHER', id: 'pub_1', name: 'Ramesh Kumar' }, score: '0.000', openCase: { id: 'frd_1', status: 'INVESTIGATING' } });
    expect(result.signals).toHaveLength(13);
    expect((result.subject as Record<string, unknown>)['pan']).toBeUndefined();
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('the linked accounts', () => {
  it('folds the shared signals by account, naming every signal that ties it', async () => {
    index.partiesWithPan.mockResolvedValue([other]);
    index.payoutHandlesFor.mockResolvedValue([{ accountNumber: '1', upiVpa: null, accountHolder: null, nameMatchPct: null }]);
    index.partiesWithPayoutHandle.mockResolvedValue([other, { type: 'PUBLISHER', id: 'pub_2', name: null }]);
    const result = await linkedAccounts('frd_1', now);
    expect(result.linked).toEqual([
      { party: other, via: ['SHARED_PAN', 'SHARED_BANK', 'SELF_DEALING'], walletBalance: null, openBookings: 0 },
      { party: { type: 'PUBLISHER', id: 'pub_2', name: null }, via: ['SHARED_BANK'], walletBalance: null, openBookings: 0 },
    ]);
    expect(result.valueAtRisk).toBe('0.00');
    // Only the linking signals are evaluated for this read.
    expect(index.proofPhotosFor).not.toHaveBeenCalled();
  });
});

describe('the nightly scan', () => {
  it('opens one SIGNAL_SCAN case per hot party with none open, scored, and tells the admins', async () => {
    index.scanCandidates.mockResolvedValue([
      { type: 'PUBLISHER', id: 'pub_1' },
      { type: 'PUBLISHER', id: 'pub_quiet' },
      { type: 'ADVERTISER', id: 'adv_open' },
    ]);
    index.resolveSubject.mockImplementation(async (s: { type: string; id: string }) => ({ ...subject, type: s.type, id: s.id, pan: s.id === 'pub_quiet' ? null : 'ABCDE1234F' }));
    index.partiesWithPan.mockImplementation(async (_pan: string, exclude: { id: string }) => (exclude.id === 'pub_quiet' ? [] : [other]));
    repository.findOpenForSubject.mockImplementation(async (_t: string, id: string) => (id === 'adv_open' ? fraudCase({ id: 'frd_open', subjectId: 'adv_open' }) : null));

    const report = await runSignalScan('usr_system', now);

    expect(report).toMatchObject({ scanned: 3, alreadyOpen: 1, threshold: 0.6 });
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]).toMatchObject({ subjectType: 'PUBLISHER', subjectId: 'pub_1', hot: ['SHARED_PAN', 'SELF_DEALING'] });
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'SIGNAL_SCAN', subjectType: 'PUBLISHER', subjectId: 'pub_1', openedByUserId: 'usr_system', displayId: 'FRD-1409-0007', score: '0.750', scoredAt: now }),
      now,
    );
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('FRAUD_CASE', now);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_system', 'FRAUD_CASE_OPENED', expect.objectContaining({ targetType: 'FraudCase', targetId: 'frd_new' }));
    expect(kyc.escalateKycForFraudLink).toHaveBeenCalledWith(expect.objectContaining({ subjectType: 'PUBLISHER', subjectId: 'pub_1' }));
    const told = notifications.createNotification.mock.calls.map((call) => (call[0] as { userId: string }).userId).sort();
    expect(told).toEqual(['usr_admin', 'usr_admin2']);
  });

  it('opens nothing and tells nobody when no signal runs hot', async () => {
    index.scanCandidates.mockResolvedValue([{ type: 'AGENT', id: 'agt_1' }]);
    const report = await runSignalScan('usr_system', now);
    expect(report).toMatchObject({ scanned: 1, opened: [], alreadyOpen: 0 });
    expect(repository.create).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
