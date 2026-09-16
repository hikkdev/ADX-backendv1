import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2 verifier — a Digio start for a VERIFIED publisher (their own
 * `POST /publishers/me/kyc/digio`, the agent's
 * `POST /publishers/:publisherId/kyc/digio/initiate`) is 409
 * `KYC_ALREADY_VERIFIED` before Digio is asked, like every other submit
 * path (N2-B). The guard sits in `initiateDigioKyc` itself so every caller
 * is covered; the desk's request and restart already refused it upstream.
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio } = vi.hoisted(() => ({
  repository: { upsertDigioKyc: vi.fn<AnyFn>(), findByRequestId: vi.fn<AnyFn>(), findByPublisherId: vi.fn<AnyFn>(), applyWebhook: vi.fn<AnyFn>(), findPublisherAgent: vi.fn<AnyFn>() },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
}));

vi.mock('../kyc/prisma-digio.repository', () => ({ prismaDigioRepository: repository }));
vi.mock('../../../shared/integrations/digio-client', () => digio);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../../shared/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { initiateDigioKyc } from '../kyc/digio.service';

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'kyc_1', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://digio/#kyc_1?token=tok', mock: false });
  repository.upsertDigioKyc.mockResolvedValue({ id: 'pkyc_1' });
});

describe('starting Digio on a verified publisher', () => {
  it('is 409 KYC_ALREADY_VERIFIED before Digio is asked or the row touched', async () => {
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'VERIFIED', method: 'MANUAL' });
    await expect(initiateDigioKyc('pub_1', 'Asha Rao', '', '+919876543210')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.upsertDigioKyc).not.toHaveBeenCalled();
  });

  it('still opens a session with no row, or a row that is not verified', async () => {
    repository.findByPublisherId.mockResolvedValue(null);
    await expect(initiateDigioKyc('pub_1', 'Asha Rao', '', '+919876543210')).resolves.toMatchObject({ kycId: 'kyc_1' });
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'PENDING', method: 'DIGIO' });
    await expect(initiateDigioKyc('pub_1', 'Asha Rao', '', '+919876543210')).resolves.toMatchObject({ kycId: 'kyc_1' });
    expect(repository.upsertDigioKyc).toHaveBeenCalledTimes(2);
  });
});
