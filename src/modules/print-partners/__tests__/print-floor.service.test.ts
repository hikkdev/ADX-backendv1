import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner's own jobs — Lot H (Q147).
 *
 * Lot B's ladder walked from the shop floor: accept, decline with a reason
 * (ops told, the request reopened), printing, ready (the agent told), and
 * the handover — the partner scanning the agent's pickup code, the job
 * going COLLECTED with the scan on it, idempotent with the agent's own
 * collect-prints. Forward only, one rung at a time, and only the partner's
 * own jobs: anyone else's read as missing.
 */

type Row = Record<string, any>;

const NOW = new Date('2026-09-14T09:00:00Z');

const { fake, repository, orders, notifications, qr, quotes } = vi.hoisted(() => {
  const fake = { jobs: new Map<string, Row>() };
  const partnerRow = { id: 'prt_1', name: 'Rapid Prints', contactName: 'Meena', mobile: '+919876543210', address: '4 Industrial Estate', city: 'Bengaluru', latitude: 12.97, longitude: 77.59 };
  const withPartner = (job: Row) => ({ ...job, printPartner: partnerRow });
  const repository = {
    findJob: vi.fn(async (id: string) => (fake.jobs.has(id) ? withPartner(fake.jobs.get(id)!) : null)),
    updateJob: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.jobs.get(id), ...patch };
      fake.jobs.set(id, next);
      return withPartner(next);
    }),
    listPartnerJobs: vi.fn(async () => ({ items: [...fake.jobs.values()], total: fake.jobs.size, counts: { REQUESTED: 1 } })),
    findOrdersForPrint: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, status: 'SLOT_CONFIRMED', listing: { id: 'lst_1' }, agent: null, creative: null }))),
    findOrderForPrint: vi.fn(async (id: string) => ({
      id,
      status: 'SLOT_CONFIRMED',
      campaignName: 'Diwali',
      designUrl: null,
      startDate: null,
      endDate: null,
      listing: { id: 'lst_1', title: 'Mall wall', address: '1 MG Road', city: 'Bengaluru', latitude: 12.97, longitude: 77.59, size: '10x20' },
      agent: { id: 'agt_1', userId: 'usr_agent', name: 'Ravi', mobile: '+919999999999' },
      creative: { fileUrl: 'https://cdn/x.png', fileName: 'x.png', mimeType: 'image/png', widthPx: 3000, heightPx: 6000 },
    })),
  };
  return {
    fake,
    repository,
    orders: { getOrderSummary: vi.fn(), registerPrintJobPort: vi.fn(), notifyAdmins: vi.fn(async () => []), shortId: (id: string) => id.slice(-6).toUpperCase() },
    notifications: { notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) },
    qr: { confirmPickupHandover: vi.fn(async () => ({ qrId: 'qr_pick' })) },
    quotes: { reopenRequestAfterDecline: vi.fn(async () => null) },
  };
});

vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: repository }));
vi.mock('../../orders', () => orders);
vi.mock('../../notifications', () => notifications);
vi.mock('../../qr', () => qr);
vi.mock('../print-quotes.service', () => quotes);

import { acceptJob, declineJob, getPartnerJob, handoverJob, listPartnerJobs, markPrinting, markReady, partnerJobDetail } from '../print-floor.service';

const partner = { id: 'prt_1', userId: 'usr_prt_1', name: 'Rapid Prints', address: '4 Industrial Estate' } as never;
const other = { id: 'prt_2', userId: 'usr_prt_2', name: 'Other', address: null } as never;

const job = (over: Row = {}): Row => ({
  id: 'job_1',
  orderId: 'ord_1',
  printPartnerId: 'prt_1',
  status: 'REQUESTED',
  quotedCost: null,
  actualCost: null,
  specs: { size: '10x20' },
  requestedAt: NOW,
  readyAt: null,
  collectedAt: null,
  costApprovedAt: null,
  partnerAcceptedAt: null,
  partnerDeclinedAt: null,
  declineReason: null,
  awardedQuoteId: null,
  handoverConfirmedAt: null,
  handoverQrId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.jobs.clear();
  fake.jobs.set('job_1', job());
});

