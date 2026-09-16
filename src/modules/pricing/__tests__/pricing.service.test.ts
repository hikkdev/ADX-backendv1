import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comparable, PricingRepository } from '../pricing.repository';

// vi.hoisted so the stub exists before vi.mock's factory runs during the static
// import below — same reason as the supply and advertiser tests.
const repository = vi.hoisted(
  () =>
    ({
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      listMediaTypes: vi.fn(),
      findMediaType: vi.fn(),
      findMediaTypeBySlug: vi.fn(),
      createMediaType: vi.fn(),
      updateMediaType: vi.fn(),
      mergeMediaTypes: vi.fn(),
      setMediaTypeAttributes: vi.fn(),
      listSizeClasses: vi.fn(),
      findSizeClass: vi.fn(),
      resolveSizeClassForDimensions: vi.fn(),
      listVenueTypes: vi.fn(),
      findVenueType: vi.fn(),
      findVenueTypeBySlug: vi.fn(),
      createVenueType: vi.fn(),
      updateVenueType: vi.fn(),
      createSizeClass: vi.fn(),
      updateSizeClass: vi.fn(),
      findSizeClassBySlug: vi.fn(),
      listMaterials: vi.fn(),
      findMaterial: vi.fn(),
      createMaterial: vi.fn(),
      updateMaterial: vi.fn(),
      listCities: vi.fn(),
      findMaterialBySlug: vi.fn(),
      recordVocabularyProposal: vi.fn(),
      listVocabularyProposals: vi.fn(),
      findVocabularyProposal: vi.fn(),
      resolveVocabularyProposal: vi.fn(),
      logMediaTypeMatch: vi.fn(),
      listMediaTypeMatchLogs: vi.fn(),
      listingComparables: vi.fn(),
      marketDataComparables: vi.fn(),
      createImport: vi.fn(),
      insertMarketDataPoints: vi.fn(),
      finishImport: vi.fn(),
      deactivateImport: vi.fn(),
      listFactors: vi.fn(),
      findFactor: vi.fn(),
      countFactorApplications: vi.fn(),
      deleteFactor: vi.fn(),
      createFactor: vi.fn(),
      updateFactor: vi.fn(),
      listingFactorApplications: vi.fn(),
      setFactorSuggestions: vi.fn(),
      setFactorApplied: vi.fn(),
      activeSurgeWindows: vi.fn(),
      findSurgeWindow: vi.fn(),
      listSurgeWindows: vi.fn(),
      upsertSurgeWindow: vi.fn(),
      setSurgeEnabled: vi.fn(),
      listScraperSources: vi.fn(),
      findScraperSource: vi.fn(),
      createScraperSource: vi.fn(),
      updateScraperSource: vi.fn(),
      setScraperSourceEnabled: vi.fn(),
      listScraperRuns: vi.fn(),
      startScraperRun: vi.fn(),
      finishScraperRun: vi.fn(),
      findSurgeWindowByRef: vi.fn(),
      setScraperCreatedWindowDisabled: vi.fn(),
      listingContext: vi.fn(),
      publisherUserId: vi.fn(),
      listAllCities: vi.fn(),
      findCity: vi.fn(),
      updateCity: vi.fn(),
      findCitiesBySpelling: vi.fn(),
      findCityById: vi.fn(),
      foldCityKey: vi.fn(),
      listUnresolvedCityStrings: vi.fn(),
    }) satisfies Record<keyof PricingRepository, ReturnType<typeof vi.fn>>
);

vi.mock('../prisma-pricing.repository', () => ({ prismaPricingRepository: repository }));

import {
  boundingBox,
  classifySpot,
  comparablesFor,
  evaluatePredicate,
  evaluatePrice,
  haversineMeters,
  importMarketData,
  matchMediaType,
  mergeMediaTypes,
  similarity,
  slugify,
  surgeApplies,
  buildCityResolver,
  SETTINGS_FALLBACK,
} from '../pricing.service';

/** Two points about 150 m apart in south Mumbai — inside the radius. */
const HERE = { latitude: 19.076, longitude: 72.8777 };
const NEAR = { latitude: 19.0773, longitude: 72.8777 };
const FAR = { latitude: 19.09, longitude: 72.8777 };

const settings = (overrides: Record<string, unknown> = {}) => ({
  id: 'default',
  ...SETTINGS_FALLBACK,
  updatedAt: new Date(),
  updatedById: null,
  ...overrides,
});

function comparable(overrides: Partial<Comparable> & { ratePerDay: string }): Comparable {
  return {
    id: `c_${Math.random().toString(36).slice(2)}`,
    contributorKey: 'res:acme',
    contributorName: 'Acme',
    latitude: NEAR.latitude,
    longitude: NEAR.longitude,
    distanceMeters: 0,
    observedAt: new Date('2026-08-01T00:00:00Z'),
    tier: 'LISTED',
    origin: 'MARKET_DATA',
    label: null,
    ...overrides,
  };
}

