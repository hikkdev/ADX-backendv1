import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-27 — the account's own code, for a multitude of access.
 *
 * One durable code per account. What a scan of it means is decided by who
 * scans and by the owner: an agent claims the onboarding while it is open
 * and asks for access once it is done (the ask travels on the scan, the
 * approval opens the grant), an advertiser is shown the profile, a plain
 * camera reads the `/q/<token>` link. The code outlives every decision.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    createPlaceholder: vi.fn(),
    setToken: vi.fn(),
    setPosition: vi.fn(),
    findById: vi.fn(),
    findActiveForSubject: vi.fn(),
    deactivate: vi.fn(),
    deactivateForSubject: vi.fn(),
    logScan: vi.fn(),
    findScans: vi.fn(),
    findScanById: vi.fn(),
    findPendingScan: vi.fn(),
    updateScan: vi.fn(),
  },
}));

vi.mock('../prisma-qr.repository', () => ({ prismaQrRepository: repository }));
vi.mock('../../../config/env', () => ({ env: { QR_SECRET: 'test-secret-that-is-long-enough-for-signing', PUBLIC_WEB_URL: 'https://adx.in' } }));

import { registerAccessGrantPort, registerAdvertiserOnboardingPort, registerPublisherOnboardingPort } from '../qr.ports';
import { sign } from '../qr.token';
import {
  decideOnboardingScan,
  describeIdentityByToken,
  getOrCreateIdentityQr,
  getScanForScanner,
  identityContent,
  resolveQr,
  tokenOf,
} from '../qr.service';

const identity = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-2109-2601',
  name: 'Skyline Outdoor Media',
  mobile: '+919000000201',
  type: 'BUSINESS',
  city: 'Bengaluru',
  verified: true,
  onboarded: true,
  ...over,
});

const publishers = {
  prepareClaim: vi.fn(),
  commitClaim: vi.fn(),
  describe: vi.fn(),
  workingAgentId: vi.fn(),
};
const advertisers = { prepareClaim: vi.fn(), commitClaim: vi.fn(), describe: vi.fn(), workingAgentId: vi.fn() };
const grants = { prepareClaim: vi.fn(), commitClaim: vi.fn(), openRequested: vi.fn() };
registerPublisherOnboardingPort(publishers);
registerAdvertiserOnboardingPort(advertisers);
registerAccessGrantPort(grants);

const code = (over: Record<string, unknown> = {}) => ({
  id: 'qr_1',
  type: 'PUBLISHER',
  refId: 'pub_1',
  allowedRoles: [],
  metadata: null,
  isActive: true,
  expiresAt: null,
  latitude: 12.9716,
  longitude: 77.5946,
  token: 't',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const token = () => sign({ id: 'qr_1', type: 'PUBLISHER', refId: 'pub_1', iat: Date.now() });
const ask = { scope: 'LISTINGS' as const, reason: 'Update the rates on your two boards', durationMinutes: 120 };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(code());
  repository.logScan.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'scan_1', createdAt: new Date(), ...data }));
  repository.updateScan.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  repository.deactivate.mockResolvedValue({});
  publishers.describe.mockResolvedValue(identity());
  publishers.workingAgentId.mockResolvedValue('agt_1');
  publishers.prepareClaim.mockResolvedValue({ publisher: { id: 'pub_1', name: 'Skyline', mobile: '+91', type: 'BUSINESS' }, agentId: 'agt_1' });
  publishers.commitClaim.mockResolvedValue({ grantId: 'grant_onb' });
  grants.openRequested.mockResolvedValue({ grantId: 'grant_req' });
});

