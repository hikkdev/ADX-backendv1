import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Z-B: the listing importer geocodes through the maps seam UNCHANGED, so
 * with OpenStreetMap selected on the integrations row a spot without
 * coordinates is geocoded through Nominatim — and the public host's
 * one-request-a-second policy is kept: the bucket grants the first row's
 * lookup, the second within the same second is the seam's 429, which the
 * importer treats the way it treats every seam error — the row warns
 * "No coordinates" and ops place it by hand; the batch is never refused.
 *
 * The seam is real here (`shared/maps` is not mocked); Nominatim is a
 * stubbed fetch, the row is a stubbed `getEffectiveMapsConfig`, the bucket
 * a faked Redis.
 */

type AnyFn = (...args: any[]) => any;

const { repository, pricing, audit, integrations, cache, listings, supply, rateCards, agents } = vi.hoisted(() => ({
  repository: {
    createImport: vi.fn<AnyFn>(),
    listImports: vi.fn<AnyFn>(),
    findImport: vi.fn<AnyFn>(),
    stampRow: vi.fn<AnyFn>(),
    finishCommit: vi.fn<AnyFn>(),
    setStatus: vi.fn<AnyFn>(),
    setAttempt: vi.fn<AnyFn>(),
    findPublisher: vi.fn<AnyFn>(),
    listPublisherListings: vi.fn<AnyFn>(),
    findExternalRefs: vi.fn<AnyFn>(),
    findListingsNear: vi.fn<AnyFn>(),
    listSpotVocabulary: vi.fn<AnyFn>(),
    findCityIdByName: vi.fn<AnyFn>(),
    listingsWithRunningBooking: vi.fn<AnyFn>(),
  },
  pricing: { resolveCity: vi.fn<AnyFn>(), citySupport: vi.fn<AnyFn>() },
  audit: { logActivity: vi.fn<AnyFn>(), auditDiff: vi.fn<AnyFn>(() => ({})) },
  integrations: { getEffectiveMapsConfig: vi.fn<AnyFn>() },
  cache: { redis: { set: vi.fn<AnyFn>() } },
  listings: { createListing: vi.fn<AnyFn>(), updateListing: vi.fn<AnyFn>(), assertCanCreateForPublisher: vi.fn<AnyFn>(), LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] },
  supply: { createAttempt: vi.fn<AnyFn>(), attachListingToAttempt: vi.fn<AnyFn>() },
  rateCards: { floorFor: vi.fn<AnyFn>() },
  agents: { findAgentProfile: vi.fn<AnyFn>() },
}));

vi.mock('../prisma-party-imports.repository', () => ({ prismaPartyImportsRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...integrations };
});
vi.mock('../../../shared/cache/redis', () => cache);
vi.mock('../../listings', () => listings);
vi.mock('../../supply', () => supply);
vi.mock('../../rate-cards', () => rateCards);
vi.mock('../../agents', () => agents);
// The party adapters' imports, never called here.
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m }));
vi.mock('../../advertisers', async () => {
  const { z } = await import('zod');
  return { registerAdvertiser: vi.fn(), updateProfile: vi.fn(), advertiserTypeSchema: z.enum(['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY']), ADVERTISER_INDUSTRIES: ['Retail', 'Other'] };
});
vi.mock('../../print-partners', () => ({ createPartner: vi.fn(), updatePartner: vi.fn() }));
vi.mock('../../employees', () => ({ createEmployee: vi.fn(), updateEmployee: vi.fn(), WORK_MODES: ['OFFICE', 'REMOTE', 'HYBRID', 'FIELD'], EMPLOYMENT_TYPES: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] }));
vi.mock('../../users', () => ({ createUser: vi.fn() }));

import { resolveOsmConfig } from '../../../shared/integrations';
import { NOMINATIM_BUCKET_KEY } from '../../../shared/maps';
import { validateListingImport } from '../listing-imports.service';

type Row = { rowNumber: number; outcome: string; message: string | null; data: Record<string, unknown> };

const admin = { userId: 'usr_admin', isAdmin: true };
const publisher = { id: 'pub_1', displayId: 'PUB-1', name: 'Metro Spaces', agentId: 'agt_1', userId: 'usr_pub' };

