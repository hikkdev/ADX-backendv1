import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * K-B1 — the QR desk.
 *
 * What is pinned: `GET /qr` answers the list contract with counts per type
 * and names each code's subject through the ref-label port — one batch per
 * kind on the page, never one query per row, and a kind nobody registered
 * (or an id the module no longer has) answers `label: null` rather than
 * failing; `GET /qr/:qrId/scans` is the list contract with the scanner's
 * name; `GET /qr/scans` narrows by outcome and window; regenerate
 * deactivates the code and issues a new token for the same type / ref /
 * roles / metadata / expiry; and the three desk writes are audited.
 */
const { repository, audit } = vi.hoisted(() => ({
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
    findDeskPage: vi.fn(),
    countDeskByType: vi.fn(),
    findScansPage: vi.fn(),
    findScansByScannerFiltered: vi.fn(),
  },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../prisma-qr.repository', () => ({ prismaQrRepository: repository }));
vi.mock('../../../shared/audit', () => audit);

import { listQrCodes, listQrScans, regenerateQr, resolveRefs } from '../qr.service';
import { registerQrRefLabelPort, resetQrRefLabelPort } from '../qr.ports';
import { deactivateQrHandler, generateQrHandler, regenerateQrHandler, scansByHandler } from '../qr.controller';

const NOW = new Date('2026-09-14T10:00:00Z');

const code = (over: Record<string, unknown> = {}) => ({
  id: 'qr_1',
  type: 'PUBLISHER',
  token: 'tok_1',
  allowedRoles: ['AGENT_PUBLISHER'],
  refId: 'pub_1',
  metadata: null,
  isActive: true,
  expiresAt: null,
  latitude: null,
  longitude: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const request = (over: Record<string, unknown> = {}) =>
  ({ params: { qrId: 'qr_1' }, body: {}, query: {}, user: { sub: 'adm_1' }, ip: '127.0.0.1', headers: {}, method: 'POST', ...over }) as never;

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetQrRefLabelPort();
  repository.findById.mockResolvedValue(code());
  repository.deactivate.mockResolvedValue(undefined);
  repository.createPlaceholder.mockImplementation(async (data: Record<string, unknown>) => code({ ...data, id: 'qr_2', token: 'pending' }));
  repository.setToken.mockResolvedValue(undefined);
  repository.findDeskPage.mockResolvedValue({ rows: [], total: 0 });
  repository.countDeskByType.mockResolvedValue([]);
});

afterEach(() => resetQrRefLabelPort());

describe('resolveRefs', () => {
  it('asks each registered kind once for the whole page, and answers null for the rest', async () => {
    const publishers = vi.fn(async (ids: string[]) => ids.filter((id) => id !== 'pub_gone').map((id) => ({ id, label: `Publisher ${id}`, displayId: `PUB-${id}` })));
    const orders = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, label: `Order ${id}`, displayId: null })));
    registerQrRefLabelPort({ PUBLISHER: publishers, ORDER: orders });

    const refs = await resolveRefs([
      { type: 'PUBLISHER', refId: 'pub_1' },
      { type: 'PUBLISHER', refId: 'pub_1' },
      { type: 'PUBLISHER', refId: 'pub_gone' },
      { type: 'ORDER', refId: 'ord_1' },
      { type: 'AD', refId: 'ad_1' },
    ]);

    expect(publishers).toHaveBeenCalledTimes(1);
    expect(publishers).toHaveBeenCalledWith(['pub_1', 'pub_gone']);
    expect(orders).toHaveBeenCalledTimes(1);
    expect(refs.get('PUBLISHER:pub_1')).toEqual({ kind: 'publisher', id: 'pub_1', label: 'Publisher pub_1', displayId: 'PUB-pub_1', href: '/publishers/pub_1' });
    expect(refs.get('ORDER:ord_1')).toEqual({ kind: 'order', id: 'ord_1', label: 'Order ord_1', displayId: null, href: '/orders/ord_1' });
    // The module no longer has it: named, not linked.
    expect(refs.get('PUBLISHER:pub_gone')).toEqual({ kind: 'publisher', id: 'pub_gone', label: null, displayId: null, href: null });
    // Nobody registered AD: the same, never an error.
    expect(refs.get('AD:ad_1')).toEqual({ kind: 'ad', id: 'ad_1', label: null, displayId: null, href: null });
  });
});