describe('the code itself', () => {
  it('is minted once, without an expiry, and its fix follows the phone', async () => {
    repository.findActiveForSubject.mockResolvedValue(null);
    repository.createPlaceholder.mockResolvedValue({ id: 'qr_new' });
    repository.setToken.mockResolvedValue({});
    const first = await getOrCreateIdentityQr('PUBLISHER', 'pub_1', { latitude: 12.97, longitude: 77.59 });
    expect(first).toMatchObject({ qrId: 'qr_new', expiresAt: null, created: true });
    expect(repository.createPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ type: 'PUBLISHER', refId: 'pub_1', allowedRoles: [], latitude: 12.97 }));
    expect(repository.createPlaceholder.mock.calls[0]![0]).not.toHaveProperty('expiresAt', expect.any(Date));

    repository.findActiveForSubject.mockResolvedValue(code({ id: 'qr_new', token: 'tok' }));
    const again = await getOrCreateIdentityQr('PUBLISHER', 'pub_1', { latitude: 13.0, longitude: 77.6 });
    expect(again).toMatchObject({ qrId: 'qr_new', created: false });
    expect(repository.setPosition).toHaveBeenCalledWith('qr_new', { latitude: 13.0, longitude: 77.6 });
  });

  it('retires a ninety-second code from before and replaces it', async () => {
    repository.findActiveForSubject.mockResolvedValue(code({ id: 'qr_old', expiresAt: new Date(Date.now() + 30_000) }));
    repository.createPlaceholder.mockResolvedValue({ id: 'qr_new' });
    repository.setToken.mockResolvedValue({});
    const result = await getOrCreateIdentityQr('PUBLISHER', 'pub_1');
    expect(repository.deactivateForSubject).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
    expect(result).toMatchObject({ qrId: 'qr_new', created: true });
  });

  it('carries the web link so a plain camera can read it, and the scanner finds the token inside it', () => {
    expect(identityContent('abc.def')).toBe('https://adx.in/q/abc.def');
    expect(tokenOf('https://adx.in/q/abc.def')).toBe('abc.def');
    expect(tokenOf('  abc.def ')).toBe('abc.def');
    expect(tokenOf('https://adx.in/q/abc.def?utm=poster')).toBe('abc.def');
  });
});

describe('an agent at the door of an onboarded account', () => {
  it('is asked what for before anything is logged', async () => {
    const result = await resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER');
    expect(result).toMatchObject({ action: 'REQUEST_ACCESS', needsAsk: true, identity: { displayId: 'PUB-2109-2601', onboarded: true } });
    expect(repository.logScan).not.toHaveBeenCalled();
  });

  it('with an ask, the scan waits for the owner, carrying the ask and the distance', async () => {
    const result = await resolveQr(`https://adx.in/q/${token()}`, 'usr_agent', 'AGENT_PUBLISHER', { latitude: 12.9725, longitude: 77.5946 }, ask);
    expect(result).toMatchObject({ action: 'REQUEST_ACCESS', pendingApproval: true, scanId: 'scan_1', ask });
    expect(result.distanceM).toBeGreaterThan(50);
    expect(result.distanceM).toBeLessThan(150);
    expect(repository.logScan).toHaveBeenCalledWith(expect.objectContaining({ action: 'REQUEST_ACCESS', outcome: 'PENDING_APPROVAL', ask }));
    expect(publishers.prepareClaim).not.toHaveBeenCalled();
  });

  it('is refused, and written down, when the scanner is not a working agent', async () => {
    publishers.workingAgentId.mockResolvedValue(null);
    await expect(resolveQr(token(), 'usr_applicant', 'AGENT_PUBLISHER', undefined, ask)).rejects.toThrow('QR_ACCESS_DENIED');
    expect(repository.logScan).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'NOT_AN_AGENT' }));
  });

  it('the approval opens the grant the agent asked for, on that agent, and the code lives on', async () => {
    repository.findScanById.mockResolvedValue({ id: 'scan_1', qrId: 'qr_1', scannedById: 'usr_agent', action: 'REQUEST_ACCESS', outcome: 'PENDING_APPROVAL', createdAt: new Date(), ask });
    const decided = await decideOnboardingScan('scan_1', 'pub_1', 'approve');
    expect(grants.openRequested).toHaveBeenCalledWith({ subject: { publisherId: 'pub_1' }, agentId: 'agt_1', scannedByUserId: 'usr_agent', ask });
    expect(decided).toEqual({ outcome: 'GRANTED', grantId: 'grant_req' });
    expect(repository.deactivate).not.toHaveBeenCalled();
    expect(publishers.commitClaim).not.toHaveBeenCalled();

    const seen = await getScanForScanner('scan_1', 'usr_agent');
    expect(seen.ask).toEqual(ask);
  });

  it('a decline is recorded and the code lives on too', async () => {
    repository.findScanById.mockResolvedValue({ id: 'scan_1', qrId: 'qr_1', scannedById: 'usr_agent', action: 'REQUEST_ACCESS', outcome: 'PENDING_APPROVAL', createdAt: new Date(), ask });
    await expect(decideOnboardingScan('scan_1', 'pub_1', 'decline')).resolves.toEqual({ outcome: 'USER_DECLINED', grantId: null });
    expect(repository.deactivate).not.toHaveBeenCalled();
    expect(grants.openRequested).not.toHaveBeenCalled();
  });
});

