import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G12-B — position sharing on a field visit.
 *
 * `POST /visits/:visitId/update-location` is the order lane's ping
 * (`POST /orders/:id/update-location`) for a visit that is not a step on an
 * order. `FieldVisit` has no agent-location column and no order to land the
 * ping on, so it goes to the live-position store — one Redis key per visit,
 * the shape the order row keeps (`latitude`, `longitude`, `updatedAt`),
 * expiring on its own: a position is news for the day of the visit, not a
 * record. The visit's own agent only; a Redis blink drops one ping and is
 * logged, never a failed request.
 */

const { repository, agents, cache, logger } = vi.hoisted(() => ({
  repository: { findById: vi.fn() },
  agents: {
    requireAgentProfile: vi.fn(),
    findAgentProfile: vi.fn(),
    getAgentWithUser: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
  },
  cache: { redis: { set: vi.fn(), get: vi.fn() } },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
}));
vi.mock('../prisma-visits.repository', () => ({ prismaVisitsRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../../shared/logging', () => ({ logger }));

import { shareVisitLocation } from '../visits.service';
import { VISIT_LOCATION_TTL_SECONDS, getVisitLocation, visitLocationKey } from '../visit-location.store';
import { visitLocationSchema } from '../visits.schema';

const NOW = new Date('2026-09-11T06:00:00.000Z');

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vst_1',
  agentId: 'agt_1',
  status: 'SCHEDULED',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(visit());
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  cache.redis.set.mockResolvedValue('OK');
  cache.redis.get.mockResolvedValue(null);
});

describe('the body', () => {
  it('is the order lane’s: latitude and longitude, numbers, both required', () => {
    expect(visitLocationSchema.parse({ latitude: 12.97, longitude: 77.6 })).toEqual({ latitude: 12.97, longitude: 77.6 });
    expect(visitLocationSchema.safeParse({ longitude: 77.6 }).success).toBe(false);
    expect(visitLocationSchema.safeParse({ latitude: '12.97', longitude: '77.6' }).success).toBe(false);
  });
});

describe('POST /visits/:visitId/update-location', () => {
  it('writes the ping to the visit’s key in the order row’s shape, with a day’s expiry', async () => {
    await shareVisitLocation('vst_1', 'usr_1', { latitude: 12.97, longitude: 77.6 }, NOW);
    expect(cache.redis.set).toHaveBeenCalledWith(
      visitLocationKey('vst_1'),
      JSON.stringify({ latitude: 12.97, longitude: 77.6, updatedAt: NOW.toISOString() }),
      'EX',
      VISIT_LOCATION_TTL_SECONDS,
    );
    expect(VISIT_LOCATION_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('is the visit’s own agent’s: 403 for anyone else, 404 for no such visit', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(shareVisitLocation('vst_1', 'usr_2', { latitude: 1, longitude: 2 }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    agents.findAgentProfile.mockResolvedValue(null);
    await expect(shareVisitLocation('vst_1', 'usr_3', { latitude: 1, longitude: 2 }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    repository.findById.mockResolvedValue(null);
    await expect(shareVisitLocation('vst_missing', 'usr_1', { latitude: 1, longitude: 2 }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('is a ping, not a state change: a settled visit still takes it, and a Redis blink drops one ping with a log line, not a 500', async () => {
    repository.findById.mockResolvedValue(visit({ status: 'COMPLETED' }));
    cache.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(shareVisitLocation('vst_1', 'usr_1', { latitude: 1, longitude: 2 }, NOW)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('visit location write failed', expect.objectContaining({ visitId: 'vst_1' }));
  });

  it('reads back what was written, in the order row’s shape, and null when nothing is there or the value is junk', async () => {
    cache.redis.get.mockResolvedValue(JSON.stringify({ latitude: 12.97, longitude: 77.6, updatedAt: NOW.toISOString() }));
    await expect(getVisitLocation('vst_1')).resolves.toEqual({ latitude: 12.97, longitude: 77.6, updatedAt: NOW.toISOString() });
    cache.redis.get.mockResolvedValue(null);
    await expect(getVisitLocation('vst_1')).resolves.toBeNull();
    cache.redis.get.mockResolvedValue('{"latitude":"x"}');
    await expect(getVisitLocation('vst_1')).resolves.toBeNull();
    cache.redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getVisitLocation('vst_1')).resolves.toBeNull();
  });
});
