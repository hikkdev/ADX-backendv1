import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 28 Sep 2026 — the shared attributes on GET /fraud/cases/:id/linked.
 *
 * The console draws the read as a bipartite graph: accounts on one side,
 * the things they share on the other. `attributes` names those things, one
 * per linking signal that tied the subject to somebody, with a MASKED
 * display value and how many linked accounts share it. What is pinned: each
 * mask keeps at most four characters and never a whole value, whatever the
 * length; the service reads only the handles of the signals that linked;
 * and a full PAN, account number, UPI id, mobile or sign-in address never
 * appears anywhere in the response.
 */

type AnyFn = (...args: any[]) => any;
const { repository, index, wallets, orders } = vi.hoisted(() => ({
  repository: { findSummaryById: vi.fn<AnyFn>(), update: vi.fn<AnyFn>(), create: vi.fn<AnyFn>(), findOpenForSubject: vi.fn<AnyFn>() },
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
  wallets: { findWalletFor: vi.fn<AnyFn>(async () => null) },
  orders: { openOrderExposureFor: vi.fn<AnyFn>(async () => ({ count: 0, value: '0.00' })) },
}));

vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: repository }));
vi.mock('../prisma-fraud-signals.repository', () => ({ prismaFraudSignalsIndex: index }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ fraud: { scanThreshold: 0.6, scanLimitPerType: 500 } })) }));
vi.mock('../../users', () => ({ listAdminUserIds: vi.fn(async () => []), userExists: vi.fn(async () => true), findUserLabels: vi.fn(async () => new Map()) }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(async () => undefined), auditDiff: vi.fn(() => ({})) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'FRD-1409-0007') }));
vi.mock('../../kyc', () => ({ escalateKycForFraudLink: vi.fn(async () => null) }));
vi.mock('../../suspension', () => ({ suspensionOf: vi.fn(), suspendParty: vi.fn(), reinstateParty: vi.fn(), SCOPES_BY_PARTY: {} }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../orders', () => orders);

import { linkedAccounts } from '../fraud-signals.service';
import {
  bankShortName,
  maskDevice,
  maskedTail,
  maskPan,
  maskPayout,
  maskPhone,
  maskSubnet,
  sharedAttributes,
  signalLabel,
} from '../signals/shared-attributes';

const FULL_PAN = 'ABCDE1234F';
const FULL_ACCOUNT = '50100012344821';
const FULL_MOBILE = '+919876543210';
const FULL_UPI = 'ramesh.kumar@okhdfc';
const DEVICE_TOKEN = 'f4f2a9c1d7e8b6a5c4d3e2f1a0b9c8d7';
const FULL_IP = '103.21.58.47';

describe('the masks', () => {
  it('keep the last four of a long value, two of a middling one, nothing of a short one', () => {
    expect(maskedTail('50100012344821')).toBe('4821');
    expect(maskedTail('1234-5678 90')).toBe('7890');
    expect(maskedTail('123456')).toBe('56');
    expect(maskedTail('1234')).toBe('');
    expect(maskedTail(null)).toBe('');
  });

  it('PAN → "PAN ••••" and its last four', () => {
    expect(maskPan(FULL_PAN)).toBe('PAN ••••234F');
    expect(maskPan('abcde1234f')).toBe('PAN ••••234F');
  });

  it('a payout account → the bank short name, "••" and its last four; a UPI id → its handle masked the same', () => {
    expect(maskPayout({ accountNumber: FULL_ACCOUNT, upiVpa: null, bankName: 'HDFC Bank', ifscCode: 'HDFC0001234' })).toBe('HDFC ••4821');
    expect(maskPayout({ accountNumber: FULL_ACCOUNT, upiVpa: null, bankName: 'State Bank of India', ifscCode: null })).toBe('SBI ••4821');
    expect(maskPayout({ accountNumber: FULL_ACCOUNT, upiVpa: null, bankName: null, ifscCode: 'UTIB0000123' })).toBe('UTIB ••4821');
    expect(maskPayout({ accountNumber: FULL_ACCOUNT, upiVpa: null, bankName: null, ifscCode: null })).toBe('Bank ••4821');
    expect(maskPayout({ accountNumber: null, upiVpa: '9876543210@ybl', bankName: null, ifscCode: null })).toBe('UPI ••3210');
    expect(maskPayout({ accountNumber: null, upiVpa: FULL_UPI, bankName: null, ifscCode: null })).toBe('UPI ••umar');
    // Too short to mask safely: nothing of it is shown.
    expect(maskPayout({ accountNumber: '1', upiVpa: null, bankName: 'ICICI Bank', ifscCode: null })).toBe('ICICI ••');
    expect(bankShortName('Kotak Mahindra Bank', 'KKBK0000958')).toBe('KKBK');
  });

  it('a device → its first four characters, and the sessions when known; a subnet → a.b.c.x/24; a mobile → "••" and its last four', () => {
    expect(maskDevice(DEVICE_TOKEN)).toBe('Device f4f2');
    expect(maskDevice(DEVICE_TOKEN, 6)).toBe('Device f4f2 · 6 sessions');
    expect(maskDevice('short')).toBe('Device');
    expect(maskSubnet('103.21.58.0/24')).toBe('103.21.58.x/24');
    expect(maskSubnet('2401:4900:1c2a:77b0::/64')).toBe('2401:4900:x::/64');
    expect(maskSubnet('garbage')).toBe('IP subnet');
    expect(maskPhone(FULL_MOBILE)).toBe('Mobile ••3210');
  });

  it('one attribute per signal that linked somebody, counting distinct accounts, any other signal by its label', () => {
    const a = { type: 'ADVERTISER' as const, id: 'adv_1', name: 'A' };
    const b = { type: 'PUBLISHER' as const, id: 'pub_2', name: 'B' };
    const attributes = sharedAttributes(
      [
        { key: 'SHARED_PAN', weight: 0.35, value: 1, detail: 'x', links: [a, b, a] },
        { key: 'SHARED_BANK', weight: 0.35, value: 0, detail: 'none' },
        { key: 'SHARED_IP_SUBNET', weight: 0.15, value: 1, detail: 'x', links: [b] },
        { key: 'DUPLICATE_LISTING_PHOTOS', weight: 0.3, value: 1, detail: 'x', links: [b] },
        { key: 'SOMETHING_NEW', weight: 0.1, value: 1, detail: 'x', links: [a] },
      ],
      { pan: FULL_PAN, mobile: null, payout: [], subnets: ['103.21.58.0/24', '49.36.12.0/24'], deviceTokens: [] },
    );
    expect(attributes).toEqual([
      { signal: 'SHARED_PAN', label: 'PAN number', display: 'PAN ••••234F', accounts: 2 },
      { signal: 'SHARED_IP_SUBNET', label: 'IP subnet', display: '103.21.58.x/24 +1', accounts: 1 },
      { signal: 'DUPLICATE_LISTING_PHOTOS', label: 'Duplicate listing photos', display: 'Duplicate listing photos', accounts: 1 },
      { signal: 'SOMETHING_NEW', label: 'SOMETHING_NEW', display: 'SOMETHING_NEW', accounts: 1 },
    ]);
    expect(signalLabel('SHARED_DEVICE')).toBe('Device fingerprint');
  });
});

const now = new Date('2026-09-28T06:00:00.000Z');
const subject = { type: 'PUBLISHER' as const, id: 'pub_1', userId: 'usr_pub', name: 'Ramesh Kumar', mobile: FULL_MOBILE, pan: FULL_PAN, kycStatus: 'VERIFIED', agentId: null, listingId: null };
const prime = { type: 'ADVERTISER' as const, id: 'adv_2', name: 'Prime Ads' };
const nova = { type: 'ADVERTISER' as const, id: 'adv_3', name: 'Nova Reach' };
const meera = { type: 'AGENT' as const, id: 'agt_4', name: 'Meera' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findSummaryById.mockResolvedValue({ id: 'frd_1', subjectType: 'PUBLISHER', subjectId: 'pub_1', status: 'OPEN' });
  index.resolveSubject.mockImplementation(async (s: { id: string }) => (s.id === 'pub_1' ? subject : null));
  index.partiesWithPan.mockResolvedValue([prime, nova]);
  index.payoutHandlesFor.mockResolvedValue([
    { accountNumber: FULL_ACCOUNT, upiVpa: null, accountHolder: 'Ramesh Kumar', nameMatchPct: null, bankName: 'HDFC Bank', ifscCode: 'HDFC0001234' },
    { accountNumber: null, upiVpa: FULL_UPI, accountHolder: null, nameMatchPct: null, bankName: null, ifscCode: null },
  ]);
  index.partiesWithPayoutHandle.mockResolvedValue([prime]);
  index.signInSubnetsFor.mockResolvedValue(['103.21.58.0/24']);
  index.partiesOnSubnets.mockResolvedValue([prime, nova, meera]);
  index.deviceTokensFor.mockResolvedValue([DEVICE_TOKEN]);
  index.partiesWithDeviceTokens.mockResolvedValue([nova]);
  index.partiesWithMobile.mockResolvedValue([meera]);
});

describe('GET /fraud/cases/:id/linked — attributes', () => {
  it('answers one masked attribute per linking signal, with the linked accounts that share it', async () => {
    const result = await linkedAccounts('frd_1', now);
    expect(result.attributes).toEqual([
      { signal: 'SHARED_PAN', label: 'PAN number', display: 'PAN ••••234F', accounts: 2 },
      { signal: 'SHARED_BANK', label: 'Payout account', display: 'HDFC ••4821 +1', accounts: 1 },
      { signal: 'SHARED_IP_SUBNET', label: 'IP subnet', display: '103.21.58.x/24', accounts: 3 },
      { signal: 'SHARED_PHONE_ACROSS_ROLES', label: 'Mobile across roles', display: 'Mobile ••3210', accounts: 1 },
      { signal: 'SHARED_DEVICE', label: 'Device fingerprint', display: 'Device f4f2', accounts: 1 },
      { signal: 'SELF_DEALING', label: 'Self-dealing', display: 'Self-dealing', accounts: 2 },
    ]);
    // Every existing field is still there.
    expect(result).toMatchObject({ subject: { id: 'pub_1', kycStatus: 'VERIFIED' }, valueAtRisk: '0.00', evaluated: [] });
    expect(result.linked.map((l) => l.party.id)).toEqual(['adv_2', 'adv_3', 'agt_4']);
  });

  it('never answers a full PAN, account number, UPI id, mobile or sign-in address', async () => {
    index.signInSubnetsFor.mockResolvedValue(['103.21.58.0/24']);
    const body = JSON.stringify(await linkedAccounts('frd_1', now));
    for (const full of [FULL_PAN, FULL_ACCOUNT, FULL_UPI, FULL_MOBILE, FULL_MOBILE.slice(3), DEVICE_TOKEN, FULL_IP, '103.21.58.0']) {
      expect(body).not.toContain(full);
    }
  });

  it('reads only the handles of the signals that linked somebody', async () => {
    index.partiesWithPayoutHandle.mockResolvedValue([]);
    index.partiesOnSubnets.mockResolvedValue([]);
    index.partiesWithDeviceTokens.mockResolvedValue([]);
    index.partiesWithPan.mockResolvedValue([]);
    index.partiesWithMobile.mockResolvedValue([]);
    const result = await linkedAccounts('frd_1', now);
    expect(result.attributes).toEqual([]);
    // Each signal read its own handles once while evaluating; nothing more was read for the attributes.
    expect(index.payoutHandlesFor).toHaveBeenCalledTimes(2); // SHARED_BANK and SELF_DEALING
    expect(index.signInSubnetsFor).toHaveBeenCalledTimes(1);
    expect(index.deviceTokensFor).toHaveBeenCalledTimes(1);
  });
});
