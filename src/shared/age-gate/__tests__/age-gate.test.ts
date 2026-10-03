import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders."
 *
 * The one guard every order door asks. Pinned: no date on file is MISSING,
 * a date short of the 18th birthday is UNDER_18, the birthday itself
 * passes (the Indian day); 403 AGE_REQUIRED with `details.reason` and
 * `details.self`; the words are the person's own when they are the one
 * pressing, and the account holder's when an agent or the desk is; a party
 * is checked through the login it hangs on, and one with no login is
 * MISSING, never "self".
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    advertiser: { findUnique: vi.fn() },
    publisher: { findUnique: vi.fn() },
  },
}));
vi.mock('../../database', () => ({ prisma }));

import { ApiError } from '../../errors';
import { ageRequiredError, assertAdultForOrders, assertPartyAdultForOrders, orderingPersonOf } from '..';

/* 09:00 IST on 29 Sep 2026. */
const NOW = new Date('2026-09-29T03:30:00Z');

const born = (iso: string | null) => ({ dateOfBirth: iso ? new Date(`${iso}T00:00:00Z`) : null });

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertAdultForOrders', () => {
  it('passes an adult, and the 18th birthday itself', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(born('1990-04-12'));
    await expect(assertAdultForOrders('usr_1', { now: NOW })).resolves.toBeUndefined();
    prisma.user.findUnique.mockResolvedValueOnce(born('2008-09-29'));
    await expect(assertAdultForOrders('usr_1', { now: NOW })).resolves.toBeUndefined();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'usr_1' }, select: { dateOfBirth: true } });
  });

  it('refuses 403 AGE_REQUIRED / MISSING with no date on file, in the person\'s own words', async () => {
    prisma.user.findUnique.mockResolvedValue(born(null));
    const err = await refusal(assertAdultForOrders('usr_1', { now: NOW }));
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('AGE_REQUIRED');
    expect(err.message).toBe('Add your date of birth to place an order — you need to be 18 or over.');
    expect(err.details).toEqual({ reason: 'MISSING', self: true });
  });

  it('refuses UNDER_18 a day short of the 18th birthday', async () => {
    prisma.user.findUnique.mockResolvedValue(born('2008-09-30'));
    const err = await refusal(assertAdultForOrders('usr_1', { now: NOW }));
    expect(err.message).toBe('You need to be 18 or over to place an order.');
    expect(err.details).toEqual({ reason: 'UNDER_18', self: true });
  });

  it('counts the Indian day: 00:30 IST on the birthday is already eighteen', async () => {
    prisma.user.findUnique.mockResolvedValue(born('2008-09-29'));
    await expect(assertAdultForOrders('usr_1', { now: new Date('2026-09-28T19:00:00Z') })).resolves.toBeUndefined();
  });

  it('a user the table does not have is MISSING', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    expect((await refusal(assertAdultForOrders('usr_gone', { now: NOW }))).details).toEqual({ reason: 'MISSING', self: true });
  });

  it('speaks of the account holder when someone else presses (self: false)', async () => {
    prisma.user.findUnique.mockResolvedValue(born(null));
    const missing = await refusal(assertAdultForOrders('usr_adv', { actorUserId: 'usr_agent', now: NOW }));
    expect(missing.message).toBe("Add the account holder's date of birth to place this order — they need to be 18 or over.");
    expect(missing.details).toEqual({ reason: 'MISSING', self: false });
    prisma.user.findUnique.mockResolvedValue(born('2012-01-01'));
    const young = await refusal(assertAdultForOrders('usr_adv', { actorUserId: 'usr_admin', now: NOW }));
    expect(young.message).toBe('The account holder is under 18 — an order needs someone 18 or over.');
    expect(young.details).toEqual({ reason: 'UNDER_18', self: false });
  });

  it('is self when the actor is the person', async () => {
    prisma.user.findUnique.mockResolvedValue(born(null));
    expect((await refusal(assertAdultForOrders('usr_1', { actorUserId: 'usr_1', now: NOW }))).details).toEqual({ reason: 'MISSING', self: true });
  });
});

describe('assertPartyAdultForOrders', () => {
  it("checks the advertiser's own login, not whoever is pressing", async () => {
    prisma.advertiser.findUnique.mockResolvedValue({ userId: 'usr_adv' });
    prisma.user.findUnique.mockResolvedValue(born('1985-01-01'));
    await expect(assertPartyAdultForOrders({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_admin', now: NOW })).resolves.toBeUndefined();
    expect(prisma.advertiser.findUnique).toHaveBeenCalledWith({ where: { id: 'adv_1' }, select: { userId: true } });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'usr_adv' }, select: { dateOfBirth: true } });
  });

  it("checks the publisher's own login for a publisher's order", async () => {
    prisma.publisher.findUnique.mockResolvedValue({ userId: 'usr_pub' });
    prisma.user.findUnique.mockResolvedValue(born('2010-05-05'));
    const err = await refusal(assertPartyAdultForOrders({ kind: 'PUBLISHER', id: 'pub_1' }, { actorUserId: 'usr_pub', now: NOW }));
    expect(err.details).toEqual({ reason: 'UNDER_18', self: true });
  });

  it('an account with no login behind it is MISSING, and never self', async () => {
    prisma.advertiser.findUnique.mockResolvedValue({ userId: null });
    const err = await refusal(assertPartyAdultForOrders({ kind: 'ADVERTISER', id: 'adv_1' }, { now: NOW }));
    expect(err.details).toEqual({ reason: 'MISSING', self: false });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(await orderingPersonOf({ kind: 'ADVERTISER', id: 'adv_1' })).toBeNull();
  });
});

describe('ageRequiredError', () => {
  it('builds the same refusal a door throws', () => {
    const err = ageRequiredError('UNDER_18');
    expect(err).toMatchObject({ statusCode: 403, code: 'AGE_REQUIRED', details: { reason: 'UNDER_18', self: true } });
  });
});
