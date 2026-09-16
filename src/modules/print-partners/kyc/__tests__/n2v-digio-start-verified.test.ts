import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2 verifier — the partner's own Digio start (`POST
 * /print-partners/me/kyc/digio`) on a VERIFIED record is 409
 * `KYC_ALREADY_VERIFIED` before Digio is asked, like every other submit
 * path (N2-B); the desk's restart already refused it.
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio } = vi.hoisted(() => ({
  repository: { upsertDigio: vi.fn<AnyFn>(), findByPartnerId: vi.fn<AnyFn>(), findByDigioRequestId: vi.fn<AnyFn>(), applyDigioWebhook: vi.fn<AnyFn>() },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
}));

vi.mock('../prisma-print-partner-kyc.repository', () => ({ prismaPrintPartnerKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));
vi.mock('../../../../shared/audit', () => ({ logActivity: vi.fn() }));
vi.mock('../../../../shared/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { initiatePrintPartnerDigioKyc } from '../print-partner-digio.service';

const partner = { id: 'prt_1', name: 'Sharma Prints', email: 'shop@example.in', mobile: '+919999999999' };

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_1?token=tok', mock: false });
  repository.upsertDigio.mockResolvedValue({ id: 'ppk_1' });
});

describe('starting Digio on a verified partner', () => {
  it('is 409 KYC_ALREADY_VERIFIED before Digio is asked or the row touched', async () => {
    repository.findByPartnerId.mockResolvedValue({ id: 'ppk_1', printPartnerId: 'prt_1', status: 'VERIFIED', method: 'MANUAL' });
    await expect(initiatePrintPartnerDigioKyc(partner)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.upsertDigio).not.toHaveBeenCalled();
  });

  it('still opens a session with no row, or a row that is not verified', async () => {
    repository.findByPartnerId.mockResolvedValue(null);
    await expect(initiatePrintPartnerDigioKyc(partner)).resolves.toMatchObject({ kycId: 'dg_1' });
    repository.findByPartnerId.mockResolvedValue({ id: 'ppk_1', printPartnerId: 'prt_1', status: 'NEEDS_INFO', method: 'MANUAL' });
    await expect(initiatePrintPartnerDigioKyc(partner)).resolves.toMatchObject({ kycId: 'dg_1' });
    expect(repository.upsertDigio).toHaveBeenCalledTimes(2);
  });
});