describe('GET /qr', () => {
  it('is the list contract with counts per type, each row named and with its image urls', async () => {
    registerQrRefLabelPort({ PUBLISHER: async (ids) => ids.map((id) => ({ id, label: 'Asha Stores', displayId: 'PUB-1' })) });
    repository.findDeskPage.mockResolvedValue({
      rows: [code({ scansCount: 3, lastScanAt: NOW }), code({ id: 'qr_2', type: 'ORDER', refId: 'ord_1', isActive: false, scansCount: 0, lastScanAt: null })],
      total: 2,
    });
    repository.countDeskByType.mockResolvedValue([
      { type: 'PUBLISHER', count: 1 },
      { type: 'ORDER', count: 1 },
    ]);

    const page = await listQrCodes({ page: 1, pageSize: 20, active: undefined, type: undefined, refId: undefined, q: undefined });

    expect(repository.findDeskPage).toHaveBeenCalledWith({ type: undefined, active: undefined, refId: undefined, q: undefined }, { skip: 0, take: 20 });
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(page.counts).toEqual({ SITE: 0, AD: 0, AGENT: 0, ORDER: 1, PUBLISHER: 1, ACCESS_GRANT: 0, ADVERTISER: 0 });
    expect(page.items[0]).toEqual({
      id: 'qr_1',
      type: 'PUBLISHER',
      refId: 'pub_1',
      ref: { kind: 'publisher', id: 'pub_1', label: 'Asha Stores', displayId: 'PUB-1', href: '/publishers/pub_1' },
      isActive: true,
      expiresAt: null,
      scansCount: 3,
      lastScanAt: NOW,
      createdAt: NOW,
      imagePngUrl: expect.stringContaining('/api/v1/qr/qr_1/image.png'),
      imageSvgUrl: expect.stringContaining('/api/v1/qr/qr_1/image.svg'),
    });
    expect(page.items[1]!.ref).toEqual({ kind: 'order', id: 'ord_1', label: null, displayId: null, href: null });
  });

  it('counts the type chips with the type facet removed', async () => {
    await listQrCodes({ page: 2, pageSize: 10, active: true, type: 'ORDER', refId: undefined, q: 'ord' });
    expect(repository.findDeskPage).toHaveBeenCalledWith({ type: 'ORDER', active: true, refId: undefined, q: 'ord' }, { skip: 10, take: 10 });
    expect(repository.countDeskByType).toHaveBeenCalledWith({ active: true, refId: undefined, q: 'ord' });
  });
});

describe('GET /qr/:qrId/scans', () => {
  it('is the list contract, each row with the scanner named', async () => {
    repository.findScansPage.mockResolvedValue({
      rows: [
        { id: 'scan_1', qrId: 'qr_1', scannedById: 'usr_a', scannedBy: { id: 'usr_a', name: 'Ravi', mobile: '+911' }, role: 'AGENT_PUBLISHER', action: 'ONBOARD_PUBLISHER', outcome: 'GRANTED', latitude: null, longitude: null, distanceM: 12, decidedAt: NOW, grantId: 'g_1', createdAt: NOW },
        { id: 'scan_2', qrId: 'qr_1', scannedById: 'usr_b', scannedBy: { id: 'usr_b', name: null, mobile: '+912' }, role: null, action: 'REFUSED', outcome: 'EXPIRED', latitude: null, longitude: null, distanceM: null, decidedAt: null, grantId: null, createdAt: NOW },
      ],
      total: 2,
      counts: { GRANTED: 1, EXPIRED: 1 },
    });
    const page = await listQrScans('qr_1', { page: 1, pageSize: 20, outcome: undefined });
    expect(repository.findScansPage).toHaveBeenCalledWith('qr_1', { outcome: undefined }, { skip: 0, take: 20 });
    expect(page).toMatchObject({ total: 2, counts: { GRANTED: 1, EXPIRED: 1 } });
    expect(page.items[0]).toMatchObject({ id: 'scan_1', scannedBy: { id: 'usr_a', name: 'Ravi' }, outcome: 'GRANTED', distanceM: 12 });
    // No name: the number stands in.
    expect(page.items[1]!.scannedBy).toEqual({ id: 'usr_b', name: '+912', mobile: '+912' });
  });

  it('404s a code that does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(listQrScans('qr_x', { page: 1, pageSize: 20, outcome: undefined })).rejects.toThrow('QR_NOT_FOUND');
  });
});

