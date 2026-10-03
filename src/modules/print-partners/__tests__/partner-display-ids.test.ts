import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — the print partner's own floor names its bookings the way the
 * partner is told them (`BKG-…`): `order.displayId` on `/me/jobs` and
 * `/me/jobs/:id`, `orderDisplayId` on the quote requests; `?orderId=` finds
 * the job behind an ORDER notice; and `appliedAt` is on the partner shape
 * (the app's application screen checks it and it was never sent).
 */

type AnyFn = (...args: any[]) => any;

const { service, kyc, floor, quotes, repository } = vi.hoisted(() => ({
  service: {
    getPartnerForUser: vi.fn<AnyFn>(),
    partnerProfile: vi.fn<AnyFn>(),
    rateCardStateOf: vi.fn<AnyFn>(() => ({ hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] })),
    withLastLogin: vi.fn<AnyFn>(async (rows: unknown[]) => rows),
  },
  kyc: { withKycSummary: vi.fn<AnyFn>(async (rows: unknown[]) => rows) },
  floor: { listPartnerJobs: vi.fn<AnyFn>(), partnerJobDetail: vi.fn<AnyFn>() },
  quotes: {
    getQuoteRequestForPartner: vi.fn<AnyFn>(),
    listQuoteRequestsForPartner: vi.fn<AnyFn>(),
    envelopeOf: vi.fn<AnyFn>(() => ({ specs: {}, invitedPartnerIds: [], inviteMode: 'AUTO', reinvitedAt: null, cancelReason: null, cancelledAt: null })),
    rankQuotes: vi.fn<AnyFn>(() => []),
  },
  repository: { orderDisplayIds: vi.fn<AnyFn>() },
}));

vi.mock('../print-partners.service', () => service);
vi.mock('../kyc/print-partner-kyc.service', () => kyc);
vi.mock('../print-jobs.service', () => ({}));
vi.mock('../print-quotes.service', () => quotes);
vi.mock('../print-floor.service', () => floor);
vi.mock('../print-partners.notify', () => ({}));
vi.mock('../service-agreement', () => ({ serviceAgreementFor: vi.fn(async () => null) }));
vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: repository }));
vi.mock('../../payouts', () => ({ addMethodSchema: {}, shapeMethod: vi.fn(), shapeWithdrawal: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ auditDiff: vi.fn(), logActivity: vi.fn() }));

import { myJobHandler, myJobsHandler, myProfileHandler, myQuoteRequestHandler, myQuoteRequestsHandler, shapePartner } from '../print-partners.controller';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const partner = { id: 'prt_1', userId: 'usr_prt', name: 'Sharma Prints', kycStatus: 'PENDING', maxWidthFt: null, appliedAt: NOW, activatedAt: null, createdAt: NOW, updatedAt: NOW } as never;
const job = { id: 'job_1', orderId: 'ord_1', printPartnerId: 'prt_1', status: 'REQUESTED', quotedCost: null, actualCost: null };
const order = { id: 'ord_1', displayId: 'BKG-2609-0001', status: 'PRINT_PENDING', campaignName: 'Diwali', designUrl: null, startDate: null, endDate: null, listing: { id: 'lst_1' }, agent: null, creative: null };
const request = { id: 'pqr_1', orderId: 'ord_1', specs: {}, city: 'Pune', deadlineAt: NOW, status: 'OPEN', quotes: [], awardedQuoteId: null, createdAt: NOW };

const call = async (handler: AnyFn, req: Record<string, unknown>) => {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  await handler({ user: { sub: 'usr_prt' }, query: {}, params: {}, ...req }, res);
  return res.json.mock.calls[0]?.[0].data;
};

beforeEach(() => {
  vi.clearAllMocks();
  service.getPartnerForUser.mockResolvedValue(partner);
  floor.listPartnerJobs.mockResolvedValue({ items: [{ job, order }], total: 1, page: 1, pageSize: 20, counts: {} });
  floor.partnerJobDetail.mockResolvedValue({ job, order });
  quotes.getQuoteRequestForPartner.mockResolvedValue(request);
  quotes.listQuoteRequestsForPartner.mockResolvedValue({ items: [request], total: 1, page: 1, pageSize: 20, counts: {} });
  repository.orderDisplayIds.mockResolvedValue(new Map([['ord_1', 'BKG-2609-0001']]));
});

describe('the booking id on the partner floor', () => {
  it('GET /me/jobs and /me/jobs/:id carry order.displayId', async () => {
    const page = await call(myJobsHandler, {});
    expect(page.items[0].order).toMatchObject({ id: 'ord_1', displayId: 'BKG-2609-0001' });
    const one = await call(myJobHandler, { params: { jobId: 'job_1' } });
    expect(one.order).toMatchObject({ displayId: 'BKG-2609-0001' });
  });

  it('GET /me/jobs?orderId= finds the job behind an ORDER notice', async () => {
    await call(myJobsHandler, { query: { orderId: 'ord_1' } });
    expect(floor.listPartnerJobs).toHaveBeenCalledWith(partner, expect.objectContaining({ orderId: 'ord_1' }));
    await call(myJobsHandler, { query: {} });
    expect(floor.listPartnerJobs.mock.calls[1]?.[1]).not.toHaveProperty('orderId');
  });

  it('the quote requests carry orderDisplayId', async () => {
    const page = await call(myQuoteRequestsHandler, {});
    expect(page.items[0]).toMatchObject({ orderId: 'ord_1', orderDisplayId: 'BKG-2609-0001' });
    const one = await call(myQuoteRequestHandler, { params: { requestId: 'pqr_1' } });
    expect(one).toMatchObject({ orderDisplayId: 'BKG-2609-0001' });
    repository.orderDisplayIds.mockResolvedValue(new Map());
    expect(await call(myQuoteRequestHandler, { params: { requestId: 'pqr_1' } })).toMatchObject({ orderDisplayId: null });
  });
});

describe('appliedAt on the partner shape', () => {
  it('is answered — the date the shop applied, null for a desk-created partner', async () => {
    expect(shapePartner(partner)).toMatchObject({ appliedAt: NOW });
    expect(shapePartner({ ...(partner as object), appliedAt: null } as never)).toMatchObject({ appliedAt: null });
    service.partnerProfile.mockResolvedValue({ partner, walletId: 'wal_1', balances: {}, rateCard: {} });
    expect(await call(myProfileHandler, {})).toMatchObject({ appliedAt: NOW });
  });
});
