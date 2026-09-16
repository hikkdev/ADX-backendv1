import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A (Q31) / Lot V: which geographies ADX is open in, and for what.
 *
 * The distinction the whole thing turns on: a catalogued city whose stage
 * has a function switched off refuses that function, and a name the
 * catalogue has never heard of does not. The city field is free text — the
 * owner wants no restriction on where, only control — so only a deliberate
 * stage says no, and it says which function and why.
 */

const { repository, audit, cache } = vi.hoisted(() => ({
  repository: { listAllCities: vi.fn(), findCity: vi.fn(), findCityById: vi.fn(), updateCity: vi.fn(), findCitiesBySpelling: vi.fn(), foldCityKey: vi.fn(), listUnresolvedCityStrings: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  cache: { redis: { set: vi.fn() } },
}));

vi.mock('../prisma-pricing.repository', () => ({ prismaPricingRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../../shared/cache', () => cache);

import { errorHandler } from '../../../shared/errors';
import { assertCityAllows, backfillCityKeys, cityKeyFor, citySupport, clearCityKeyCache, listUnresolvedCities, pickCityRow, updateCity, withCityKey } from '../pricing.service';
import { listCitiesHandler, updateCityHandler } from '../pricing.controller';
import type { CityRow } from '../pricing.repository';

const ON = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
const SEEDING = { ...OFF, supplyIntake: true, agentOnboarding: true, leadFeeds: true };

const CITIES: CityRow[] = [
  { id: 'city_bengaluru', slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', aliases: ['bangalore'], isActive: true, stage: 'LAUNCHED', switches: ON, population: 8_495_492 },
  { id: 'city_kochi', slug: 'kochi', name: 'Kochi', state: 'Kerala', aliases: ['cochin'], isActive: false, stage: 'PLANNED', switches: OFF, population: 633_553 },
  { id: 'city_mysuru', slug: 'mysuru', name: 'Mysuru', state: 'Karnataka', aliases: ['mysore'], isActive: true, stage: 'SEEDING', switches: SEEDING, population: 920_550 },
  { id: 'city_raipur', slug: 'raipur', name: 'Raipur', state: 'Chhattisgarh', aliases: [], isActive: true, stage: 'LAUNCHED', switches: ON, population: 1_027_264 },
  { id: 'city_raipur_uttarakhand', slug: 'raipur-uttarakhand', name: 'Raipur', state: 'Uttarakhand', aliases: [], isActive: false, stage: 'PLANNED', switches: OFF, population: 27_702 },
];

const slugOf = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The two handlers behind an admin, the way the router leaves one on `req`. */
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { sub: 'admin-1', roles: ['ADMIN'] } as never;
    next();
  });
  const api = Router();
  api.get('/pricing/cities', listCitiesHandler);
  api.patch('/pricing/cities/:slug', updateCityHandler);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.redis.set.mockResolvedValue('OK');
  repository.listAllCities.mockResolvedValue(CITIES);
  repository.findCity.mockImplementation(async (slug: string) => CITIES.find((c) => c.slug === slug) ?? null);
  repository.findCityById.mockImplementation(async (id: string) => CITIES.find((c) => c.id === id) ?? null);
  repository.foldCityKey.mockResolvedValue(0);
  repository.listUnresolvedCityStrings.mockResolvedValue([]);
  clearCityKeyCache();
  // The Prisma repository answers by slug, by alias or by name; the service picks.
  repository.findCitiesBySpelling.mockImplementation(async (spelling: string, raw: string) =>
    CITIES.filter((c) => c.slug === spelling || c.aliases.includes(spelling) || c.name.toLowerCase() === raw.toLowerCase()),
  );
  repository.updateCity.mockImplementation(async (slug: string, patch: Record<string, unknown>) => ({
    ...CITIES.find((c) => c.slug === slug),
    ...patch,
  }));
});

describe('what a city name resolves to', () => {
  it('answers ACTIVE with the stage and switches on a launched city, by its name, its slug or an alias', async () => {
    for (const name of ['Bengaluru', 'bengaluru', 'Bangalore']) {
      const view = await citySupport(name);
      expect(view).toMatchObject({ support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: ON });
    }
  });

  it('answers INACTIVE on a planned city, alias included, with every switch off', async () => {
    expect(await citySupport('Kochi')).toMatchObject({ support: 'INACTIVE', resolved: true, stage: 'PLANNED', switches: OFF });
    expect((await citySupport('cochin')).support).toBe('INACTIVE');
  });

  it('answers UNKNOWN, unresolved and all-open on a name with no row, and on nothing at all', async () => {
    for (const name of ['Rameswaram', null, '   ']) {
      expect(await citySupport(name)).toMatchObject({ support: 'UNKNOWN', resolved: false, stage: null, switches: ON, city: null });
    }
  });

  it('asks one query per name, never the whole table', async () => {
    await citySupport('Bengaluru');
    expect(repository.findCitiesBySpelling).toHaveBeenCalledWith('bengaluru', 'Bengaluru');
    expect(repository.listAllCities).not.toHaveBeenCalled();
  });

  it('picks the most advanced stage, then the biggest place, when India has several of a name', async () => {
    expect((await citySupport('Raipur')).city?.slug).toBe('raipur');
    const twoPlanned = CITIES.filter((c) => c.name === 'Raipur').map((c) => ({ ...c, stage: 'PLANNED' as const, isActive: false, switches: OFF }));
    expect(pickCityRow(twoPlanned, 'raipur')?.slug).toBe('raipur');
    expect(pickCityRow(twoPlanned.map((c) => ({ ...c, slug: `${c.slug}-x` })), 'raipur')?.population).toBe(1_027_264);
  });
});

describe('the gate, function by function', () => {
  it('lets a launched city through every function', async () => {
    for (const fn of ['supplyIntake', 'publishing', 'demand', 'agentOnboarding', 'printPartners', 'leadFeeds'] as const) {
      await expect(assertCityAllows('Bengaluru', fn)).resolves.toMatchObject({ resolved: true, stage: 'LAUNCHED' });
    }
  });

  it('refuses every function on a planned city, naming the function, the stage and the city', async () => {
    for (const fn of ['supplyIntake', 'publishing', 'demand', 'agentOnboarding', 'printPartners', 'leadFeeds'] as const) {
      await expect(assertCityAllows('Kochi', fn)).rejects.toMatchObject({
        statusCode: 400,
        code: 'CITY_NOT_OPEN',
        message: expect.stringContaining('Kochi'),
        details: { stage: 'PLANNED', function: fn, city: 'kochi' },
      });
    }
  });

  it('opens a seeding city for intake, agents and leads and refuses it publishing, demand and partners', async () => {
    await expect(assertCityAllows('Mysore', 'supplyIntake')).resolves.toMatchObject({ stage: 'SEEDING' });
    await expect(assertCityAllows('Mysore', 'agentOnboarding')).resolves.toBeDefined();
    await expect(assertCityAllows('Mysore', 'leadFeeds')).resolves.toBeDefined();
    await expect(assertCityAllows('Mysore', 'publishing')).rejects.toMatchObject({ code: 'CITY_NOT_OPEN', details: { function: 'publishing' } });
    await expect(assertCityAllows('Mysore', 'demand')).rejects.toMatchObject({ code: 'CITY_NOT_OPEN' });
    await expect(assertCityAllows('Mysore', 'printPartners')).rejects.toMatchObject({ code: 'CITY_NOT_OPEN' });
  });

  it('lets a name outside the catalogue and an empty field through every function — free text stays free — and notes the name once a day', async () => {
    await expect(assertCityAllows('Rameswaram', 'demand')).resolves.toMatchObject({ resolved: false });
    await expect(assertCityAllows(null, 'supplyIntake')).resolves.toMatchObject({ resolved: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cache.redis.set).toHaveBeenCalledTimes(1);
    expect(cache.redis.set.mock.calls[0]![0]).toMatch(/^geo:unknown-city:\d{4}-\d{2}-\d{2}:rameswaram$/);
  });

  it('still lets an unknown name through when Redis is away', async () => {
    cache.redis.set.mockRejectedValue(new Error('down'));
    await expect(assertCityAllows('Rameswaram', 'demand')).resolves.toMatchObject({ resolved: false });
  });
});

describe('ops editing a city', () => {
  it('normalises aliases so one spelling is not stored twice', async () => {
    await updateCity('bengaluru', { aliases: ['Bangalore', ' bangalore ', 'Bengaluru Urban'] });
    expect(repository.updateCity).toHaveBeenCalledWith('bengaluru', {
      aliases: ['bangalore', 'bengaluru-urban'],
    });
  });

  it('refuses a direct write to isActive, which mirrors the stage, and points at the rollout route', async () => {
    await expect(updateCity('bengaluru', { isActive: false })).rejects.toMatchObject({
      statusCode: 400,
      details: { stage: 'LAUNCHED', rollout: '/api/v1/geo/cities/bengaluru/rollout' },
    });
    expect(repository.updateCity).not.toHaveBeenCalled();
  });

  it('accepts isActive when it already agrees with the mirror', async () => {
    await updateCity('bengaluru', { isActive: true, aliases: ['bangalore'] });
    expect(repository.updateCity).toHaveBeenCalledWith('bengaluru', { aliases: ['bangalore'] });
  });

  it('is a 404 on a city that does not exist', async () => {
    await expect(updateCity('atlantis', { aliases: ['x'] })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the routes', () => {
  it('lists every city, retired ones included, with the stage and switches', async () => {
    const res = await request(app()).get('/api/v1/pricing/cities');
    expect(res.status).toBe(200);
    expect(res.body.data.map((city: { slug: string }) => city.slug)).toEqual(CITIES.map((c) => c.slug));
    expect(res.body.data[0]).toMatchObject({ stage: 'LAUNCHED', switches: ON });
  });

  it('teaches a spelling and audits it as CITY_UPDATED', async () => {
    const res = await request(app()).patch('/api/v1/pricing/cities/bengaluru').send({ aliases: ['Bangalore', 'Bengaluru Urban'] });

    expect(res.status).toBe(200);
    expect(res.body.data.aliases).toEqual(['bangalore', 'bengaluru-urban']);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'CITY_UPDATED',
      expect.objectContaining({ module: 'pricing', targetType: 'City', targetId: 'bengaluru' }),
    );
  });

  it('answers 400 to a closure through the old flag', async () => {
    const res = await request(app()).patch('/api/v1/pricing/cities/bengaluru').send({ isActive: false });
    expect(res.status).toBe(400);
    expect(res.body.error?.details?.rollout ?? res.body.details?.rollout).toContain('/geo/cities/bengaluru/rollout');
  });

  it('refuses a body that names neither field', async () => {
    const res = await request(app()).patch('/api/v1/pricing/cities/bengaluru').send({});
    expect(res.status).toBe(400);
    expect(repository.updateCity).not.toHaveBeenCalled();
  });
});

describe('the city key (Lot X-B)', () => {
  it('answers the row id and slug for a name, its slug or an alias, and null for a typed town, nothing, or blanks', async () => {
    expect(await cityKeyFor('Bangalore')).toEqual({ cityId: 'city_bengaluru', slug: 'bengaluru' });
    expect(await cityKeyFor('bengaluru')).toEqual({ cityId: 'city_bengaluru', slug: 'bengaluru' });
    expect(await cityKeyFor(' BENGALURU ')).toEqual({ cityId: 'city_bengaluru', slug: 'bengaluru' });
    expect(await cityKeyFor('Rameswaram')).toBeNull();
    expect(await cityKeyFor(null)).toBeNull();
    expect(await cityKeyFor(undefined)).toBeNull();
    expect(await cityKeyFor('   ')).toBeNull();
    expect(await cityKeyFor('!!!')).toBeNull();
  });

  it('keys a PLANNED town too — the catalogue, not the rollout, decides the key', async () => {
    expect(await cityKeyFor('cochin')).toEqual({ cityId: 'city_kochi', slug: 'kochi' });
  });

  it('picks the most advanced stage when India has several of a name', async () => {
    expect(await cityKeyFor('Raipur')).toEqual({ cityId: 'city_raipur', slug: 'raipur' });
  });

  it('caches a minute per normalised spelling, the null answer included', async () => {
    const t0 = Date.parse('2026-09-15T10:00:00Z');
    await cityKeyFor('Bangalore', t0);
    await cityKeyFor('bangalore', t0 + 1_000);
    await cityKeyFor(' Bangalore ', t0 + 59_000);
    expect(repository.findCitiesBySpelling).toHaveBeenCalledTimes(1);
    await cityKeyFor('Rameswaram', t0);
    await cityKeyFor('Rameswaram', t0 + 30_000);
    expect(repository.findCitiesBySpelling).toHaveBeenCalledTimes(2);
    // The minute passes: asked again.
    await cityKeyFor('Bangalore', t0 + 60_000);
    expect(repository.findCitiesBySpelling).toHaveBeenCalledTimes(3);
    // Cleared: asked again.
    clearCityKeyCache();
    await cityKeyFor('Bangalore', t0 + 60_000);
    expect(repository.findCitiesBySpelling).toHaveBeenCalledTimes(4);
  });

  it('withCityKey stamps the key beside the string, null for a typed town, and leaves a patch without a city alone', async () => {
    expect(await withCityKey({ name: 'A', city: 'Bangalore' })).toEqual({ name: 'A', city: 'Bangalore', cityId: 'city_bengaluru' });
    expect(await withCityKey({ name: 'A', city: 'Rameswaram' })).toEqual({ name: 'A', city: 'Rameswaram', cityId: null });
    expect(await withCityKey({ name: 'A', city: null })).toEqual({ name: 'A', city: null, cityId: null });
    expect(await withCityKey({ name: 'A' } as { name: string; city?: string })).toEqual({ name: 'A' });
    expect(await withCityKey({ name: 'A', city: undefined as string | undefined })).toEqual({ name: 'A', city: undefined });
  });

  it('the gate judges a row by the key it carries, not its spelling', async () => {
    // A row typed "Kochi" (planned, demand off) whose key points at Bengaluru: the key wins.
    await expect(assertCityAllows('Kochi', 'demand', 'city_bengaluru')).resolves.toMatchObject({ resolved: true, city: { slug: 'bengaluru' } });
    // And the other way round.
    await expect(assertCityAllows('Bengaluru', 'demand', 'city_kochi')).rejects.toMatchObject({ statusCode: 400, details: { city: 'kochi' } });
    // A key that no longer exists falls back to the spelling.
    await expect(assertCityAllows('Bengaluru', 'demand', 'city_gone')).resolves.toMatchObject({ city: { slug: 'bengaluru' } });
    // No key: the spelling, as before.
    await expect(assertCityAllows('Rameswaram', 'demand', null)).resolves.toMatchObject({ resolved: false });
  });

  it('an alias edit folds the rows typed under the new spelling onto the key, in every table, and forgets the cache', async () => {
    await cityKeyFor('Bengaluru Urban');
    repository.foldCityKey.mockImplementation(async (table: string) => (table === 'publishers' ? 3 : table === 'listings' ? 7 : 0));
    await updateCity('bengaluru', { aliases: ['bangalore', 'Bengaluru Urban'] });
    // Only the alias added — "bangalore" was already there — as stored and de-hyphenated, once per table.
    expect(repository.foldCityKey).toHaveBeenCalledTimes(8);
    for (const table of ['publishers', 'advertisers', 'agents', 'printPartners', 'listings', 'leads', 'fieldVisits', 'campaigns']) {
      expect(repository.foldCityKey).toHaveBeenCalledWith(table, 'city_bengaluru', ['bengaluru-urban', 'bengaluru urban']);
    }
    // The cache was cleared: the next lookup asks the table again.
    const before = repository.findCitiesBySpelling.mock.calls.length;
    await cityKeyFor('Bengaluru Urban');
    expect(repository.findCitiesBySpelling.mock.calls.length).toBe(before + 1);
  });

  it('an alias edit that adds nothing folds nothing', async () => {
    await updateCity('bengaluru', { aliases: ['bangalore'] });
    expect(repository.foldCityKey).not.toHaveBeenCalled();
  });

  it('lists the typed strings with no key, folded case-insensitively across the tables, biggest first', async () => {
    repository.listUnresolvedCityStrings.mockResolvedValue([
      { table: 'publishers', city: 'Blore', count: 2 },
      { table: 'listings', city: 'blore', count: 5 },
      { table: 'leads', city: 'Rameswaram', count: 1 },
      { table: 'campaigns', city: 'Blore', count: 1 },
    ]);
    expect(await listUnresolvedCities()).toEqual([
      { city: 'Blore', total: 8, tables: { publishers: 2, listings: 5, campaigns: 1 } },
      { city: 'Rameswaram', total: 1, tables: { leads: 1 } },
    ]);
  });

  it('the backfill re-resolves every null key per table and reports resolved / still null', async () => {
    repository.listUnresolvedCityStrings.mockResolvedValue([
      { table: 'publishers', city: 'Bangalore', count: 4 },
      { table: 'publishers', city: 'Rameswaram', count: 1 },
      { table: 'leads', city: 'Mysore', count: 2 },
      { table: 'campaigns', city: 'Nowhere', count: 3 },
    ]);
    repository.foldCityKey.mockImplementation(async (_table: string, _cityId: string, spellings: string[]) => (spellings[0] === 'Bangalore' ? 4 : 2));
    const out = await backfillCityKeys();
    expect(repository.foldCityKey).toHaveBeenCalledWith('publishers', 'city_bengaluru', ['Bangalore']);
    expect(repository.foldCityKey).toHaveBeenCalledWith('leads', 'city_mysuru', ['Mysore']);
    expect(repository.foldCityKey).toHaveBeenCalledTimes(2);
    expect(out.publishers).toEqual({ resolved: 4, stillNull: 1 });
    expect(out.leads).toEqual({ resolved: 2, stillNull: 0 });
    expect(out.campaigns).toEqual({ resolved: 0, stillNull: 3 });
    expect(out.agents).toEqual({ resolved: 0, stillNull: 0 });
  });
});

/** The slug helper the resolver and the seed share — pinned so a change is deliberate. */
describe('slugify', () => {
  it('lower-cases, hyphenates and trims', () => {
    expect(slugOf('  Bengaluru Urban ')).toBe('bengaluru-urban');
  });
});
