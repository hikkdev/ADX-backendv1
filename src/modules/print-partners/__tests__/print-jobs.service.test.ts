import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Print jobs — Lot B (Q50/B4b), owner decision 122.
 *
 * Three rules under test. A job is opened only against an order that has
 * reached PENDING_PRINT, at a partner on the roster, once per order. The
 * ladder runs forward only, and the cost locks once it is approved. And
 * approving the cost is one idempotent movement: wallet +net,
 * `platform:cost-of-sales` −gross, `platform:tax-withheld` +tax under 194C,
 * keyed on the job so a double tap pays once.
 */

const NOW = new Date('2026-09-12T10:00:00Z');

type Row = Record<string, any>;

const { fake, repository, orders, payouts, wallets } = vi.hoisted(() => {
  const fake = { partners: new Map<string, Row>(), jobs: new Map<string, Row> () };
  const withPartner = (job: Row) => ({ ...job, printPartner: fake.partners.get(job.printPartnerId) ?? null });
  const repository = {
    findPartner: vi.fn(async (id: string) => fake.partners.get(id) ?? null),
    findJobByOrder: vi.fn(async (orderId: string) => {
      const job = [...fake.jobs.values()].find((row) => row.orderId === orderId);
      return job ? withPartner(job) : null;
    }),
    findJob: vi.fn(async (id: string) => (fake.jobs.has(id) ? withPartner(fake.jobs.get(id)!) : null)),
    createJob: vi.fn(async (data: Row) => {
      const row = {
        id: `job_${fake.jobs.size + 1}`,
        status: 'REQUESTED',
        quotedCost: null,
        actualCost: null,
        specs: null,
        requestedAt: NOW,
        readyAt: null,
        collectedAt: null,
        costApprovedByUserId: null,
        costApprovedAt: null,
        ledgerTransactionId: null,
        notes: null,
        ...data,
      };
      fake.jobs.set(row.id, row);
      return withPartner(row);
    }),
    updateJob: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.jobs.get(id), ...patch };
      fake.jobs.set(id, next);
      return withPartner(next);
    }),
    findJobsByOrders: vi.fn(async (orderIds: readonly string[]) =>
      [...fake.jobs.values()].filter((row) => orderIds.includes(row.orderId)).map((row) => withPartner(row)),
    ),
    listJobsForPartner: vi.fn(async () => []),
    countJobsForPartner: vi.fn(async () => []),
  };
  return {
    fake,
    repository,
    orders: { getOrderSummary: vi.fn(), registerPrintJobPort: vi.fn() },
    payouts: { withholdingFor: vi.fn(), listWithdrawals: vi.fn(async () => []) },
    wallets: { ensureWallet: vi.fn(), move: vi.fn(), findWalletFor: vi.fn(), listEntries: vi.fn(), snapshot: vi.fn() },
  };
});

vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: repository }));
vi.mock('../../orders', () => orders);
vi.mock('../../payouts', () => payouts);
vi.mock('../../wallets', () => wallets);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m, revokeSessions: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn() }));
vi.mock('../../uploads', () => ({ findUploadedFile: vi.fn() }));

import {
  PRINTABLE_ORDER_STATUSES,
  approvePrintCost,
  markCollected,
  openPrintJob,
  pickupsForOrders,
  printJobFor,
  updatePrintJob,
} from '../print-jobs.service';

const partner = (over: Row = {}) => ({
  id: 'prt_1',
  displayId: 'PRT-1209-2601',
  userId: 'usr_prt_1',
  name: 'Rapid Prints',
  contactName: 'Meena',
  mobile: '+919876543210',
  address: '4 Industrial Estate',
  city: 'Bengaluru',
  latitude: 12.97,
  longitude: 77.59,
  isActive: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.partners.clear();
  fake.jobs.clear();
  fake.partners.set('prt_1', partner());
  orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'PENDING_PRINT', agentId: null, listingId: 'lst_1' });
  payouts.withholdingFor.mockResolvedValue({ taxWithheld: '0.00', ratePct: '0.00', section: '194C' });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_prt_1' });
  wallets.move.mockResolvedValue({ ledgerTransactionId: 'ltx_1', created: true, entry: { id: 'we_1' }, entries: [] });
});