describe('GET /qr/scans', () => {
  it('takes scannedById (or the D6 spelling), outcome and a window', async () => {
    repository.findScansByScannerFiltered.mockResolvedValue([]);
    const res = response();
    await scansByHandler(request({ method: 'GET', query: { scannedById: 'usr_a', outcome: 'GRANTED', from: '2026-09-01', to: '2026-09-14' } }), res as never);
    expect(repository.findScansByScannerFiltered).toHaveBeenCalledWith({ scannedById: 'usr_a', outcome: 'GRANTED', from: new Date('2026-09-01'), to: new Date('2026-09-14') });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });

    await scansByHandler(request({ method: 'GET', query: { scannedBy: 'usr_b' } }), response() as never);
    expect(repository.findScansByScannerFiltered).toHaveBeenLastCalledWith({ scannedById: 'usr_b', outcome: undefined, from: undefined, to: undefined });

    await expect(scansByHandler(request({ method: 'GET', query: {} }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('POST /qr/:qrId/regenerate', () => {
  it('deactivates the code, then issues a new token for the same type, ref, roles, metadata and expiry', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    repository.findById.mockImplementation(async (id: string) =>
      id === 'qr_1'
        ? code({ metadata: { purpose: 'PICKUP' }, type: 'ORDER', refId: 'ord_1', expiresAt, latitude: 12.9, longitude: 77.6 })
        : code({ id: 'qr_2', type: 'ORDER', refId: 'ord_1', token: 'tok_2' }),
    );
    const { previous, next } = await regenerateQr('qr_1');

    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
    expect(repository.createPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ORDER',
        refId: 'ord_1',
        allowedRoles: ['AGENT_PUBLISHER'],
        metadata: { purpose: 'PICKUP' },
        latitude: 12.9,
        longitude: 77.6,
        expiresAt: expect.any(Date),
      }),
    );
    const placed = repository.createPlaceholder.mock.calls[0]![0] as { expiresAt: Date };
    expect(Math.abs(placed.expiresAt.getTime() - expiresAt.getTime())).toBeLessThan(2_000);
    // The deactivate happens before the new row exists.
    expect(repository.deactivate.mock.invocationCallOrder[0]!).toBeLessThan(repository.createPlaceholder.mock.invocationCallOrder[0]!);
    expect(previous.id).toBe('qr_1');
    expect(next.id).toBe('qr_2');
  });

  it('an already-inactive code is not deactivated again, and a code that does not expire stays that way', async () => {
    repository.findById.mockImplementation(async (id: string) => (id === 'qr_1' ? code({ isActive: false }) : code({ id: 'qr_2' })));
    await regenerateQr('qr_1');
    expect(repository.deactivate).not.toHaveBeenCalled();
    expect(repository.createPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: undefined }));
  });

  it('the handler audits QR_REGENERATED against the admin and answers the new row, 201', async () => {
    repository.findById.mockImplementation(async (id: string) => (id === 'qr_1' ? code() : code({ id: 'qr_2', token: 'tok_2' })));
    const res = response();
    await regenerateQrHandler(request(), res as never);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'QR_REGENERATED',
      expect.objectContaining({ targetType: 'QrCode', targetId: 'qr_2', metadata: expect.objectContaining({ previousQrId: 'qr_1', regeneratedBy: 'adm_1' }) }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'qr_2', token: 'tok_2', previousQrId: 'qr_1', imagePngUrl: expect.any(String) }) });
  });

  it('404s a code that does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(regenerateQrHandler(request(), response() as never)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the audited desk writes', () => {
  it('DELETE takes a reason and audits QR_DEACTIVATED', async () => {
    await expect(deactivateQrHandler(request({ method: 'DELETE', body: {} }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.deactivate).not.toHaveBeenCalled();
    await deactivateQrHandler(request({ method: 'DELETE', body: { reason: 'printed code was lost' } }), response() as never);
    expect(repository.deactivate).toHaveBeenCalledWith('qr_1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'QR_DEACTIVATED',
      expect.objectContaining({ targetType: 'QrCode', targetId: 'qr_1', metadata: expect.objectContaining({ reason: 'printed code was lost', deactivatedBy: 'adm_1' }) }),
    );
  });

  it('POST /qr audits QR_GENERATED', async () => {
    const res = response();
    await generateQrHandler(request({ body: { type: 'agent', refId: 'agt_1', allowedRoles: ['publisher'] } }), res as never);
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'QR_GENERATED', expect.objectContaining({ targetType: 'QrCode', targetId: 'qr_2', metadata: expect.objectContaining({ type: 'AGENT', refId: 'agt_1' }) }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