describe('the same code, before onboarding is done', () => {
  it('is still the onboarding claim, and the approval no longer burns the code', async () => {
    publishers.describe.mockResolvedValue(identity({ onboarded: false }));
    const result = await resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER');
    expect(result).toMatchObject({ action: 'ONBOARD_PUBLISHER', pendingApproval: true, scanId: 'scan_1' });

    repository.findScanById.mockResolvedValue({ id: 'scan_1', qrId: 'qr_1', scannedById: 'usr_agent', action: 'ONBOARD_PUBLISHER', outcome: 'PENDING_APPROVAL', createdAt: new Date(), ask: null });
    await expect(decideOnboardingScan('scan_1', 'pub_1', 'approve')).resolves.toEqual({ outcome: 'GRANTED', grantId: 'grant_onb' });
    expect(publishers.commitClaim).toHaveBeenCalled();
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('an old ninety-second code is still burnt with the answer', async () => {
    repository.findById.mockResolvedValue(code({ expiresAt: new Date(Date.now() + 60_000) }));
    repository.findScanById.mockResolvedValue({ id: 'scan_1', qrId: 'qr_1', scannedById: 'usr_agent', action: 'ONBOARD_PUBLISHER', outcome: 'PENDING_APPROVAL', createdAt: new Date(), ask: null });
    publishers.describe.mockResolvedValue(identity({ onboarded: false }));
    await decideOnboardingScan('scan_1', 'pub_1', 'decline');
    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
  });
});

describe('everyone else', () => {
  it('an advertiser scanning a publisher is shown the profile, nothing logged as pending', async () => {
    const result = await resolveQr(token(), 'usr_adv', 'ADVERTISER');
    expect(result).toMatchObject({ action: 'VIEW_PUBLISHER', identity: { name: 'Skyline Outdoor Media', verified: true } });
    expect(repository.logScan).toHaveBeenCalledWith(expect.objectContaining({ action: 'VIEW_PUBLISHER', outcome: 'GRANTED' }));
  });

  it('a publisher scanning an advertiser is shown the advertiser', async () => {
    repository.findById.mockResolvedValue(code({ type: 'ADVERTISER', refId: 'adv_1' }));
    advertisers.describe.mockResolvedValue(identity({ id: 'adv_1', displayId: 'ADV-2109-2601', name: 'Bright Dental', type: 'BUSINESS' }));
    const result = await resolveQr(sign({ id: 'qr_1', type: 'ADVERTISER', refId: 'adv_1', iat: Date.now() }), 'usr_pub', 'PUBLISHER');
    expect(result).toMatchObject({ action: 'VIEW_ADVERTISER', identity: { displayId: 'ADV-2109-2601' } });
  });

  it('the web landing learns who the code belongs to, signed out, without the mobile', async () => {
    const found = await describeIdentityByToken(`https://adx.in/q/${token()}`);
    expect(found).toEqual({
      type: 'PUBLISHER',
      displayId: 'PUB-2109-2601',
      name: 'Skyline Outdoor Media',
      city: 'Bengaluru',
      verified: true,
      appLink: expect.stringMatching(/^adx:\/\/q\//),
    });
    expect(JSON.stringify(found)).not.toContain('+919000000201');
    expect(await describeIdentityByToken('not-a-token')).toBeNull();
    repository.findById.mockResolvedValue(code({ isActive: false }));
    expect(await describeIdentityByToken(token())).toBeNull();
  });
});
