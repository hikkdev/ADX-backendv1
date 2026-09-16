import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2-B (the Lot N verifier's observation) — a Digio approval stamps
 * `method: DIGIO` on the advertiser's row. Every hand-submitted set of
 * documents stamps MANUAL, so a partner who uploaded by hand while a Digio
 * session was still open sat on the manual path; when Digio then approves,
 * the record is Digio-verified — the method says so, the liveness gate
 * (which exempts DIGIO) reads it right, and the purge finds it. A rejection
 * or a pending update leaves the method alone. The print partner's twin is
 * pinned in full in `print-partners/kyc/__tests__/print-partner-kyc.repository.test.ts`;
 * the publisher's in `publishers/__tests__/n2b-digio-method.test.ts`.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: { advertiserKyc: { update: vi.fn<AnyFn>() } },
}));

vi.mock('../../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAdvertiserKycRepository as repository } from '../prisma-advertiser-kyc.repository';

const NOW = new Date('2026-09-14T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.advertiserKyc.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'akyc_1', ...data }));
});

describe('applyDigioWebhook', () => {
  it('stamps method DIGIO with recordedVia DIGIO and no recorder when Digio approves', async () => {
    await repository.applyDigioWebhook('akyc_1', { digioStatus: 'approved', digioPayload: { id: 'dg_1' }, digioVerifiedAt: NOW, status: 'VERIFIED', reviewedAt: NOW });
    expect(prisma.advertiserKyc.update).toHaveBeenCalledWith({
      where: { id: 'akyc_1' },
      data: expect.objectContaining({ status: 'VERIFIED', method: 'DIGIO', recordedVia: 'DIGIO', recordedById: null, digioPayload: { id: 'dg_1' } }),
    });
  });

  it('leaves the method alone on a rejection or a pending update', async () => {
    await repository.applyDigioWebhook('akyc_1', { digioStatus: 'rejected', digioPayload: { id: 'dg_1' }, status: 'REJECTED', rejectionReason: 'Face mismatch', reviewedAt: NOW });
    expect(prisma.advertiserKyc.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ method: expect.anything() }) }));
    await repository.applyDigioWebhook('akyc_1', { digioStatus: 'pending', digioPayload: { id: 'dg_1' }, status: 'PENDING' });
    expect(prisma.advertiserKyc.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ method: expect.anything() }) }));
  });
});