const evaluateInput = (ratePerDay: string) => ({
  mediaTypeId: 'mt_hoarding',
  sizeClassId: 'sz_20x10',
  ...HERE,
  ratePerDay,
  city: 'Mumbai',
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.getSettings.mockResolvedValue(settings());
  repository.listingComparables.mockResolvedValue([]);
  repository.marketDataComparables.mockResolvedValue([]);
  repository.activeSurgeWindows.mockResolvedValue([]);
  repository.listCities.mockResolvedValue([
    { slug: 'mumbai', name: 'Mumbai', aliases: ['bombay'] },
    { slug: 'bengaluru', name: 'Bengaluru', aliases: ['bangalore'] },
  ]);
});

describe('geometry', () => {
  it('measures a short north-south hop in metres', () => {
    const d = haversineMeters(HERE.latitude, HERE.longitude, NEAR.latitude, NEAR.longitude);
    expect(d).toBeGreaterThan(130);
    expect(d).toBeLessThan(160);
  });

  it('builds a box that over-selects rather than under-selects', () => {
    const { latDelta, lngDelta } = boundingBox(19.076, 200);
    // A degree of longitude is shorter than a degree of latitude away from the
    // equator, so the box has to be wider in longitude to cover the same metres.
    expect(lngDelta).toBeGreaterThan(latDelta);
    // Measured with the module's own haversine rather than by multiplying back
    // by the constant the box divided by, which would be true by construction
    // and would have hidden the equatorial-degree error this replaced.
    const toEdge = haversineMeters(19.076, 72.8777, 19.076 + latDelta, 72.8777);
    expect(toEdge).toBeGreaterThanOrEqual(200);
  });

  it('keeps a comparable at the very edge of the radius inside the box', () => {
    const { latDelta } = boundingBox(19.076, 200);
    // 199.9 m due north: comfortably inside the circle, and previously outside
    // the box, so it was dropped before the exact filter ever saw it.
    const edgeLat = 19.076 + 199.9 / ((2 * Math.PI * 6_371_000) / 360);
    expect(edgeLat - 19.076).toBeLessThanOrEqual(latDelta);
    expect(haversineMeters(19.076, 72.8777, edgeLat, 72.8777)).toBeLessThan(200);
  });

  it('stays finite near the poles', () => {
    expect(Number.isFinite(boundingBox(89.999, 200).lngDelta)).toBe(true);
  });
});

describe('the comparable set', () => {
  it('drops spots outside the radius even though the box let them through', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:near' }),
      comparable({ ratePerDay: '9000', contributorKey: 'res:far', ...FAR }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.contributors).toHaveLength(1);
    expect(set.high).toBe('1000.00');
  });

  it('gives a contributor one voice however many spots they own', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:acme' }),
      comparable({ ratePerDay: '1200', contributorKey: 'res:acme' }),
      comparable({ ratePerDay: '1400', contributorKey: 'res:acme' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:beta' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.contributors).toHaveLength(2);
    // Acme's median, not their cheapest and not their first.
    expect(set.contributors.find((c) => c.key === 'res:acme')?.ratePerDay).toBe('1200.00');
    expect(set.low).toBe('1200.00');
    expect(set.high).toBe('2000.00');
  });

  it('takes the mean of the middle two when a contributor has an even count', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000' }),
      comparable({ ratePerDay: '1500' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.contributors[0]?.ratePerDay).toBe('1250.00');
  });

  it('prefers validated ADX listings once there are enough of them', async () => {
    repository.listingComparables.mockResolvedValue([
      comparable({ ratePerDay: '3000', contributorKey: 'pub:1', tier: 'VALIDATED', origin: 'LISTING' }),
      comparable({ ratePerDay: '3100', contributorKey: 'pub:2', tier: 'VALIDATED', origin: 'LISTING' }),
      comparable({ ratePerDay: '3200', contributorKey: 'pub:3', tier: 'VALIDATED', origin: 'LISTING' }),
    ]);
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', contributorKey: 'res:acme' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.tier).toBe('VALIDATED');
    expect(set.low).toBe('3000.00');
  });

  it('labels a mixed set by its weakest evidence, not its strongest', async () => {
    repository.listingComparables.mockResolvedValue([
      comparable({ ratePerDay: '3000', contributorKey: 'pub:1', tier: 'VALIDATED', origin: 'LISTING' }),
    ]);
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '950', contributorKey: 'res:b' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    // One sale among three contributors is not VALIDATED evidence.
    expect(set.contributors).toHaveLength(3);
    expect(set.tier).toBe('LISTED');
  });

  it('separates the caveat threshold from the ADX takeover threshold', async () => {
    repository.getSettings.mockResolvedValue(
      settings({ thinEvidenceCount: 10, validatedTakeoverCount: 2 })
    );
    repository.listingComparables.mockResolvedValue([
      comparable({ ratePerDay: '3000', contributorKey: 'pub:1', tier: 'VALIDATED', origin: 'LISTING' }),
      comparable({ ratePerDay: '3100', contributorKey: 'pub:2', tier: 'VALIDATED', origin: 'LISTING' }),
    ]);
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', contributorKey: 'res:a' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    // Raising the caveat threshold must not postpone the handover.
    expect(set.tier).toBe('VALIDATED');
    expect(set.low).toBe('3000.00');
  });

  it('falls back to research while ADX has nothing that has sold', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', contributorKey: 'res:acme' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.tier).toBe('LISTED');
    expect(set.low).toBe('900.00');
  });

  it('reaches for a rate card only when nothing better exists', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '750', contributorKey: 'pub:9', tier: 'PROVISIONAL' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.tier).toBe('PROVISIONAL');
  });

  it('ignores a rate card once real evidence is present', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', contributorKey: 'res:acme' }),
      comparable({ ratePerDay: '100', contributorKey: 'pub:9', tier: 'PROVISIONAL' }),
    ]);
    const set = await comparablesFor({ mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE });
    expect(set.contributors).toHaveLength(1);
    expect(set.low).toBe('900.00');
  });

  it('counts stale points but still uses them', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '900', observedAt: new Date('2024-01-01T00:00:00Z') }),
    ]);
    const set = await comparablesFor(
      { mediaTypeId: 'mt', sizeClassId: 'sz', ...HERE },
      new Date('2026-09-08T00:00:00Z')
    );
    expect(set.staleContributors).toBe(1);
    expect(set.low).toBe('900.00');
  });
});

