import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B — the later link. An advertiser ops created on the console has no
 * app account; the desk may already have made its KYC record against the
 * profile alone (`advertiserProfileId` set, `advertiserId` null). When the
 * owner signs in and registers with that number, `registerAdvertiser` links
 * the person to the profile (`attachUser`) — and, in the same transaction,
 * the record gains the user id. A user who already owns a legacy
 * user-keyed record is not forced onto it (`advertiserId` is unique).
 *
 * Also pinned: `GET /advertisers/:id` carries `kyc: { state, kycId, ... }`
 * derived the way the queue derives it, and the funnel's "awaiting KYC
 * submission" counts profiles with no record by the profile relation.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => {
  const tx = {
    advertiser: { update: vi.fn<AnyFn>() },
    advertiserKyc: { findUnique: vi.fn<AnyFn>(), updateMany: vi.fn<AnyFn>() },
  };
  return {
    prisma: {
      tx,
      $transaction: vi.fn<AnyFn>(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      advertiser: { findUnique: vi.fn<AnyFn>(), count: vi.fn<AnyFn>(async () => 0) },
      advertiserKyc: { findUnique: vi.fn<AnyFn>(), count: vi.fn<AnyFn>(async () => 0) },
      user: { findUnique: vi.fn<AnyFn>() },
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAdvertisersRepository as repository } from '../prisma-advertisers.repository';

const NOW = new Date('2026-09-14T22:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tx.advertiser.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { userId: string } }) => ({ id: where.id, userId: data.userId }));
  prisma.tx.advertiserKyc.findUnique.mockResolvedValue(null);
  prisma.tx.advertiserKyc.updateMany.mockResolvedValue({ count: 1 });
});

describe('attachUser links the desk’s record to the person who signed in', () => {
  it('sets the profile’s userId and stamps advertiserId on the record that carried the profile alone — one transaction', async () => {
    const linked = await repository.attachUser('adv_swiggy', 'usr_owner');
    expect(linked).toEqual({ id: 'adv_swiggy', userId: 'usr_owner' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.advertiser.update).toHaveBeenCalledWith({ where: { id: 'adv_swiggy' }, data: { userId: 'usr_owner' } });
    expect(prisma.tx.advertiserKyc.findUnique).toHaveBeenCalledWith({ where: { advertiserId: 'usr_owner' }, select: { id: true } });
    expect(prisma.tx.advertiserKyc.updateMany).toHaveBeenCalledWith({ where: { advertiserProfileId: 'adv_swiggy', advertiserId: null }, data: { advertiserId: 'usr_owner' } });
  });

  it('leaves a legacy user-keyed record where it is — the user id is unique on the table — and still links the profile', async () => {
    prisma.tx.advertiserKyc.findUnique.mockResolvedValue({ id: 'akyc_legacy' });
    await repository.attachUser('adv_swiggy', 'usr_owner');
    expect(prisma.tx.advertiser.update).toHaveBeenCalledWith({ where: { id: 'adv_swiggy' }, data: { userId: 'usr_owner' } });
    expect(prisma.tx.advertiserKyc.updateMany).not.toHaveBeenCalled();
  });
});

describe('the party read’s KYC summary', () => {
  it('reads the record by the profile first, then (a legacy row) by the user; null before any record', async () => {
    const select = { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true };
    prisma.advertiserKyc.findUnique.mockResolvedValueOnce({ id: 'akyc_1', status: 'PENDING', submittedAt: null, requestedAt: NOW, requestedChannel: 'DIGIO', method: 'DIGIO' });
    expect(await repository.findKycSummary('adv_1', 'usr_1')).toMatchObject({ id: 'akyc_1', requestedChannel: 'DIGIO' });
    expect(prisma.advertiserKyc.findUnique).toHaveBeenCalledWith({ where: { advertiserProfileId: 'adv_1' }, select });
    expect(prisma.advertiserKyc.findUnique).toHaveBeenCalledTimes(1);

    prisma.advertiserKyc.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'akyc_legacy', status: 'VERIFIED', submittedAt: NOW, requestedAt: null, requestedChannel: null, method: 'MANUAL' });
    expect(await repository.findKycSummary('adv_1', 'usr_1')).toMatchObject({ id: 'akyc_legacy' });
    expect(prisma.advertiserKyc.findUnique).toHaveBeenLastCalledWith({ where: { advertiserId: 'usr_1' }, select });

    prisma.advertiserKyc.findUnique.mockResolvedValueOnce(null);
    expect(await repository.findKycSummary('adv_console', null)).toBeNull();
  });
});