const NOMINATIM_FC_ROAD = [
  {
    place_id: 1,
    osm_type: 'way',
    osm_id: 555,
    lat: '18.5236',
    lon: '73.8410',
    display_name: 'FC Road, Deccan Gymkhana, Pune, Maharashtra, 411004, India',
    address: { road: 'FC Road', city: 'Pune', state: 'Maharashtra', postcode: '411004', country_code: 'in' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPublisher.mockResolvedValue(publisher);
  repository.listPublisherListings.mockResolvedValue([]);
  repository.findExternalRefs.mockResolvedValue(new Map());
  repository.findListingsNear.mockResolvedValue([]);
  repository.listSpotVocabulary.mockResolvedValue({ mediaTypes: [], sizeClasses: [], materials: [] });
  repository.createImport.mockImplementation(async (data: { party: string; publisherId: string; rows: unknown[]; counts: Record<string, number> }) => ({ id: 'imp_1', party: data.party, publisherId: data.publisherId, attemptId: null, status: 'VALIDATED', ...data.counts, rows: data.rows }));
  pricing.resolveCity.mockImplementation(async (name: string | null) => (name && /^pune$/i.test(name) ? 'Pune' : null));
  const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
  pricing.citySupport.mockResolvedValue({ support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'pune', name: 'Pune' } });
  rateCards.floorFor.mockResolvedValue(null);
  listings.assertCanCreateForPublisher.mockResolvedValue(undefined);
  integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'OSM', osm: resolveOsmConfig({ contactEmail: 'maps@adx.example' }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Z-B: the listing importer with OpenStreetMap selected', () => {
  it('geocodes a row without coordinates through Nominatim with the policy headers, and the bucket holds the second row to one a second', async () => {
    const fetchMock = vi.fn<AnyFn>(async () => ({ ok: true, status: 200, json: async () => NOMINATIM_FC_ROAD }));
    vi.stubGlobal('fetch', fetchMock);
    // The bucket grants the first lookup; the second lands inside the same second.
    cache.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await validateListingImport(
      'pub_1',
      {
        fileName: 'spots.csv',
        rows: [
          { rowNumber: 2, data: { title: 'FC Road Hoarding', category: 'OUTDOOR', address: '44, FC Road', city: 'pune', ratePerDay: '1200' } },
          { rowNumber: 3, data: { title: 'JM Road Hoarding', category: 'OUTDOOR', address: '9, JM Road', city: 'pune', ratePerDay: '1300' } },
          // Coordinates given: never geocoded, never metered.
          { rowNumber: 4, data: { title: 'Station Wall', category: 'OUTDOOR', address: '1, Station Road', city: 'pune', latitude: '18.5205', longitude: '73.8567', ratePerDay: '900' } },
        ],
      },
      admin,
    );

    const rows = repository.createImport.mock.calls[0]![0].rows as Row[];
    const byRow = Object.fromEntries(rows.map((row) => [row.rowNumber, row]));

    // Row 2 went through Nominatim, on the public host, with the policy's headers and the seam's parameters.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(url.searchParams.get('q')).toBe('44, FC Road, Pune');
    expect(url.searchParams.get('countrycodes')).toBe('in');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('email')).toBe('maps@adx.example');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('ADX/1.0.0 (maps@adx.example)');
    expect(byRow[2]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[2]!.data).toMatchObject({ latitude: '18.5236', longitude: '73.841', geocoded: true });

    // Row 3 asked the bucket and was held: the seam's 429 is a warning on the row, not a refusal, and Nominatim was not called.
    expect(cache.redis.set).toHaveBeenCalledTimes(2);
    expect(cache.redis.set).toHaveBeenCalledWith(NOMINATIM_BUCKET_KEY, '1', 'PX', 1000, 'NX');
    expect(byRow[3]).toMatchObject({ outcome: 'WARNING' });
    expect(byRow[3]!.data).not.toHaveProperty('geocoded');
    expect((byRow[3]!.data['plan'] as { warnings: string[] }).warnings).toContain('No coordinates — place it on the map before publishing');

    // Row 4 brought its own coordinates.
    expect(byRow[4]!.data).toMatchObject({ latitude: '18.5205', longitude: '73.8567' });
    expect(byRow[4]!.data).not.toHaveProperty('geocoded');
  });

  it('on a Nominatim of ops’ own the bucket is not asked and every row is geocoded', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'OSM', osm: resolveOsmConfig({ contactEmail: 'maps@adx.example', nominatimBaseUrl: 'https://nominatim.adx.internal' }) });
    const fetchMock = vi.fn<AnyFn>(async () => ({ ok: true, status: 200, json: async () => NOMINATIM_FC_ROAD }));
    vi.stubGlobal('fetch', fetchMock);
    await validateListingImport(
      'pub_1',
      {
        fileName: 'spots.csv',
        rows: [
          { rowNumber: 2, data: { title: 'A', category: 'OUTDOOR', address: '44, FC Road', city: 'pune', ratePerDay: '1200' } },
          { rowNumber: 3, data: { title: 'B', category: 'OUTDOOR', address: '9, JM Road', city: 'pune', ratePerDay: '1300' } },
        ],
      },
      admin,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).origin).toBe('https://nominatim.adx.internal');
    expect(cache.redis.set).not.toHaveBeenCalled();
    const rows = repository.createImport.mock.calls[0]![0].rows as Row[];
    expect(rows.every((row) => row.data['geocoded'] === true)).toBe(true);
  });
});
