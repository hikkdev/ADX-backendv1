import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E7-2 — the order reads the desks and the phones lacked.
 *
 *   GET /orders          ?from&to (a slot in the window or a flight
 *                        overlapping it) and ?advertiserId (through the
 *                        campaign), parsed and passed through whole;
 *   GET /orders/my       each row carries printJob: { pickup: { name,
 *                        address } } | null through the print-job port —
 *                        E9: one `pickupsFor(orderIds)` call for the page;
 *   GET /orders/:id      autoAcceptedAt rides on the row.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findAll: vi.fn(), findDetail: vi.fn(), findForAgent: vi.fn(), findForAdvertiser: vi.fn(), findForPublisherUser: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));

import { getAllOrders, getOrderById, getOrdersForAgent, getOrdersForPublisher } from '../orders.queries';
import { adminOrdersQuerySchema, myOrdersQuerySchema } from '../orders.schema';
import { registerPrintJobPort, resetPrintJobPort, type OrderPrintJob } from '../print-job.port';

const NOW = new Date('2026-09-12T10:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  advertiserId: 'usr_adv',
  listingId: 'lst_1',
  agentId: 'agt_1',
  status: 'PENDING_PRINT',
  quotedFee: new Decimal('450.00'),
  autoAcceptedAt: null,
  ...over,
});

const job: OrderPrintJob = {
  id: 'job_1',
  status: 'READY',
  quotedCost: '1000.00',
  actualCost: null,
  requestedAt: NOW,
  readyAt: NOW,
  collectedAt: null,
  pickup: { printPartnerId: 'prt_1', name: 'Rapid Prints', contactName: 'Meena', mobile: '+919876543210', address: '4 Industrial Estate', city: 'Bengaluru', latitude: null, longitude: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAll.mockResolvedValue({ items: [], total: 0, counts: {} });
  repository.findForAgent.mockResolvedValue({ items: [row(), row({ id: 'ord_2', quotedFee: null })], total: 2, counts: { PENDING_PRINT: 2 } });
  repository.findForPublisherUser.mockResolvedValue({ items: [row()], total: 1, counts: { PENDING_PRINT: 1 } });
  repository.findDetail.mockResolvedValue({ ...row({ autoAcceptedAt: NOW, publisherAcceptedAt: NOW }), agentAssignments: [{ status: 'ACCEPTED', quotedFee: new Decimal('450.00') }] });
});

afterEach(() => resetPrintJobPort());

describe('GET /orders — the window and the advertiser', () => {
  it('parses from/to as dates and advertiserId as a facet, and passes them through whole', async () => {
    const query = adminOrdersQuerySchema.parse({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.000Z', advertiserId: 'adv_1', status: 'IN_PROGRESS' });
    expect(query.from).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(query.to).toEqual(new Date('2026-09-30T23:59:59.000Z'));
    expect(query.advertiserId).toBe('adv_1');
    await getAllOrders(query);
    expect(repository.findAll).toHaveBeenCalledWith(expect.objectContaining({ from: query.from, to: query.to, advertiserId: 'adv_1', status: ['IN_PROGRESS'] }));
  });

  it('takes either bound alone, and refuses a window that ends before it starts or a date that is not one', () => {
    expect(adminOrdersQuerySchema.parse({ from: '2026-09-01' }).to).toBeUndefined();
    expect(adminOrdersQuerySchema.parse({ to: '2026-09-30' }).from).toBeUndefined();
    expect(adminOrdersQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(false);
    expect(adminOrdersQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});

describe('GET /orders/my — the pickup row', () => {
  it('carries the print job pickup through the port on every row, null where no partner prints — one batch call for the page', async () => {
    const port = {
      printJobFor: vi.fn(async () => null),
      pickupsFor: vi.fn(async (orderIds: readonly string[]) => new Map(orderIds.filter((id) => id === 'ord_1').map((id) => [id, job.pickup]))),
      markCollected: vi.fn(),
    };
    registerPrintJobPort(port);
    const page = await getOrdersForAgent('agt_1', myOrdersQuerySchema.parse({ as: 'agent' }));
    // E9: the page's ids go to the port once; the per-row read is not used here.
    expect(port.pickupsFor).toHaveBeenCalledTimes(1);
    expect(port.pickupsFor).toHaveBeenCalledWith(['ord_1', 'ord_2']);
    expect(port.printJobFor).not.toHaveBeenCalled();
    expect(page.items[0]).toMatchObject({ id: 'ord_1', quotedFee: '450.00', printJob: { pickup: { name: 'Rapid Prints', address: '4 Industrial Estate' } } });
    expect(page.items[1]).toMatchObject({ id: 'ord_2', quotedFee: null, printJob: null });
    // The pickup row is the name and the address — not the partner's phone.
    expect(page.items[0]!.printJob).toEqual({ pickup: { name: 'Rapid Prints', address: '4 Industrial Estate' } });
    expect(page.counts).toEqual({ PENDING_PRINT: 2 });
  });

  it('reads null, never a failed page, when the port is unregistered or throws', async () => {
    let page = await getOrdersForPublisher('usr_pub', myOrdersQuerySchema.parse({ as: 'publisher' }));
    expect(page.items[0]!.printJob).toBeNull();

    registerPrintJobPort({ printJobFor: async () => { throw new Error('down'); }, pickupsFor: async () => { throw new Error('down'); }, markCollected: async () => undefined });
    page = await getOrdersForPublisher('usr_pub', myOrdersQuerySchema.parse({ as: 'publisher' }));
    expect(page.items[0]!.printJob).toBeNull();
  });

  it('asks the port nothing for an empty page', async () => {
    repository.findForPublisherUser.mockResolvedValue({ items: [], total: 0, counts: {} });
    const port = { printJobFor: vi.fn(), pickupsFor: vi.fn(), markCollected: vi.fn() };
    registerPrintJobPort(port);
    const page = await getOrdersForPublisher('usr_pub', myOrdersQuerySchema.parse({ as: 'publisher' }));
    expect(page.items).toEqual([]);
    expect(port.pickupsFor).not.toHaveBeenCalled();
  });
});

describe('GET /orders/:id', () => {
  it('carries autoAcceptedAt on the row beside the quote and the print job', async () => {
    const order = await getOrderById('ord_1');
    expect(order).toMatchObject({ id: 'ord_1', autoAcceptedAt: NOW, quotedFee: '450.00', printJob: null });
  });
});
