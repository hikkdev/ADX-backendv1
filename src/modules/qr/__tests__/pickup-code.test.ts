import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The third code an agent scans — the pickup code on the material package
 * (DR 01 · Scan QR Material Verification, 3424:26910).
 *
 * It is an ORDER code minted when the prints are marked ready, carrying
 * `purpose: PICKUP`, and only a publisher-side agent can act on it. An ORDER
 * code without that purpose is the site check-in it always was. The service
 * also answers the one question the pickup step asks of it: is this code the
 * code for THIS order.
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

import { sign } from '../qr.token';
import { assertQrForRef, confirmPickupHandover, resolveQr } from '../qr.service';

const code = (over: Record<string, unknown> = {}) => ({
  id: 'qr_pick',
  type: 'ORDER',
  refId: 'ord_1',
  allowedRoles: ['AGENT_PUBLISHER'],
  metadata: { purpose: 'PICKUP' },
  isActive: true,
  expiresAt: null,
  latitude: null,
  longitude: null,
  ...over,
});

const token = sign({ id: 'qr_pick', type: 'ORDER', refId: 'ord_1', iat: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(code());
  repository.logScan.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'scan_1', ...data }));
});

describe('resolving a pickup code', () => {
  it('is the material pickup for a publisher-side agent', async () => {
    const result = await resolveQr(token, 'usr_agent', 'AGENT_PUBLISHER');
    expect(result.action).toBe('PICKUP_MATERIAL');
    expect(result.refId).toBe('ord_1');
    expect(repository.logScan).toHaveBeenCalledWith(expect.objectContaining({ qrId: 'qr_pick', outcome: 'GRANTED' }));
  });

  it('refuses anyone else, and writes the refusal down', async () => {
    await expect(resolveQr(token, 'usr_pub', 'PUBLISHER')).rejects.toThrow('QR_ACCESS_DENIED');
    expect(repository.logScan).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'NOT_AN_AGENT' }));
  });

  it('an ORDER code without the purpose is still the site check-in', async () => {
    repository.findById.mockResolvedValue(code({ id: 'qr_site', metadata: null, allowedRoles: [] }));
    const siteToken = sign({ id: 'qr_site', type: 'ORDER', refId: 'ord_1', iat: Date.now() });
    const result = await resolveQr(siteToken, 'usr_agent', 'AGENT_PUBLISHER');
    expect(result.action).toBe('ORDER_CHECKIN');
  });
});

describe('assertQrForRef', () => {
  it('passes for the live code of that order', async () => {
    await expect(assertQrForRef('qr_pick', 'ORDER', 'ord_1')).resolves.toBeUndefined();
  });

  it('refuses another order, a dead code, and a code that is not there', async () => {
    await expect(assertQrForRef('qr_pick', 'ORDER', 'ord_2')).rejects.toThrow('QR_MISMATCH');
    repository.findById.mockResolvedValue(code({ isActive: false }));
    await expect(assertQrForRef('qr_pick', 'ORDER', 'ord_1')).rejects.toThrow('QR_MISMATCH');
    repository.findById.mockResolvedValue(null);
    await expect(assertQrForRef('qr_pick', 'ORDER', 'ord_1')).rejects.toThrow('QR_MISMATCH');
  });
});

/**
 * Lot H: the print partner scans the agent's pickup code at the counter. The
 * same code, read from the other side — and written down as a scan.
 */
describe('confirmPickupHandover', () => {
  it('answers the code id for this order\'s live pickup code and logs the scan', async () => {
    await expect(confirmPickupHandover(token, 'ord_1', 'usr_partner')).resolves.toEqual({ qrId: 'qr_pick' });
    expect(repository.logScan).toHaveBeenCalledWith(
      expect.objectContaining({ qrId: 'qr_pick', scannedById: 'usr_partner', role: 'PARTNER', action: 'PICKUP_HANDOVER', outcome: 'GRANTED' }),
    );
  });

  it('refuses another order\'s code, a spent code, and a site code', async () => {
    await expect(confirmPickupHandover(token, 'ord_2', 'usr_partner')).rejects.toThrow('QR_MISMATCH');
    repository.findById.mockResolvedValue(code({ isActive: false }));
    await expect(confirmPickupHandover(token, 'ord_1', 'usr_partner')).rejects.toThrow('QR_MISMATCH');
    repository.findById.mockResolvedValue(code({ metadata: null }));
    await expect(confirmPickupHandover(token, 'ord_1', 'usr_partner')).rejects.toThrow('QR_MISMATCH');
    expect(repository.logScan).not.toHaveBeenCalled();
  });

  it('refuses a string that is not a signed code', async () => {
    await expect(confirmPickupHandover('not.a.code', 'ord_1', 'usr_partner')).rejects.toThrow('QR_INVALID');
  });
});
