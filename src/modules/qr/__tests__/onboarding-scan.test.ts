import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The door-to-door code, controlled.
 *
 * A scan used to burn the code and claim the publisher in one step, and only
 * successful scans were ever written down. Now: a code dies on its own at
 * ninety seconds; every attempt is a row with an outcome, refusals included;
 * a scan claims nothing until the person whose code it is approves it from
 * their own phone; approval burns the code and opens the authority; and the
 * distance between where the code was made and where it was scanned is
 * recorded, not enforced.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    createPlaceholder: vi.fn(),
    setToken: vi.fn(),
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

import { registerPublisherOnboardingPort } from '../qr.ports';
import { sign } from '../qr.token';
import {
  APPROVAL_WINDOW_SECONDS,
  decideOnboardingScan,
  distanceMetres,
  getScanForScanner,
  resolveQr,
} from '../qr.service';

const port = { prepareClaim: vi.fn(), commitClaim: vi.fn() };
registerPublisherOnboardingPort(port);

const BENGALURU = { latitude: 12.9716, longitude: 77.5946 };

const code = (over: Record<string, unknown> = {}) => ({
  id: 'qr_1',
  type: 'PUBLISHER',
  refId: 'pub_1',
  allowedRoles: ['AGENT_PUBLISHER'],
  metadata: null,
  isActive: true,
  expiresAt: new Date(Date.now() + 60_000),
  latitude: BENGALURU.latitude,
  longitude: BENGALURU.longitude,
  token: 't',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const token = () => sign({ id: 'qr_1', type: 'PUBLISHER', refId: 'pub_1', iat: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(code());
  repository.logScan.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'scan_1', createdAt: new Date(), ...data }));
  repository.updateScan.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  repository.deactivate.mockResolvedValue({});
  port.prepareClaim.mockResolvedValue({
    publisher: { id: 'pub_1', name: 'Asha Rao', mobile: '+919876543210', type: 'INDIVIDUAL' },
    agentId: 'agt_1',
  });
  port.commitClaim.mockResolvedValue({ grantId: 'grant_1' });
});

const scanned = () => repository.logScan.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);

