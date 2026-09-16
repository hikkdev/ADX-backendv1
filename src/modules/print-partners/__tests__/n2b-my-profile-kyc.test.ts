import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2-B — `GET /print-partners/me` runs `withKycSummary`, the way the desk's
 * `GET /print-partners/:id` and the roster do, so the partner's own read
 * carries `kyc { status, submittedAt, method, requestedAt, requestedChannel }
 * | null` beside `kycStatus`. Before this the partner's own page answered
 * `kyc: null` whatever the record said.
 */

type AnyFn = (...args: any[]) => any;

const { service, kyc } = vi.hoisted(() => ({
  service: {
    getPartnerForUser: vi.fn<AnyFn>(),
    partnerProfile: vi.fn<AnyFn>(),
    rateCardStateOf: vi.fn<AnyFn>(() => ({ hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] })),
    withLastLogin: vi.fn<AnyFn>(async (rows: unknown[]) => rows),
  },
  kyc: { withKycSummary: vi.fn<AnyFn>() },
}));

vi.mock('../print-partners.service', () => service);
vi.mock('../kyc/print-partner-kyc.service', () => kyc);
vi.mock('../print-jobs.service', () => ({}));
vi.mock('../print-quotes.service', () => ({}));
vi.mock('../print-floor.service', () => ({}));
vi.mock('../print-partners.notify', () => ({}));
vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: {} }));
vi.mock('../../payouts', () => ({ addMethodSchema: {}, shapeMethod: vi.fn(), shapeWithdrawal: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ auditDiff: vi.fn(), logActivity: vi.fn() }));

import { myProfileHandler } from '../print-partners.controller';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const partner = {
  id: 'prt_1',
  displayId: 'PRT-1409-2601',
  userId: 'usr_prt',
  name: 'Sharma Prints',
  legalName: null,
  gstin: null,
  panNumber: null,
  contactName: null,
  mobile: '+919999999999',
  email: null,
  address: null,
  city: 'Pune',
  latitude: null,
  longitude: null,
  capabilities: [],
  maxWidthFt: null,
  turnaroundDays: null,
  isActive: true,
  notes: null,
  activatedAt: null,
  activatedById: null,
  acceptsQuoteRequests: true,
  invoiceUploadFileId: null,
  kycStatus: 'PENDING',
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  service.getPartnerForUser.mockResolvedValue(partner);
  service.partnerProfile.mockResolvedValue({ partner, walletId: 'wal_prt', balances: { balance: '500.00' }, rateCard: { hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] } });
  kyc.withKycSummary.mockImplementation(async (rows: { id: string }[]) =>
    rows.map((row) => ({ ...row, kyc: { status: 'NEEDS_INFO', submittedAt: NOW, method: 'MANUAL', requestedAt: NOW, requestedChannel: 'MANUAL' } })),
  );
});

describe('GET /print-partners/me', () => {
  it('carries the KYC summary beside the mirror, the wallet and the rate card', async () => {
    const res = { json: vi.fn() };
    await myProfileHandler({ user: { sub: 'usr_prt' } } as never, res as never);
    expect(kyc.withKycSummary).toHaveBeenCalledWith([partner]);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        id: 'prt_1',
        kycStatus: 'PENDING',
        kyc: { status: 'NEEDS_INFO', submittedAt: NOW, method: 'MANUAL', requestedAt: NOW, requestedChannel: 'MANUAL' },
        walletId: 'wal_prt',
        balances: { balance: '500.00' },
      }),
    });
  });

  it('answers kyc null before any record', async () => {
    kyc.withKycSummary.mockImplementation(async (rows: { id: string }[]) => rows.map((row) => ({ ...row, kyc: null })));
    const res = { json: vi.fn() };
    await myProfileHandler({ user: { sub: 'usr_prt' } } as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ kyc: null }) });
  });
});
