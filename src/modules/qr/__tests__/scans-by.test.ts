import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D6 — every scan one person has made, with what each code was.
 *
 * The owner's log reads scans by the code's subject; ops also need them by
 * the scanner, to see what one agent has been pointing their phone at —
 * refusals included, because a refused scan is the interesting kind.
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
    findScansForSubject: vi.fn(),
    findScansByScanner: vi.fn(),
    findScanById: vi.fn(),
    findPendingScan: vi.fn(),
    updateScan: vi.fn(),
  },
}));

vi.mock('../prisma-qr.repository', () => ({ prismaQrRepository: repository }));

import { listScansBy } from '../qr.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findScansByScanner.mockResolvedValue([
    { id: 'scan_1', outcome: 'NOT_AN_AGENT', qr: { id: 'qr_1', type: 'PUBLISHER', refId: 'pub_1' } },
  ]);
});

describe('listScansBy', () => {
  it('reads the scans by who made them, each with its code', async () => {
    const scans = await listScansBy('usr_agent');
    expect(repository.findScansByScanner).toHaveBeenCalledWith('usr_agent');
    expect(scans[0]).toMatchObject({ outcome: 'NOT_AN_AGENT', qr: { type: 'PUBLISHER', refId: 'pub_1' } });
  });
});