describe('a scan is refused, and the refusal is written down', () => {
  it('when the code has died', async () => {
    repository.findById.mockResolvedValue(code({ expiresAt: new Date(Date.now() - 1) }));
    await expect(resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER')).rejects.toThrow('QR_EXPIRED');
    expect(scanned()).toEqual(['EXPIRED']);
    expect(repository.deactivate).not.toHaveBeenCalled();
    expect(port.commitClaim).not.toHaveBeenCalled();
  });

  it('when the code has been used', async () => {
    repository.findById.mockResolvedValue(code({ isActive: false }));
    await expect(resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER')).rejects.toThrow('QR_ALREADY_USED');
    expect(scanned()).toEqual(['ALREADY_USED']);
  });

  it('when the scanner is not an agent', async () => {
    port.prepareClaim.mockRejectedValue(new Error('QR_ACCESS_DENIED'));
    await expect(resolveQr(token(), 'usr_nobody', 'AGENT_PUBLISHER')).rejects.toThrow('QR_ACCESS_DENIED');
    expect(scanned()).toEqual(['NOT_AN_AGENT']);
  });

  it('when the role may not act on it at all', async () => {
    await expect(resolveQr(token(), 'usr_adv', 'AGENT_ADVERTISER')).rejects.toThrow('QR_ACCESS_DENIED');
    expect(scanned()).toEqual(['NOT_AN_AGENT']);
    expect(port.prepareClaim).not.toHaveBeenCalled();
  });
});

describe('a good scan waits for the owner', () => {
  it('logs PENDING_APPROVAL with the distance, and claims nothing', async () => {
    const nearby = { latitude: 12.9725, longitude: 77.5946 }; // ~100 m north
    const result = await resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER', nearby);

    expect(result).toMatchObject({
      action: 'ONBOARD_PUBLISHER',
      pendingApproval: true,
      scanId: 'scan_1',
      publisher: { id: 'pub_1', name: 'Asha Rao' },
    });
    expect(result.distanceM).toBeGreaterThan(90);
    expect(result.distanceM).toBeLessThan(110);
    expect(repository.logScan).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PENDING_APPROVAL', scannedById: 'usr_agent', latitude: nearby.latitude }),
    );
    expect(repository.deactivate).not.toHaveBeenCalled();
    expect(port.commitClaim).not.toHaveBeenCalled();
  });

  it('has no distance when either fix is missing', async () => {
    const result = await resolveQr(token(), 'usr_agent', 'AGENT_PUBLISHER');
    expect(result.distanceM).toBeNull();
  });
});

describe('the owner decides', () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'scan_1',
    qrId: 'qr_1',
    scannedById: 'usr_agent',
    outcome: 'PENDING_APPROVAL',
    createdAt: new Date(),
    decidedAt: null,
    grantId: null,
    distanceM: 100,
    ...over,
  });

  it('approving burns the code, claims, opens the authority and records it on the scan', async () => {
    repository.findScanById.mockResolvedValue(pending());
    const result = await decideOnboardingScan('scan_1', 'pub_1', 'approve');

    expect(port.prepareClaim).toHaveBeenCalledWith('pub_1', 'usr_agent');
    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
    expect(port.commitClaim).toHaveBeenCalledWith('pub_1', 'agt_1', { qrId: 'qr_1', scanId: 'scan_1' });
    expect(repository.updateScan).toHaveBeenCalledWith('scan_1', expect.objectContaining({ outcome: 'GRANTED', grantId: 'grant_1' }));
    expect(result).toEqual({ outcome: 'GRANTED', grantId: 'grant_1' });
  });

  it('declining burns the code and claims nothing', async () => {
    repository.findScanById.mockResolvedValue(pending());
    const result = await decideOnboardingScan('scan_1', 'pub_1', 'decline');
    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
    expect(port.commitClaim).not.toHaveBeenCalled();
    expect(repository.updateScan).toHaveBeenCalledWith('scan_1', expect.objectContaining({ outcome: 'USER_DECLINED' }));
    expect(result).toEqual({ outcome: 'USER_DECLINED', grantId: null });
  });

  it('is too late after the approval window, and the code dies with it', async () => {
    repository.findScanById.mockResolvedValue(
      pending({ createdAt: new Date(Date.now() - (APPROVAL_WINDOW_SECONDS + 1) * 1000) }),
    );
    await expect(decideOnboardingScan('scan_1', 'pub_1', 'approve')).rejects.toThrow('QR_EXPIRED');
    expect(repository.updateScan).toHaveBeenCalledWith('scan_1', expect.objectContaining({ outcome: 'EXPIRED' }));
    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
    expect(port.commitClaim).not.toHaveBeenCalled();
  });

  it('is nobody else\'s code to decide, and nothing to decide twice', async () => {
    repository.findScanById.mockResolvedValue(pending());
    await expect(decideOnboardingScan('scan_1', 'pub_other', 'approve')).rejects.toThrow('QR_NOT_FOUND');
    repository.findScanById.mockResolvedValue(pending({ outcome: 'GRANTED' }));
    await expect(decideOnboardingScan('scan_1', 'pub_1', 'approve')).rejects.toThrow('QR_NOT_PENDING');
  });
});

describe('the agent polls their own scan', () => {
  it('and only their own', async () => {
    repository.findScanById.mockResolvedValue({
      id: 'scan_1',
      qrId: 'qr_1',
      scannedById: 'usr_agent',
      outcome: 'GRANTED',
      decidedAt: new Date(),
      grantId: 'grant_1',
      distanceM: 100,
      createdAt: new Date(),
    });
    await expect(getScanForScanner('scan_1', 'usr_agent')).resolves.toMatchObject({ outcome: 'GRANTED', grantId: 'grant_1' });
    await expect(getScanForScanner('scan_1', 'usr_other')).rejects.toThrow('QR_NOT_FOUND');
  });
});

describe('distanceMetres', () => {
  it('is zero for the same point and about 111 km per degree of latitude', () => {
    expect(distanceMetres(BENGALURU, BENGALURU)).toBe(0);
    const north = { latitude: BENGALURU.latitude + 1, longitude: BENGALURU.longitude };
    expect(distanceMetres(BENGALURU, north)).toBeGreaterThan(110_000);
    expect(distanceMetres(BENGALURU, north)).toBeLessThan(112_000);
  });
});
