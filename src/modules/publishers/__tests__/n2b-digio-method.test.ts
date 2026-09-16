import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2-B (the Lot N verifier's observation) — the publisher's pin: a Digio
 * approval stamps `method: DIGIO` on `PublisherKyc` beside `recordedVia:
 * DIGIO`, so documents sent by hand while the session was open are
 * Digio-verified once Digio says so (the liveness gate exempts DIGIO; the
 * purge finds it). A rejection leaves the method alone. The rule itself is
 * tested in full on the print partner
 * (`print-partners/kyc/__tests__/print-partner-kyc.repository.test.ts`).
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: { publisherKyc: { update: vi.fn<AnyFn>() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaDigioRepository as repository } from '../kyc/prisma-digio.repository';

const NOW = new Date('2026-09-14T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisherKyc.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pkyc_1', ...data }));
});

describe('applyWebhook', () => {
  it('stamps method DIGIO on an approval, and not on a rejection', async () => {
    await repository.applyWebhook('pkyc_1', { digioStatus: 'approved', digioPayload: { id: 'dg_1' }, digioVerifiedAt: NOW, status: 'VERIFIED', reviewedAt: NOW });
    expect(prisma.publisherKyc.update).toHaveBeenLastCalledWith({
      where: { id: 'pkyc_1' },
      data: expect.objectContaining({ status: 'VERIFIED', method: 'DIGIO', recordedVia: 'DIGIO', recordedById: null }),
    });

    await repository.applyWebhook('pkyc_1', { digioStatus: 'rejected', digioPayload: { id: 'dg_1' }, status: 'REJECTED', rejectionReason: 'x', reviewedAt: NOW });
    expect(prisma.publisherKyc.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ method: expect.anything() }) }));
  });
});
