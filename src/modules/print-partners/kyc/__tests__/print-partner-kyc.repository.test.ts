import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N — `PrintPartner.kycStatus` mirrors the record on every status
 * write, in the same transaction: a submission (PENDING), a decision, a
 * re-upload ask (NEEDS_INFO) and a Digio webhook. Assignment and the
 * desk's request move no status and touch no mirror. N3-B: the queue is a
 * query over the PrintPartner table — every partner not yet verified plus
 * every partner with a record — `requested` (and `state=REQUESTED`) being
 * a record with `requestedAt` set and `submittedAt` null; `q` reaches the
 * partner's name, display id and mobile; breaches are PENDING records past
 * the cutoff.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => {
  const tx = {
    printPartnerKyc: { update: vi.fn<AnyFn>(), upsert: vi.fn<AnyFn>() },
    printPartner: { update: vi.fn<AnyFn>() },
  };
  return {
    prisma: {
      tx,
      $transaction: vi.fn<AnyFn>(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      printPartnerKyc: { update: vi.fn<AnyFn>(), upsert: vi.fn<AnyFn>(), findMany: vi.fn<AnyFn>(), count: vi.fn<AnyFn>(), groupBy: vi.fn<AnyFn>(async () => []) },
      printPartner: { update: vi.fn<AnyFn>(), findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0) },
    },
  };
});

vi.mock('../../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaPrintPartnerKycRepository as repository } from '../prisma-print-partner-kyc.repository';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const slice = { id: 'prt_1', name: 'Sharma Prints', userId: 'usr_prt', kycStatus: 'PENDING' };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tx.printPartnerKyc.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ppk_1', printPartnerId: 'prt_1', ...data, printPartner: slice }));
  prisma.tx.printPartnerKyc.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({ id: 'ppk_1', printPartnerId: 'prt_1', ...update, printPartner: slice }));
  prisma.tx.printPartner.update.mockResolvedValue({});
  prisma.printPartnerKyc.findMany.mockResolvedValue([]);
  prisma.printPartnerKyc.count.mockResolvedValue(0);
});