describe('the indicator', () => {
  const threeContributors = [
    comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
    comparable({ ratePerDay: '1500', contributorKey: 'res:b' }),
    comparable({ ratePerDay: '2000', contributorKey: 'res:c' }),
  ];

  it('says nothing when the circle is empty', async () => {
    const result = await evaluatePrice(evaluateInput('1200'));
    expect(result.state).toBe('NO_DATA');
    expect(result.range).toBeNull();
    expect(result.message).toContain('No comparable spots within 200 m');
  });

  it('is happy in the middle of the range', async () => {
    repository.marketDataComparables.mockResolvedValue(threeContributors);
    expect((await evaluatePrice(evaluateInput('1500'))).state).toBe('GOOD');
  });

  it('warns within 5% of the top', async () => {
    repository.marketDataComparables.mockResolvedValue(threeContributors);
    expect((await evaluatePrice(evaluateInput('1900'))).state).toBe('TOO_HIGH');
    expect((await evaluatePrice(evaluateInput('2500'))).state).toBe('TOO_HIGH');
  });

  it('flags the cheap side within 5% of the bottom, without calling it a problem', async () => {
    repository.marketDataComparables.mockResolvedValue(threeContributors);
    const result = await evaluatePrice(evaluateInput('1040'));
    expect(result.state).toBe('LOW_SIDE');
    expect(result.message).toContain('cheaper side');
  });

  it('warns below the bottom of the range', async () => {
    repository.marketDataComparables.mockResolvedValue(threeContributors);
    expect((await evaluatePrice(evaluateInput('900'))).state).toBe('TOO_LOW');
  });

  /**
   * The single-comparable case. The range is a point, so the 5% edges overlap
   * completely and every verdict inside them would be arbitrary. Matching the
   * only nearby spot is GOOD; deviating either way is flagged.
   */
  it('reads a single comparable as a point, not as both extremes at once', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:only' }),
    ]);
    expect((await evaluatePrice(evaluateInput('980'))).state).toBe('TOO_LOW');
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('GOOD');
    expect((await evaluatePrice(evaluateInput('1001'))).state).toBe('TOO_HIGH');
  });

  /**
   * The bug this ordering was rewritten for. Two neighbours priced within 5% of
   * each other make the edge bands overlap; testing the high edge first told a
   * publisher typing the *cheapest* nearby rate that they were at or above the
   * highest. The floor of the range, reported as the ceiling.
   */
  it('does not call the floor of a tight range too expensive', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '1050', contributorKey: 'res:b' }),
    ]);
    // Both edges fire across this whole range; the nearer end decides. The
    // floor reads as cheap and the ceiling as expensive, which is what the
    // numbers actually say — the bug was reporting the floor as the ceiling.
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('LOW_SIDE');
    expect((await evaluatePrice(evaluateInput('1050'))).state).toBe('TOO_HIGH');
    expect((await evaluatePrice(evaluateInput('999'))).state).toBe('TOO_LOW');
    expect((await evaluatePrice(evaluateInput('1051'))).state).toBe('TOO_HIGH');
  });

  /**
   * The band the overlap guard used to swallow. A 8% spread puts the price at
   * the exact top of the market, where only the high edge fires — suppressing
   * both edges because they *could* overlap threw this verdict away.
   */
  it('still flags the ceiling of a moderately tight range', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '1080', contributorKey: 'res:b' }),
    ]);
    expect((await evaluatePrice(evaluateInput('1080'))).state).toBe('TOO_HIGH');
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('LOW_SIDE');
  });

  /**
   * Surge must lift the ceiling and touch nothing else. It used to decide
   * whether the edges applied at all, so an invisible city event could flip a
   * publisher's verdict from GOOD to LOW_SIDE without their price moving.
   */
  it('gives the same verdict at the floor whether or not a window is open', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '1050', contributorKey: 'res:b' }),
    ]);
    const quiet = await evaluatePrice(evaluateInput('1000'));
    repository.activeSurgeWindows.mockResolvedValue([
      {
        id: 'sg_1', name: 'IPL final', scope: 'CITY', source: 'SCRAPER', externalRef: 'x',
        city: 'Mumbai', latitude: null, longitude: null, radiusMeters: null,
        startsAt: new Date('2026-09-01'), endsAt: new Date('2026-09-30'),
        upliftPct: '0.25', isEnabled: true, disabledById: null, disabledAt: null,
        disabledNote: null, isPublic: false, createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const surging = await evaluatePrice(evaluateInput('1000'));
    expect(surging.state).toBe(quiet.state);
  });

  /**
   * The launch-dominant case, and the one two earlier attempts broke: a single
   * comparable, and the publisher types its exact price. Surge lifts the
   * ceiling they are allowed to reach; it says nothing about the market, so it
   * must not turn "this is the going rate" into "this is on the cheaper side"
   * because of an event they cannot even see.
   */
  it('does not turn the going rate into a bargain when a window opens', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:only' }),
    ]);
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('GOOD');
    repository.activeSurgeWindows.mockResolvedValue([
      {
        id: 'sg_1', name: 'General election', scope: 'NATIONAL', source: 'SCRAPER',
        externalRef: 'x', city: null, latitude: null, longitude: null, radiusMeters: null,
        startsAt: new Date('2026-09-01'), endsAt: new Date('2026-09-30'),
        upliftPct: '0.25', isEnabled: true, disabledById: null, disabledAt: null,
        disabledNote: null, isPublic: false, createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('GOOD');
  });

  /** Surge may only ever relax a ceiling warning, never create or move others. */
  it('relaxes a too-high verdict and leaves every other one alone', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '1050', contributorKey: 'res:b' }),
    ]);
    expect((await evaluatePrice(evaluateInput('1030'))).state).toBe('TOO_HIGH');
    repository.activeSurgeWindows.mockResolvedValue([
      {
        id: 'sg_1', name: 'Diwali', scope: 'NATIONAL', source: 'OPS', externalRef: null,
        city: null, latitude: null, longitude: null, radiusMeters: null,
        startsAt: new Date('2026-09-01'), endsAt: new Date('2026-09-30'),
        upliftPct: '0.25', isEnabled: true, disabledById: null, disabledAt: null,
        disabledNote: null, isPublic: true, createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    expect((await evaluatePrice(evaluateInput('1030'))).state).toBe('GOOD');
    // The floor is untouched by the window.
    expect((await evaluatePrice(evaluateInput('999'))).state).toBe('TOO_LOW');
    expect((await evaluatePrice(evaluateInput('1000'))).state).toBe('LOW_SIDE');
  });

  it('admits when it is standing on very little', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    const result = await evaluatePrice(evaluateInput('1500'));
    expect(result.thin).toBe(true);
    expect(result.message).toContain('based on only 2 nearby spots');
  });

  it('drops the caveat once the evidence is comfortable', async () => {
    repository.marketDataComparables.mockResolvedValue([
      ...threeContributors,
      comparable({ ratePerDay: '1600', contributorKey: 'res:d' }),
    ]);
    const result = await evaluatePrice(evaluateInput('1500'));
    expect(result.thin).toBe(false);
    expect(result.message).not.toContain('only');
  });
});

