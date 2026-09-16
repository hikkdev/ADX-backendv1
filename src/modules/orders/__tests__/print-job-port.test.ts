import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The print job behind an order — Lot B (B4b), through the port.
 *
 * `orders` never imports `print-partners`; it asks the port for the pickup
 * point when the prints are marked ready and tells it when they are
 * collected. Unregistered, nothing changes: the PICKUP code carries only its
 * purpose, the order read says `printJob: null`, and collect-prints records
 * nothing. A port that throws must never fail the agent's step.
 */

const { repository, notify, listings, assignment, qr } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithPublisher: vi.fn(),
    findDetail: vi.fn(),
    update: vi.fn(),
    addPhotos: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (s: string) => s.slice(0, 6) },
  listings: { setListingAvailability: vi.fn(), getListingWithPublisher: vi.fn() },
  assignment: { autoAssignAgent: vi.fn() },
  qr: {
    generateQr: vi.fn(),
    deactivateQrsFor: vi.fn(),
    findActiveQrFor: vi.fn(),
    assertQrForRef: vi.fn(),
    PICKUP_PURPOSE: 'PICKUP',
  },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../assignment/assignment.service', () => assignment);
vi.mock('../../qr', () => qr);

import { agentCollectPrints, markPrintReady, pickupCode } from '../fulfilment/fulfilment.service';
import { getOrderById } from '../orders.queries';
import { registerPrintJobPort, resetPrintJobPort, type OrderPrintJob } from '../print-job.port';

const NOW = new Date('2026-09-12T10:00:00Z');
const AGENT = 'agt_1';

const pickup = {
  printPartnerId: 'prt_1',
  name: 'Rapid Prints',
  contactName: 'Meena',
  mobile: '+919876543210',
  address: '4 Industrial Estate',
  city: 'Bengaluru',
  latitude: 12.97,
  longitude: 77.59,
};

const job: OrderPrintJob = {
  id: 'job_1',
  status: 'READY',
  quotedCost: '1000.00',
  actualCost: null,
  requestedAt: NOW,
  readyAt: NOW,
  collectedAt: null,
  pickup,
};

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_PRINT',
  agentId: null,
  installBy: 'ADX',
  printReadyAt: null,
  listing: { id: 'lst_1', title: 'Reception mirror', publisher: { id: 'pub_1', userId: 'usr_pub' } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  assignment.autoAssignAgent.mockResolvedValue(undefined);
});

afterEach(() => resetPrintJobPort());

describe('unregistered', () => {
  it('mints the pickup code with only its purpose, and reads no job', async () => {
    repository.findWithPublisher.mockResolvedValue(booking());
    await markPrintReady('ord_1');
    expect(qr.generateQr).toHaveBeenCalledWith('ORDER', 'ord_1', ['AGENT_PUBLISHER'], { purpose: 'PICKUP' });

    repository.findDetail.mockResolvedValue({ id: 'ord_1', agentAssignments: [] });
    expect((await getOrderById('ord_1'))?.printJob).toBeNull();
  });
});

describe('registered', () => {
  const port = { printJobFor: vi.fn(), pickupsFor: vi.fn(async () => new Map()), markCollected: vi.fn() };
  beforeEach(() => {
    port.printJobFor.mockResolvedValue(job);
    port.markCollected.mockResolvedValue(undefined);
    registerPrintJobPort(port);
  });

  it('stamps the partner’s address into the PICKUP code', async () => {
    repository.findWithPublisher.mockResolvedValue(booking());
    await markPrintReady('ord_1');
    expect(port.printJobFor).toHaveBeenCalledWith('ord_1');
    expect(qr.generateQr).toHaveBeenCalledWith('ORDER', 'ord_1', ['AGENT_PUBLISHER'], { purpose: 'PICKUP', pickup });
  });

  it('prints the pickup point with the code — from the stamp, or from the job today', async () => {
    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_pick', metadata: { purpose: 'PICKUP', pickup } });
    expect(await pickupCode('ord_1')).toEqual({ qrId: 'qr_pick', pickup });
    expect(port.printJobFor).not.toHaveBeenCalled();

    qr.findActiveQrFor.mockResolvedValue({ id: 'qr_old', metadata: { purpose: 'PICKUP' } });
    expect(await pickupCode('ord_1')).toEqual({ qrId: 'qr_old', pickup });
    expect(port.printJobFor).toHaveBeenCalledWith('ord_1');
  });

  it('carries the job on the order read', async () => {
    repository.findDetail.mockResolvedValue({ id: 'ord_1', agentAssignments: [] });
    expect((await getOrderById('ord_1'))?.printJob).toEqual(job);
  });

  it('marks the job collected when the agent collects the prints', async () => {
    repository.findById.mockResolvedValue({ id: 'ord_1', status: 'SLOT_CONFIRMED', agentId: AGENT });
    const updated = await agentCollectPrints('ord_1', AGENT);
    expect(updated).toMatchObject({ status: 'IN_PROGRESS' });
    expect(port.markCollected).toHaveBeenCalledWith('ord_1', expect.any(Date));
  });

  it('does not re-mark on the idempotent retry', async () => {
    repository.findById.mockResolvedValue({ id: 'ord_1', status: 'IN_PROGRESS', agentId: AGENT });
    await agentCollectPrints('ord_1', AGENT);
    expect(port.markCollected).not.toHaveBeenCalled();
  });

  it('never fails the agent’s step or the print-ready on a port that throws', async () => {
    port.markCollected.mockRejectedValue(new Error('boom'));
    port.printJobFor.mockRejectedValue(new Error('boom'));
    repository.findById.mockResolvedValue({ id: 'ord_1', status: 'SLOT_CONFIRMED', agentId: AGENT });
    await expect(agentCollectPrints('ord_1', AGENT)).resolves.toMatchObject({ status: 'IN_PROGRESS' });

    repository.findWithPublisher.mockResolvedValue(booking());
    await expect(markPrintReady('ord_1')).resolves.toMatchObject({ status: 'PENDING_AGENT' });
    expect(qr.generateQr).toHaveBeenCalledWith('ORDER', 'ord_1', ['AGENT_PUBLISHER'], { purpose: 'PICKUP' });

    repository.findDetail.mockResolvedValue({ id: 'ord_1', agentAssignments: [] });
    expect((await getOrderById('ord_1'))?.printJob).toBeNull();
  });
});