describe('the mirror', () => {
  it('a submission writes PENDING on the row and the partner in one transaction, and stamps the recorder', async () => {
    const row = await repository.submit('prt_1', { panNumber: 'ABCDE1234F' }, { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL' }, NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.printPartnerKyc.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { printPartnerId: 'prt_1' },
        update: expect.objectContaining({ panNumber: 'ABCDE1234F', status: 'PENDING', rejectionReason: null, submittedAt: NOW, recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', escalatedAt: null }),
        create: expect.objectContaining({ printPartnerId: 'prt_1', status: 'PENDING', submittedAt: NOW, recordedVia: 'DESK' }),
      }),
    );
    expect(prisma.tx.printPartner.update).toHaveBeenCalledWith({ where: { id: 'prt_1' }, data: { kycStatus: 'PENDING' } });
    expect(row.printPartner.kycStatus).toBe('PENDING');
  });

  it('a decision mirrors the status and clears the escalation', async () => {
    const row = await repository.review('ppk_1', 'VERIFIED', null, { reviewedById: 'usr_admin', reviewNote: 'ok' }, NOW);
    expect(prisma.tx.printPartnerKyc.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ppk_1' }, data: expect.objectContaining({ status: 'VERIFIED', reviewedAt: NOW, reviewedById: 'usr_admin', reviewNote: 'ok', escalatedAt: null, escalatedToUserId: null }) }),
    );
    expect(prisma.tx.printPartner.update).toHaveBeenCalledWith({ where: { id: 'prt_1' }, data: { kycStatus: 'VERIFIED' } });
    expect(row.printPartner.kycStatus).toBe('VERIFIED');
  });

  it('a re-upload ask mirrors NEEDS_INFO; a webhook mirrors its decision', async () => {
    await repository.requestReupload('ppk_1', { reviewedById: 'usr_admin', reviewNote: 'Blurry' }, NOW);
    expect(prisma.tx.printPartner.update).toHaveBeenLastCalledWith({ where: { id: 'prt_1' }, data: { kycStatus: 'NEEDS_INFO' } });

    await repository.applyDigioWebhook('ppk_1', { digioStatus: 'rejected', digioPayload: { id: 'dg_1' }, status: 'REJECTED', rejectionReason: 'x', recordedVia: 'DIGIO', submittedAt: NOW });
    expect(prisma.tx.printPartnerKyc.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', recordedVia: 'DIGIO', digioPayload: { id: 'dg_1' } }) }),
    );
    expect(prisma.tx.printPartner.update).toHaveBeenLastCalledWith({ where: { id: 'prt_1' }, data: { kycStatus: 'REJECTED' } });
  });

  it('N2-B: a Digio approval stamps method DIGIO on the row — documents sent by hand while the session was open are Digio-verified now; a rejection leaves the method alone', async () => {
    await repository.applyDigioWebhook('ppk_1', { digioStatus: 'approved', digioPayload: { id: 'dg_1' }, status: 'VERIFIED', digioVerifiedAt: NOW, reviewedAt: NOW, recordedVia: 'DIGIO', submittedAt: NOW });
    expect(prisma.tx.printPartnerKyc.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'ppk_1' }, data: expect.objectContaining({ status: 'VERIFIED', method: 'DIGIO', recordedVia: 'DIGIO', recordedById: null }) }),
    );
    expect(prisma.tx.printPartner.update).toHaveBeenLastCalledWith({ where: { id: 'prt_1' }, data: { kycStatus: 'VERIFIED' } });

    await repository.applyDigioWebhook('ppk_1', { digioStatus: 'rejected', digioPayload: { id: 'dg_1' }, status: 'REJECTED', rejectionReason: 'x', recordedVia: 'DIGIO', submittedAt: NOW });
    expect(prisma.tx.printPartnerKyc.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ method: expect.anything() }) }));
  });

  it('assignment and the desk\'s request move no status and touch no mirror', async () => {
    prisma.printPartnerKyc.update.mockResolvedValue({});
    prisma.printPartnerKyc.upsert.mockResolvedValue({ id: 'ppk_1', printPartner: slice });
    await repository.assign('ppk_1', 'usr_admin', NOW);
    await repository.markRequested('prt_1', { requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' });
    expect(prisma.printPartnerKyc.update).toHaveBeenCalledWith({ where: { id: 'ppk_1' }, data: { assignedToId: 'usr_admin', assignedAt: NOW } });
    expect(prisma.printPartnerKyc.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { printPartnerId: 'prt_1' }, update: { requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' } }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.printPartner.update).not.toHaveBeenCalled();
  });
});

describe('the queue filter', () => {
  it('N3-B: the queue is every partner, left-joined to its record — `requested` is the REQUESTED state; `q` reaches the partner; breaches are PENDING records past the cutoff', async () => {
    await repository.findPage({ requested: true, q: 'Sharma', escalated: false, assignedToId: null }, 2, 10);
    const call = prisma.printPartner.findMany.mock.calls[0]![0];
    expect(call.where.AND).toEqual([
      // every partner not yet verified, plus every partner with a record
      { OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] },
      // the REQUESTED state
      { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } },
      { kyc: { is: { assignedToId: null } } },
      { OR: [{ kyc: null }, { kyc: { is: { escalatedAt: null } } }] },
      {
        OR: [
          { name: { contains: 'Sharma', mode: 'insensitive' } },
          { displayId: { contains: 'Sharma', mode: 'insensitive' } },
          { mobile: { contains: 'Sharma' } },
        ],
      },
    ]);
    expect(call).toMatchObject({ skip: 10, take: 10, select: expect.objectContaining({ kyc: true }) });
    // Late submissions first, then the parties with nothing in by when they arrived.
    expect(call.orderBy).toEqual([{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }]);

    await repository.countBreached({}, NOW);
    expect(prisma.printPartner.count).toHaveBeenLastCalledWith({
      where: { AND: [{ AND: [{ OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] }] }, { kyc: { is: { status: 'PENDING', submittedAt: { not: null, lt: NOW } } } }] },
    });

    await repository.countRequested({ requested: false, status: 'PENDING' });
    expect(prisma.printPartner.count).toHaveBeenLastCalledWith({
      where: { AND: [{ OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } }] },
    });
  });

  it('N3-B: a party with no record is listed AWAITING_DOCUMENTS with every record column null and `id` the partner’s; a party with one is its state with the record spread', async () => {
    const arrived = new Date('2026-09-14T22:00:00.000Z');
    prisma.printPartner.findMany.mockResolvedValue([
      { id: 'prt_new', displayId: 'PRT-1', name: 'Fresh Prints', mobile: '+91', email: null, userId: 'usr_new', city: 'Pune', isActive: true, kycStatus: 'PENDING', createdAt: arrived, kyc: null },
      { id: 'prt_1', displayId: 'PRT-2', name: 'Sharma Prints', mobile: '+92', email: null, userId: 'usr_prt', city: 'Pune', isActive: true, kycStatus: 'PENDING', createdAt: arrived, kyc: { id: 'ppk_1', printPartnerId: 'prt_1', status: 'PENDING', submittedAt: null, requestedAt: NOW, requestedChannel: 'DIGIO', method: 'DIGIO' } },
    ]);
    prisma.printPartner.count.mockResolvedValue(2);
    const { items, total } = await repository.findPage({}, 1, 20);
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({ id: 'prt_new', printPartnerId: 'prt_new', kycId: null, state: 'AWAITING_DOCUMENTS', status: null, submittedAt: null, requestedAt: null, printPartner: { id: 'prt_new', name: 'Fresh Prints', createdAt: arrived } });
    expect(items[1]).toMatchObject({ id: 'ppk_1', printPartnerId: 'prt_1', kycId: 'ppk_1', state: 'REQUESTED', requestedChannel: 'DIGIO', printPartner: { name: 'Sharma Prints' } });

    // The chips: one count per state, the state facet (and its aliases) removed.
    prisma.printPartner.count.mockClear();
    await repository.countByState({ state: 'PENDING', q: 'x' });
    expect(prisma.printPartner.count).toHaveBeenCalledTimes(6);
    expect(prisma.printPartner.count.mock.calls.map((c) => c[0].where.AND[1])).toEqual([
      { OR: [{ kyc: null, kycStatus: { not: 'VERIFIED' } }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }] },
      { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } },
      { kyc: { is: { status: 'PENDING', submittedAt: { not: null } } } },
      { kyc: { is: { status: 'NEEDS_INFO' } } },
      { kyc: { is: { status: 'REJECTED' } } },
      { kyc: { is: { status: 'VERIFIED' } } },
    ]);
  });

  it('only Digio-path VERIFIED rows with images are purgeable', async () => {
    await repository.findPurgeable(NOW, 50);
    expect(prisma.printPartnerKyc.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { method: 'DIGIO', status: 'VERIFIED', imagesPurgedAt: null, digioVerifiedAt: { not: null, lt: NOW } }, take: 50 }),
    );
  });
});