describe('surge', () => {
  const window = (overrides: Record<string, unknown> = {}) => ({
    id: 'sg_1',
    name: 'IPL final',
    scope: 'CITY',
    source: 'SCRAPER',
    externalRef: null,
    city: 'Mumbai',
    citySlug: 'mumbai',
    latitude: null,
    longitude: null,
    radiusMeters: null,
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: new Date('2026-09-30T00:00:00Z'),
    upliftPct: '0.25',
    isEnabled: true,
    disabledById: null,
    disabledAt: null,
    disabledNote: null,
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it('lifts the ceiling rather than the price', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    repository.activeSurgeWindows.mockResolvedValue([window()]);

    const result = await evaluatePrice(evaluateInput('2300'));
    // 2000 would normally be the top; the window lifts it to 2500.
    expect(result.state).toBe('GOOD');
    expect(result.range).toEqual({ low: '1000.00', high: '2000.00' });
    expect(result.effectiveHigh).toBe('2500.00');
    // The window is not public, so the effect shows and the name does not.
    expect(result.surge?.upliftPct).toBe('0.25');
    expect(result.surge?.name).toBeNull();
  });

  /**
   * The schema says national events are surfaced to advertisers and city ones
   * are not. Without this, POST /pricing/evaluate named an unannounced event to
   * anyone with a login — while the comparables beside it were being carefully
   * redacted.
   */
  it('withholds the name of a window that is not public', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    repository.activeSurgeWindows.mockResolvedValue([window({ isPublic: false })]);
    const hidden = await evaluatePrice(evaluateInput('2400'));
    expect(hidden.surge?.name).toBeNull();
    expect(hidden.surge?.id).toBeNull();
    // The effect is still reported: a publisher must be able to see why their
    // ceiling moved, even when they may not see which event moved it.
    expect(hidden.surge?.upliftPct).toBe('0.25');
    expect(hidden.message).not.toContain('IPL final');
  });

  it('names a public window in full', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    repository.activeSurgeWindows.mockResolvedValue([window({ isPublic: true })]);
    const shown = await evaluatePrice(evaluateInput('2400'));
    expect(shown.surge?.name).toBe('IPL final');
    expect(shown.message).toContain('IPL final');
  });

  it('still flags a price above even the lifted ceiling', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    repository.activeSurgeWindows.mockResolvedValue([window()]);
    expect((await evaluatePrice(evaluateInput('2600'))).state).toBe('TOO_HIGH');
  });

  it('applies a national window everywhere', () => {
    expect(
      surgeApplies(window({ scope: 'NATIONAL', city: null, citySlug: null }) as never, {
        ...HERE,
        citySlug: 'chennai',
      })
    ).toBe(true);
  });

  it('keeps a city window inside its city', () => {
    expect(surgeApplies(window() as never, { ...HERE, citySlug: 'chennai' })).toBe(false);
    expect(surgeApplies(window() as never, { ...HERE, citySlug: 'mumbai' })).toBe(true);
  });

  /**
   * The reason cities are a table rather than a string. A window naming
   * Bangalore has to cover spots recorded as Bengaluru — under free-text
   * comparison they were different places, and the window silently covered
   * nobody.
   */
  it('matches a city through its other spellings', () => {
    const resolve = buildCityResolver([
      { slug: 'bengaluru', name: 'Bengaluru', aliases: ['bangalore'] },
    ]);
    const blr = window({ city: 'Bangalore', citySlug: resolve('Bangalore') });
    expect(resolve('Bangalore')).toBe('bengaluru');
    expect(surgeApplies(blr as never, { ...HERE, citySlug: resolve('Bengaluru') })).toBe(true);
    expect(surgeApplies(blr as never, { ...HERE, citySlug: resolve('BENGALURU ') })).toBe(true);
  });

  it('matches nothing when a name resolves to no known city', () => {
    const resolve = buildCityResolver([
      { slug: 'mumbai', name: 'Mumbai', aliases: ['bombay'] },
    ]);
    // Both sides unknown must not collapse into "equal because both null".
    const unknown = window({ city: 'Atlantis', citySlug: resolve('Atlantis') });
    expect(resolve('Atlantis')).toBeNull();
    expect(surgeApplies(unknown as never, { ...HERE, citySlug: resolve('Narnia') })).toBe(false);
  });

  it('keeps a stadium window inside its radius', () => {
    const stadium = window({
      city: null,
      citySlug: null,
      latitude: HERE.latitude,
      longitude: HERE.longitude,
      radiusMeters: 500,
    });
    expect(surgeApplies(stadium as never, { ...NEAR, citySlug: null })).toBe(true);
    expect(surgeApplies(stadium as never, { ...FAR, citySlug: null })).toBe(false);
  });

  it('takes the strongest overlapping window rather than compounding them', async () => {
    repository.marketDataComparables.mockResolvedValue([
      comparable({ ratePerDay: '1000', contributorKey: 'res:a' }),
      comparable({ ratePerDay: '2000', contributorKey: 'res:b' }),
    ]);
    repository.activeSurgeWindows.mockResolvedValue([
      window({ id: 'sg_1', upliftPct: '0.25' }),
      window({ id: 'sg_2', upliftPct: '0.10', name: 'Ganesh Chaturthi' }),
    ]);
    const result = await evaluatePrice(evaluateInput('1500'));
    // 1.25, not 1.25 * 1.10.
    expect(result.effectiveHigh).toBe('2500.00');
  });
});