describe('opening a job', () => {
  it('needs an order that has reached the print stage', async () => {
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'PENDING_PUBLISHER' });
    await expect(openPrintJob('ord_1', { printPartnerId: 'prt_1' })).rejects.toMatchObject({ statusCode: 409 });
    orders.getOrderSummary.mockResolvedValue(null);
    await expect(openPrintJob('ord_1', { printPartnerId: 'prt_1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(PRINTABLE_ORDER_STATUSES.has('CANCELLED')).toBe(false);
    expect(PRINTABLE_ORDER_STATUSES.has('SLOT_CONFIRMED')).toBe(true);
  });

  it('needs a partner on the roster', async () => {
    await expect(openPrintJob('ord_1', { printPartnerId: 'prt_missing' })).rejects.toMatchObject({ statusCode: 404 });
    fake.partners.set('prt_1', partner({ isActive: false }));
    await expect(openPrintJob('ord_1', { printPartnerId: 'prt_1' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('opens once per order, with the quote as a decimal', async () => {
    const job = await openPrintJob('ord_1', { printPartnerId: 'prt_1', quotedCost: '1500.50', specs: { size: '10x20' } });
    expect(job.status).toBe('REQUESTED');
    expect(new Decimal(job.quotedCost as never).toFixed(2)).toBe('1500.50');
    expect(repository.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ord_1', printPartnerId: 'prt_1', specs: { size: '10x20' } })
    );
    await expect(openPrintJob('ord_1', { printPartnerId: 'prt_1' })).rejects.toMatchObject({
      statusCode: 409,
      details: { printJobId: job.id },
    });
  });

  it('reopens a cancelled job in place, at the partner named now', async () => {
    const first = await openPrintJob('ord_1', { printPartnerId: 'prt_1', quotedCost: '900.00' });
    await updatePrintJob('ord_1', { status: 'CANCELLED' });
    fake.partners.set('prt_2', partner({ id: 'prt_2', name: 'Other Prints' }));
    const again = await openPrintJob('ord_1', { printPartnerId: 'prt_2' }, NOW);
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('REQUESTED');
    expect(again.printPartnerId).toBe('prt_2');
    expect(again.quotedCost).toBeNull();
    expect(again.requestedAt).toEqual(NOW);
  });

  /* Lot H: the award opens the job on the quote; a reopen is a fresh ask and clears the partner's old moves. */
  it('carries the awarded quote, and a reopen clears the partner’s earlier accept, decline and handover', async () => {
    const first = await openPrintJob('ord_1', { printPartnerId: 'prt_1', quotedCost: '900.00', awardedQuoteId: 'quo_1' });
    expect(first.awardedQuoteId).toBe('quo_1');
    fake.jobs.set(first.id, { ...fake.jobs.get(first.id), status: 'CANCELLED', partnerDeclinedAt: NOW, declineReason: 'Out of flex', partnerAcceptedAt: NOW });
    const again = await openPrintJob('ord_1', { printPartnerId: 'prt_1', quotedCost: '850.00', awardedQuoteId: 'quo_2' }, NOW);
    expect(again).toMatchObject({ awardedQuoteId: 'quo_2', partnerAcceptedAt: null, partnerDeclinedAt: null, declineReason: null, handoverConfirmedAt: null, handoverQrId: null });
  });
});

describe('the ladder', () => {
  beforeEach(async () => {
    await openPrintJob('ord_1', { printPartnerId: 'prt_1' });
  });

  it('runs forward, skipping rungs, and never back', async () => {
    const { after } = await updatePrintJob('ord_1', { status: 'PRINTING' });
    expect(after.status).toBe('PRINTING');
    await expect(updatePrintJob('ord_1', { status: 'ACCEPTED' })).rejects.toMatchObject({ statusCode: 409 });
    const ready = await updatePrintJob('ord_1', { status: 'READY' }, NOW);
    expect(ready.after.readyAt).toEqual(NOW);
  });

  it('is a no-op on the same status, and records the cost and the notes', async () => {
    const same = await updatePrintJob('ord_1', { status: 'REQUESTED' });
    expect(same.after).toBe(same.before);
    expect(repository.updateJob).not.toHaveBeenCalled();
    const { after } = await updatePrintJob('ord_1', { actualCost: '1200.00', notes: 'Two banners' });
    expect(new Decimal(after.actualCost as never).toFixed(2)).toBe('1200.00');
    expect(after.notes).toBe('Two banners');
  });

  it('cancels before the cost is approved, and never after', async () => {
    await updatePrintJob('ord_1', { status: 'READY', actualCost: '1000.00' });
    await approvePrintCost('ord_1', { byUserId: 'adm_1' });
    await expect(updatePrintJob('ord_1', { status: 'CANCELLED' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updatePrintJob('ord_1', { actualCost: '2000.00' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('finishes at COLLECTED, and the port marks it so', async () => {
    await updatePrintJob('ord_1', { status: 'READY' });
    await markCollected('ord_1', NOW);
    const job = await printJobFor('ord_1');
    expect(job?.status).toBe('COLLECTED');
    expect(job?.collectedAt).toEqual(NOW);
    // Idempotent, and a cancelled job stays cancelled.
    await markCollected('ord_1', NOW);
    await expect(updatePrintJob('ord_1', { status: 'CANCELLED' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('gives orders the pickup point', async () => {
    const job = await printJobFor('ord_1');
    expect(job?.pickup).toEqual({
      printPartnerId: 'prt_1',
      name: 'Rapid Prints',
      contactName: 'Meena',
      mobile: '+919876543210',
      address: '4 Industrial Estate',
      city: 'Bengaluru',
      latitude: 12.97,
      longitude: 77.59,
    });
    expect(await printJobFor('ord_none')).toBeNull();
  });

  /* E9: the my-orders page reads every row's pickup in one call. */
  it('answers the pickup points of a page of orders in one read, keyed by order, absent where no partner prints', async () => {
    await openPrintJob('ord_2', { printPartnerId: 'prt_1' });
    const pickups = await pickupsForOrders(['ord_1', 'ord_2', 'ord_none']);
    expect(repository.findJobsByOrders).toHaveBeenCalledTimes(1);
    expect(repository.findJobsByOrders).toHaveBeenCalledWith(['ord_1', 'ord_2', 'ord_none']);
    expect([...pickups.keys()].sort()).toEqual(['ord_1', 'ord_2']);
    expect(pickups.get('ord_1')).toMatchObject({ printPartnerId: 'prt_1', name: 'Rapid Prints', address: '4 Industrial Estate' });
    expect(pickups.has('ord_none')).toBe(false);
    expect((await pickupsForOrders([])).size).toBe(0);
    expect(repository.findJobsByOrders).toHaveBeenCalledTimes(1);
  });
});

describe('approving the cost', () => {
  beforeEach(async () => {
    await openPrintJob('ord_1', { printPartnerId: 'prt_1', quotedCost: '1000.00' });
  });

  it('needs a ready job with an actual cost', async () => {
    await expect(approvePrintCost('ord_1', { byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409 });
    await updatePrintJob('ord_1', { status: 'READY' });
    await expect(approvePrintCost('ord_1', { byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('posts PRINT_COST into the partner wallet against cost of sales, with TDS under 194C', async () => {
    payouts.withholdingFor.mockResolvedValue({ taxWithheld: '24.00', ratePct: '2.00', section: '194C' });
    await updatePrintJob('ord_1', { status: 'READY', actualCost: '1200.00' });
    const approval = await approvePrintCost('ord_1', { byUserId: 'adm_1' }, NOW);

    expect(payouts.withholdingFor).toHaveBeenCalledWith('PARTNER', '1200.00', NOW);
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PRINT_PARTNER', id: 'prt_1' }, 'Rapid Prints · print partner');
    expect(wallets.move).toHaveBeenCalledTimes(1);
    const movement = wallets.move.mock.calls[0]![0];
    expect(movement).toMatchObject({
      walletId: 'wal_prt_1',
      amount: '1176.00',
      entryType: 'EARNING',
      ledgerKind: 'PRINT_COST',
      idempotencyKey: `print-cost:${approval.job.id}`,
      orderId: 'ord_1',
      createdByUserId: 'adm_1',
      occurredAt: NOW,
    });
    expect(movement.counterLegs).toEqual([
      { accountCode: 'platform:cost-of-sales', amount: '-1200.00', note: 'Print cost' },
      { accountCode: 'platform:tax-withheld', amount: '24.00', note: 'TDS 194C @ 2.00% on print cost' },
    ]);
    // The legs balance: net − gross + tax = 0.
    const sum = [movement.amount, ...movement.counterLegs.map((leg: Row) => leg.amount)].reduce(
      (acc, value) => acc.plus(new Decimal(value)),
      new Decimal(0)
    );
    expect(sum.isZero()).toBe(true);

    expect(approval).toMatchObject({ gross: '1200.00', taxWithheld: '24.00', net: '1176.00', taxSection: '194C', created: true });
    expect(approval.job.costApprovedAt).toEqual(NOW);
    expect(approval.job.costApprovedByUserId).toBe('adm_1');
    expect(approval.job.ledgerTransactionId).toBe('ltx_1');
  });

  it('posts no tax leg at a zero rate', async () => {
    await updatePrintJob('ord_1', { status: 'READY', actualCost: '500.00' });
    await approvePrintCost('ord_1', { byUserId: 'adm_1' });
    const movement = wallets.move.mock.calls[0]![0];
    expect(movement.amount).toBe('500.00');
    expect(movement.counterLegs).toEqual([{ accountCode: 'platform:cost-of-sales', amount: '-500.00', note: 'Print cost' }]);
  });

  it('is idempotent — a second approval returns the first movement and stamps nothing new', async () => {
    await updatePrintJob('ord_1', { status: 'READY', actualCost: '500.00' });
    const first = await approvePrintCost('ord_1', { byUserId: 'adm_1' }, NOW);
    wallets.move.mockResolvedValue({ ledgerTransactionId: 'ltx_1', created: false, entry: null, entries: [] });
    const updates = repository.updateJob.mock.calls.length;
    const second = await approvePrintCost('ord_1', { byUserId: 'adm_2' }, new Date('2026-09-13T10:00:00Z'));
    expect(second.created).toBe(false);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);
    expect(second.job.costApprovedByUserId).toBe('adm_1');
    expect(second.job.costApprovedAt).toEqual(NOW);
    expect(repository.updateJob.mock.calls.length).toBe(updates);
    expect(wallets.move.mock.calls[1]![0].idempotencyKey).toBe(wallets.move.mock.calls[0]![0].idempotencyKey);
  });

  it('still pays a partner taken off the roster since — the work was done', async () => {
    await updatePrintJob('ord_1', { status: 'COLLECTED', actualCost: '500.00' });
    fake.partners.set('prt_1', partner({ isActive: false }));
    const approval = await approvePrintCost('ord_1', { byUserId: 'adm_1' });
    expect(approval.created).toBe(true);
  });
});
