import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot X (verifier): erasure clears the city key beside the typed city.
 *
 * Lot X-B stamped `cityId` beside `city` on every party table. Erasure
 * already nulled the typed city on the Publisher, Advertiser and
 * AgentProfile it anonymises; the key it carried must go with it, or an
 * erased profile keeps pointing at a catalogue city — a fact the person
 * asked to have removed, and a row the keyed counts would keep counting
 * under a city it no longer names.
 */

const { prisma } = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn().mockResolvedValue({}) },
    publisher: { update: vi.fn().mockResolvedValue({}) },
    advertiser: { update: vi.fn().mockResolvedValue({}) },
    agentProfile: { update: vi.fn().mockResolvedValue({}) },
    publisherKyc: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    advertiserKyc: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    agentKyc: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    userKyc: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    uploadedFile: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    mobileTombstone: { upsert: vi.fn().mockResolvedValue({}) },
  };
  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAccountLifecycleRepository as repository } from '../prisma-account-lifecycle.repository';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('erase() and the city key', () => {
  it('nulls cityId beside city on the publisher, advertiser and agent profile', async () => {
    const footprint = await repository.erase({
      userId: 'usr_1',
      userMobile: 'erased:abc',
      mobileHash: 'hash',
      publisher: { id: 'pub_1', mobile: 'erased:pub' },
      advertiser: { id: 'adv_1', mobile: 'erased:adv' },
      agentProfileId: 'agt_1',
      advertiserKycUserId: 'usr_1',
    });

    expect(footprint.profilesAnonymised).toEqual(['User', 'Publisher', 'Advertiser', 'AgentProfile']);
    for (const table of ['publisher', 'advertiser', 'agentProfile'] as const) {
      const call = prisma[table].update.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
      expect(call, table).toBeDefined();
      expect(call!.data, table).toMatchObject({ city: null, cityId: null });
    }
  });
});