describe('media type matching', () => {
  const type = (name: string, category = 'OUTDOOR') => ({
    id: `mt_${slugify(name)}`,
    name,
    slug: slugify(name),
    category,
    description: null,
    status: 'ACTIVE',
    origin: 'OPS',
    mergedIntoId: null,
    mergedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('scores nothing across categories however alike the names read', () => {
    expect(
      similarity(
        { name: 'Digital Panel', category: 'TRANSIT' },
        { name: 'Digital Panel', category: 'INDOOR' }
      )
    ).toBe(0);
  });

  it('scores identical names within a category as a full match', () => {
    expect(
      similarity(
        { name: 'Unipole Hoarding', category: 'OUTDOOR' },
        { name: 'Unipole hoarding', category: 'OUTDOOR' }
      )
    ).toBe(1);
  });

  it('does not mint a duplicate over a plural', async () => {
    repository.listMediaTypes.mockResolvedValue([type('Unipole Hoarding')]);
    const result = await matchMediaType({ name: 'Unipole Hoardings', category: 'OUTDOOR' });
    expect(result.outcome).toBe('MATCHED');
    expect(repository.createMediaType).not.toHaveBeenCalled();
  });

  it('creates when the names genuinely differ, and logs that it did', async () => {
    repository.listMediaTypes.mockResolvedValue([type('Unipole Hoarding')]);
    repository.findMediaTypeBySlug.mockResolvedValue(null);
    repository.createMediaType.mockResolvedValue(type('Bus Shelter Panel'));
    const result = await matchMediaType({ name: 'Bus Shelter Panel', category: 'OUTDOOR' });
    expect(result.outcome).toBe('CREATED');
    expect(repository.logMediaTypeMatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'CREATED' })
    );
  });

  it('keeps singularisation short of stemming', () => {
    // "hoarding" collapsing to "hoard" would match things that are not alike.
    expect(
      similarity(
        { name: 'Hoarding', category: 'OUTDOOR' },
        { name: 'Hoard', category: 'OUTDOOR' }
      )
    ).toBe(0);
  });

  it('matches when the threshold is met and logs the decision', async () => {
    repository.listMediaTypes.mockResolvedValue([type('Backlit Unipole Hoarding')]);
    const result = await matchMediaType({
      name: 'Backlit Unipole Hoarding',
      category: 'OUTDOOR',
    });
    expect(result.outcome).toBe('MATCHED');
    expect(result.similarity).toBe(1);
    expect(repository.createMediaType).not.toHaveBeenCalled();
    expect(repository.logMediaTypeMatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'MATCHED', similarity: 1 })
    );
  });

  it('records an unrecognised name for ops when it creates one', async () => {
    repository.listMediaTypes.mockResolvedValue([]);
    repository.findMediaTypeBySlug.mockResolvedValue(null);
    repository.createMediaType.mockResolvedValue(type('Gantry'));
    await matchMediaType({ name: 'Gantry', category: 'OUTDOOR' });
    expect(repository.recordVocabularyProposal).toHaveBeenCalledWith(
      'MEDIA_TYPE',
      'Gantry',
      expect.anything()
    );
  });

  it('refuses to merge across categories', async () => {
    repository.findMediaType
      .mockResolvedValueOnce(type('Bus Panel', 'TRANSIT'))
      .mockResolvedValueOnce(type('Mall Panel', 'INDOOR'));
    await expect(mergeMediaTypes('a', 'b')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to merge into a tombstone', async () => {
    repository.findMediaType
      .mockResolvedValueOnce(type('Bus Panel', 'TRANSIT'))
      .mockResolvedValueOnce({ ...type('Old Panel', 'TRANSIT'), status: 'MERGED' });
    await expect(mergeMediaTypes('a', 'b')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to merge a type into itself', async () => {
    await expect(mergeMediaTypes('same', 'same')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('factor predicates', () => {
  const facts = { city: 'Mumbai', material: 'vinyl', latitude: 19.07 };

  it('reads equality and membership', () => {
    expect(evaluatePredicate({ field: 'city', eq: 'Mumbai' }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'city', in: ['Delhi', 'Mumbai'] }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'city', in: ['Delhi'] }, facts)).toBe(false);
  });

  it('joins with all, any and not', () => {
    expect(
      evaluatePredicate(
        { all: [{ field: 'city', eq: 'Mumbai' }, { field: 'material', eq: 'vinyl' }] },
        facts
      )
    ).toBe(true);
    expect(
      evaluatePredicate({ any: [{ field: 'city', eq: 'Delhi' }, { field: 'material', eq: 'vinyl' }] }, facts)
    ).toBe(true);
    expect(evaluatePredicate({ not: { field: 'city', eq: 'Delhi' } }, facts)).toBe(true);
  });

  it('compares numbers and refuses to guess at non-numbers', () => {
    expect(evaluatePredicate({ field: 'latitude', gt: 19 }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'city', gt: 19 }, facts)).toBe(false);
  });

  it('treats a malformed rule as not matching rather than throwing', () => {
    expect(evaluatePredicate(null, facts)).toBe(false);
    expect(evaluatePredicate({ nonsense: true }, facts)).toBe(false);
    expect(evaluatePredicate('drop table', facts)).toBe(false);
  });
});

describe('market data import', () => {
  const mediaType = {
    id: 'mt_1',
    slug: 'unipole-hoarding',
    status: 'ACTIVE',
    name: 'Unipole Hoarding',
    category: 'OUTDOOR',
  };
  const sizeClass = { id: 'sz_1', slug: '20x10' };

  const row = (overrides: Record<string, unknown> = {}) => ({
    contributorName: 'Acme Outdoor',
    mediaTypeSlug: 'unipole-hoarding',
    sizeClassSlug: '20x10',
    latitude: 19.076,
    longitude: 72.8777,
    ratePerDay: '1200',
    observedAt: '2026-08-01',
    ...overrides,
  });

  beforeEach(() => {
    repository.createImport.mockResolvedValue({ id: 'imp_1' });
    repository.listMediaTypes.mockResolvedValue([mediaType]);
    repository.listSizeClasses.mockResolvedValue([sizeClass]);
    repository.listMaterials.mockResolvedValue([]);
    repository.listVenueTypes.mockResolvedValue([]);
    repository.insertMarketDataPoints.mockImplementation(async (points: unknown[]) => points.length);
  });

  it('accepts clean rows and keys the contributor by competitor', async () => {
    const result = await importMarketData({
      source: 'RESEARCH',
      filename: 'mumbai.csv',
      note: null,
      uploadedById: 'usr_1',
      rows: [row(), row({ contributorName: 'Beta Media' })],
    });
    expect(result.acceptedCount).toBe(2);
    const [points] = repository.insertMarketDataPoints.mock.calls[0] as [
      { contributorKey: string }[],
    ];
    expect(points.map((p) => p.contributorKey)).toEqual(['res:acme-outdoor', 'res:beta-media']);
  });

  it('rejects an unknown media type with a reason and logs it for ops', async () => {
    const result = await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: 'usr_1',
      rows: [row({ mediaTypeSlug: 'gantry' })],
    });
    expect(result.acceptedCount).toBe(0);
    expect(result.rejections[0]?.reason).toContain('Unknown media type');
    expect(repository.recordVocabularyProposal).toHaveBeenCalledWith(
      'MEDIA_TYPE',
      'gantry',
      expect.anything()
    );
  });

  it('rejects a row pointing at a merged-away media type', async () => {
    repository.listMediaTypes.mockResolvedValue([{ ...mediaType, status: 'MERGED' }]);
    const result = await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: 'usr_1',
      rows: [row()],
    });
    expect(result.rejections[0]?.reason).toContain('merged away');
  });

  it('rejects an unreadable date rather than silently dating it today', async () => {
    const result = await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: 'usr_1',
      rows: [row({ observedAt: 'last summer' })],
    });
    expect(result.rejections[0]?.reason).toContain('Unreadable observation date');
  });

  it('keys a rate card by publisher so they cannot also speak as a competitor', async () => {
    await importMarketData({
      source: 'RATE_CARD',
      filename: null,
      note: null,
      uploadedById: 'usr_1',
      publisherId: 'pub_7',
      rows: [row()],
    });
    const [points] = repository.insertMarketDataPoints.mock.calls[0] as [
      { contributorKey: string }[],
    ];
    expect(points[0]?.contributorKey).toBe('pub:pub_7');
  });

  it('refuses a rate card that names no publisher', async () => {
    await expect(
      importMarketData({
        source: 'RATE_CARD',
        filename: null,
        note: null,
        uploadedById: 'usr_1',
        rows: [row()],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('records the counts on the batch even when everything failed', async () => {
    await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: 'usr_1',
      rows: [row({ sizeClassSlug: 'unknown' })],
    });
    expect(repository.finishImport).toHaveBeenCalledWith(
      'imp_1',
      { rowCount: 1, acceptedCount: 0, rejectedCount: 1 },
      expect.anything()
    );
  });
});

/**
 * The venue, and where a spot's dimensions turn into a class.
 *
 * `classifySpot` is the one place a listing becomes comparable, so it is also
 * the one place these can go wrong. Venue is the coarsest cut in the match key
 * and the easiest to lose silently: an omitted venue is not "any venue", it is
 * the pool of spots that have none, and an indoor listing that lands there is
 * compared against roadside hoardings for the rest of its life.
 */
describe('classifying a spot', () => {
  const vocabulary = () => {
    repository.listMediaTypes.mockResolvedValue([]);
    repository.listSizeClasses.mockResolvedValue([]);
    repository.listMaterials.mockResolvedValue([]);
    repository.listVenueTypes.mockResolvedValue([
      { id: 'vt_gym', slug: 'gyms-fitness-clubs', name: 'Gyms', category: 'INDOOR', isActive: true },
      // Retired. Its id still resolves — a patch echoing back a listing's own
      // venue must not 400 the day ops retire it — but its slug does not, so no
      // new spot can be filed there.
      { id: 'vt_old', slug: 'bowling-alleys', name: 'Bowling', category: 'INDOOR', isActive: false },
    ]);
    // The vocabulary check reads the list; the resolution reads one row. Both
    // are active-only, which is what keeps a retired venue from quietly
    // accepting new listings.
    repository.findVenueTypeBySlug.mockImplementation(async (slug: string) =>
      slug === 'gyms-fitness-clubs' ? { id: 'vt_gym', slug, name: 'Gyms' } : null
    );
  };

  beforeEach(vocabulary);

  it('resolves a venue slug to its id', async () => {
    const result = await classifySpot({
      category: 'INDOOR',
      venueTypeSlug: 'gyms-fitness-clubs',
    });
    expect(result.venueTypeId).toBe('vt_gym');
  });

  it('prefers an id over a slug, because an id is a decision already taken', async () => {
    const result = await classifySpot({
      category: 'INDOOR',
      venueTypeId: 'vt_gym',
      venueTypeSlug: 'gyms-fitness-clubs',
    });
    expect(result.venueTypeId).toBe('vt_gym');
    expect(repository.findVenueTypeBySlug).not.toHaveBeenCalled();
  });

  /**
   * Rejected rather than filed venue-less. A venue nobody recognises is a
   * vocabulary gap ops should see; dropping it would file the spot in the wrong
   * pool and report nothing.
   */
  it('refuses an unknown venue and records it for ops', async () => {
    await expect(
      classifySpot({ category: 'INDOOR', venueTypeSlug: 'trampoline-park' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a venue id that does not exist rather than letting it reach a foreign key', async () => {
    await expect(
      classifySpot({ category: 'INDOOR', venueTypeId: 'vt_missing' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  /**
   * A retired venue takes no new spots, but the listings already in it stay
   * editable. Validating ids the same way as slugs made a listing uneditable
   * the day ops retired its venue, with a message saying its own venue does not
   * exist — and the only field it was echoing back was one it already held.
   */
  it('keeps accepting the id of a retired venue while refusing its slug', async () => {
    const kept = await classifySpot({ category: 'INDOOR', venueTypeId: 'vt_old' });
    expect(kept.venueTypeId).toBe('vt_old');
    await expect(
      classifySpot({ category: 'INDOOR', venueTypeSlug: 'bowling-alleys' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  /** DR 02 measures a spot; the class is derived the way a media type is. */
  it('derives a size class from the dimensions when none was named', async () => {
    repository.resolveSizeClassForDimensions.mockResolvedValue({ id: 'sz_6x4' });
    const result = await classifySpot({ category: 'INDOOR', widthFt: '6', heightFt: '4' });
    // The tolerance travels with the measurement: how coarsely the market is
    // cut is a pricing judgement, so it comes from settings rather than being
    // baked into the query.
    expect(repository.resolveSizeClassForDimensions).toHaveBeenCalledWith('6', '4', '0.03');
    expect(result.sizeClassId).toBe('sz_6x4');
    expect(result.derivedFromDimensions).toBe(true);
  });

  /** A measurement must not overrule a decision somebody already took. */
  it('leaves a named class alone even when dimensions are supplied', async () => {
    repository.listSizeClasses.mockResolvedValue([{ id: 'sz_chosen', slug: '20x10' }]);
    const result = await classifySpot({
      category: 'INDOOR',
      sizeClassId: 'sz_chosen',
      widthFt: '6',
      heightFt: '4',
    });
    expect(repository.resolveSizeClassForDimensions).not.toHaveBeenCalled();
    expect(result.sizeClassId).toBe('sz_chosen');
    expect(result.derivedFromDimensions).toBe(false);
  });

  it('needs both sides of the tape before it derives anything', async () => {
    const result = await classifySpot({ category: 'INDOOR', widthFt: '6' });
    expect(repository.resolveSizeClassForDimensions).not.toHaveBeenCalled();
    expect(result.sizeClassId).toBeNull();
  });
});

/**
 * A sweep with no Venue column is not a sweep of venue-less spots.
 *
 * The format already knows which venue it lives in, so the import takes the
 * answer from there. Without that, a research file of mall LED walls filed every
 * observation at `venueTypeId: null` while every console-created mall listing
 * carried the mall — two halves of the same market that could never meet.
 */
describe('market data and the venue it belongs to', () => {
  const venue = { id: 'vt_mall', slug: 'shopping-malls', name: 'Malls', category: 'INDOOR', isActive: true };
  const mediaType = {
    id: 'mt_1',
    slug: 'mall-led-wall',
    status: 'ACTIVE',
    name: 'Atrium LED Wall',
    category: 'INDOOR',
    venueTypeId: 'vt_mall',
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    contributorName: 'Acme Outdoor',
    mediaTypeSlug: 'mall-led-wall',
    sizeClassSlug: '20x10',
    latitude: 19.076,
    longitude: 72.8777,
    ratePerDay: '1200',
    observedAt: '2026-08-01',
    ...overrides,
  });

  beforeEach(() => {
    repository.createImport.mockResolvedValue({ id: 'imp_1' });
    repository.listMediaTypes.mockResolvedValue([mediaType]);
    repository.listSizeClasses.mockResolvedValue([{ id: 'sz_1', slug: '20x10' }]);
    repository.listMaterials.mockResolvedValue([]);
    repository.listVenueTypes.mockResolvedValue([venue]);
    repository.insertMarketDataPoints.mockImplementation(async (points: unknown[]) => points.length);
  });

  it('takes the venue from the format when the sheet does not name one', async () => {
    await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: null,
      rows: [row()],
    });
    const [points] = repository.insertMarketDataPoints.mock.calls[0] as [
      { venueTypeId: string | null }[],
    ];
    expect(points[0]?.venueTypeId).toBe('vt_mall');
  });

  it('rejects a row whose named venue disagrees with the format', async () => {
    repository.listVenueTypes.mockResolvedValue([
      venue,
      { id: 'vt_gym', slug: 'gyms', name: 'Gyms', category: 'INDOOR', isActive: true },
    ]);
    const result = await importMarketData({
      source: 'RESEARCH',
      filename: null,
      note: null,
      uploadedById: null,
      rows: [row({ venueTypeSlug: 'gyms' })],
    });
    expect(result.acceptedCount).toBe(0);
    expect(result.rejections[0]?.reason).toMatch(/different venue/);
  });
});

/**
 * A name matched against the taxonomy is matched within its own venue.
 *
 * A mall's floor graphic and a hospital's score identically on name. Matching
 * across the two files one venue's spot under the other's type — the same pool
 * split the venue level exists to prevent, arrived at from the other side.
 */
describe('matching a media type by name', () => {
  const inMall = { id: 'mt_mall', name: 'Floor Graphics', slug: 'mall-floor', category: 'INDOOR', status: 'ACTIVE', venueTypeId: 'vt_mall' };

  beforeEach(() => {
    repository.listMediaTypes.mockResolvedValue([inMall]);
    repository.createMediaType.mockImplementation(async (data: Record<string, unknown>) => ({
      id: 'mt_new',
      ...data,
    }));
    repository.findMediaTypeBySlug.mockResolvedValue(null);
  });

  it('matches within the venue', async () => {
    const result = await matchMediaType({
      name: 'Floor Graphic',
      category: 'INDOOR',
      venueTypeId: 'vt_mall',
    });
    expect(result.outcome).toBe('MATCHED');
    expect(result.mediaType.id).toBe('mt_mall');
  });

  it('mints a new type rather than borrowing another venue name-alike', async () => {
    const result = await matchMediaType({
      name: 'Floor Graphic',
      category: 'INDOOR',
      venueTypeId: 'vt_hospital',
    });
    expect(result.outcome).toBe('CREATED');
    expect(repository.createMediaType).toHaveBeenCalledWith(
      expect.objectContaining({ venueTypeId: 'vt_hospital' })
    );
  });
});