describe('reading the floor', () => {
  it('shows only the partner’s own jobs — anyone else’s read as missing', async () => {
    await expect(getPartnerJob(partner, 'job_1')).resolves.toMatchObject({ id: 'job_1' });
    await expect(getPartnerJob(other, 'job_1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPartnerJob(partner, 'job_missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists a page with the order beside each job, and the chip counts', async () => {
    const page = await listPartnerJobs(partner, { page: 1, pageSize: 20, status: ['REQUESTED'] });
    expect(repository.listPartnerJobs).toHaveBeenCalledWith('prt_1', { page: 1, pageSize: 20, status: ['REQUESTED'] });
    expect(page.items[0]).toMatchObject({ job: { id: 'job_1' }, order: { id: 'ord_1' } });
    expect(page.counts).toEqual({ REQUESTED: 1 });
  });

  it('the job page carries the artwork, the site, the agent who collects and the quoted cost', async () => {
    const { job: row, order } = await partnerJobDetail(partner, 'job_1');
    expect(row.id).toBe('job_1');
    expect(order).toMatchObject({ creative: { fileUrl: 'https://cdn/x.png' }, listing: { size: '10x20' }, agent: { name: 'Ravi' } });
  });
});

describe('the ladder from the floor', () => {
  it('accepts once, stamps the moment, and answers the same again', async () => {
    const first = await acceptJob(partner, 'job_1', NOW);
    expect(first.after).toMatchObject({ status: 'ACCEPTED', partnerAcceptedAt: NOW });
    const again = await acceptJob(partner, 'job_1', NOW);
    expect(again.after).toBe(again.before);
  });

  it('walks one rung at a time — printing needs the accept, ready needs the accept, nothing goes back', async () => {
    await expect(markPrinting(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
    await expect(markReady(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
    await acceptJob(partner, 'job_1', NOW);
    await markPrinting(partner, 'job_1');
    expect(fake.jobs.get('job_1')?.status).toBe('PRINTING');
    await expect(acceptJob(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
    const ready = await markReady(partner, 'job_1', NOW);
    expect(ready.after).toMatchObject({ status: 'READY', readyAt: NOW });
    await expect(markPrinting(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a cancelled or collected job moves no more', async () => {
    fake.jobs.set('job_1', job({ status: 'CANCELLED' }));
    await expect(acceptJob(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
    fake.jobs.set('job_1', job({ status: 'COLLECTED' }));
    await expect(markReady(partner, 'job_1')).rejects.toMatchObject({ statusCode: 409 });
    await expect(declineJob(partner, 'job_1', 'too late')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('READY tells the agent who collects and ops', async () => {
    await acceptJob(partner, 'job_1', NOW);
    await markReady(partner, 'job_1', NOW);
    expect(notifications.notify).toHaveBeenCalledWith(
      'PRINT_JOB_READY',
      'usr_agent',
      { orderRef: 'ORD_1', partnerName: 'Rapid Prints', address: '4 Industrial Estate' },
      expect.objectContaining({ inApp: expect.objectContaining({ relatedId: 'ord_1', relatedType: 'ORDER' }) }),
    );
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Prints ready for pickup', expect.stringContaining('Rapid Prints'), 'ord_1');
  });

  it('READY with no agent on the order yet tells ops alone', async () => {
    repository.findOrderForPrint.mockResolvedValueOnce({ id: 'ord_1', agent: null } as never);
    await acceptJob(partner, 'job_1', NOW);
    await markReady(partner, 'job_1', NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(orders.notifyAdmins).toHaveBeenCalledTimes(1);
  });
});

describe('declining', () => {
  it('cancels with the reason, tells ops, and reopens the request the job came from', async () => {
    fake.jobs.set('job_1', job({ awardedQuoteId: 'quo_1' }));
    quotes.reopenRequestAfterDecline.mockResolvedValueOnce({ id: 'req_1' } as never);
    const result = await declineJob(partner, 'job_1', 'Out of flex this week', NOW);
    expect(result.after).toMatchObject({ status: 'CANCELLED', partnerDeclinedAt: NOW, declineReason: 'Out of flex this week' });
    expect(quotes.reopenRequestAfterDecline).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord_1', awardedQuoteId: 'quo_1', printPartnerId: 'prt_1' }), NOW);
    expect(result.reopenedRequestId).toBe('req_1');
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Print job declined', expect.stringContaining('Out of flex this week'), 'ord_1');
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Print job declined', expect.stringContaining('open again'), 'ord_1');
  });

  it('is allowed until printing starts, not after', async () => {
    await acceptJob(partner, 'job_1', NOW);
    await markPrinting(partner, 'job_1');
    await expect(declineJob(partner, 'job_1', 'changed my mind')).rejects.toMatchObject({ statusCode: 409 });
    expect(orders.notifyAdmins).not.toHaveBeenCalled();
  });
});

describe('the handover', () => {
  it('scans the agent’s pickup code and lands the job at COLLECTED with the scan on it', async () => {
    fake.jobs.set('job_1', job({ status: 'READY', readyAt: NOW }));
    const result = await handoverJob(partner, 'job_1', 'signed.token', NOW);
    expect(qr.confirmPickupHandover).toHaveBeenCalledWith('signed.token', 'ord_1', 'usr_prt_1');
    expect(result.after).toMatchObject({ status: 'COLLECTED', collectedAt: NOW, handoverConfirmedAt: NOW, handoverQrId: 'qr_pick' });
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Material handed over', expect.any(String), 'ord_1');
  });

  it('is idempotent with the agent’s collect-prints: a job already COLLECTED takes the scan and moves nothing', async () => {
    fake.jobs.set('job_1', job({ status: 'COLLECTED', readyAt: NOW, collectedAt: NOW }));
    const first = await handoverJob(partner, 'job_1', 'signed.token', new Date(NOW.getTime() + 1000));
    expect(first.after).toMatchObject({ status: 'COLLECTED', collectedAt: NOW, handoverQrId: 'qr_pick' });
    expect(repository.updateJob).toHaveBeenCalledWith('job_1', { handoverConfirmedAt: expect.any(Date), handoverQrId: 'qr_pick' });
    const again = await handoverJob(partner, 'job_1', 'signed.token', new Date(NOW.getTime() + 2000));
    expect(again.after).toBe(again.before);
    expect(repository.updateJob).toHaveBeenCalledTimes(1);
    // G13-B: the handover already on record answers before the code is scanned again — one scan logged, not two.
    expect(qr.confirmPickupHandover).toHaveBeenCalledTimes(1);
  });

  it('G13-B: a job whose handover is on record is answered without scanning the code again', async () => {
    fake.jobs.set('job_1', job({ status: 'COLLECTED', readyAt: NOW, collectedAt: NOW, handoverConfirmedAt: NOW, handoverQrId: 'qr_first' }));
    const result = await handoverJob(partner, 'job_1', 'signed.token', new Date(NOW.getTime() + 5000));
    expect(result.after).toBe(result.before);
    expect(qr.confirmPickupHandover).not.toHaveBeenCalled();
    expect(repository.updateJob).not.toHaveBeenCalled();
    expect(orders.notifyAdmins).not.toHaveBeenCalled();
  });

  it('refuses a job that is not ready, a code that is not this order’s, and a string that is not a code', async () => {
    await expect(handoverJob(partner, 'job_1', 'signed.token')).rejects.toMatchObject({ statusCode: 409 });
    fake.jobs.set('job_1', job({ status: 'READY', readyAt: NOW }));
    qr.confirmPickupHandover.mockRejectedValueOnce(new Error('QR_MISMATCH'));
    await expect(handoverJob(partner, 'job_1', 'other.order')).rejects.toMatchObject({ statusCode: 409, code: 'PICKUP_CODE_MISMATCH' });
    qr.confirmPickupHandover.mockRejectedValueOnce(new Error('QR_INVALID'));
    await expect(handoverJob(partner, 'job_1', 'garbage')).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QR' });
    expect(fake.jobs.get('job_1')?.status).toBe('READY');
  });
});
