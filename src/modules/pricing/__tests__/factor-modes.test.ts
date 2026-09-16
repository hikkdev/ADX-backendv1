import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q59/Q125): a factor is ADVISORY or BINDING.
 *
 * ADVISORY is what every factor was before the lot: applying it records a
 * proposal and the publisher decides whether to take the offer. BINDING
 * reprices the listing when applied — through the listing module's own
 * update path, never a direct write — and only within the cap
 * `maxBindingChangePct` draws; a move above the cap is refused and a price
 * case is raised instead, so a person still decides the big ones. A factor
 * flagged `bindingDuringSurgeOnly` binds only while a surge window covers
 * the listing and is advisory the rest of the time.
 */

const { repository, port, logActivity, createNotification } = vi.hoisted(() => ({
  repository: {
    getSettings: vi.fn(),
    findFactor: vi.fn(),
    listFactors: vi.fn(),
    listingContext: vi.fn(),
    listingFactorApplications: vi.fn(),
    setFactorApplied: vi.fn(),
    listingComparables: vi.fn(),
    marketDataComparables: vi.fn(),
    activeSurgeWindows: vi.fn(),
    listCities: vi.fn(),
    publisherUserId: vi.fn(),
  },
  port: { reprice: vi.fn(), raisePriceCase: vi.fn() },
  logActivity: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('../prisma-pricing.repository', () => ({ prismaPricingRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity,
}));
vi.mock('../../notifications', () => ({ createNotification }));

import { SETTINGS_FALLBACK, setFactorApplied, suggestedRate } from '../pricing.service';
import { registerListingRepricePort, resetListingRepricePort } from '../listing-reprice.port';

const HERE = { latitude: 19.076, longitude: 72.8777 };

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisherId: 'pub_1',
  venueTypeId: null,
  mediaTypeId: 'mt_1',
  sizeClassId: 'sz_1',
  materialId: null,
  ...HERE,
  city: 'Mumbai',
  category: 'OUTDOOR',
  ratePerDay: '10000.00',
  mediaTypeSlug: 'hoarding',
  sizeClassSlug: '20x10',
  materialSlug: null,
  illumination: null,
  facing: null,
  elevation: null,
  visibility: null,
  trafficGrade: null,
  areaSqFt: null,
  ...over,
});

const factor = (over: Record<string, unknown> = {}) => ({
  id: 'f_1',
  name: 'Corner site',
  slug: 'corner-site',
  description: null,
  kind: 'MULTIPLIER',
  mediaTypeId: 'mt_1',
  multiplier: '1.15',
  baseAdjust: null,
  suggestWhen: null,
  mode: 'ADVISORY',
  bindingDuringSurgeOnly: false,
  isActive: true,
  ...over,
});

/** Two research points at 9,000 and 11,000 a day: the base is their midpoint, 10,000. */
const marketRows = () => [
  {
    id: 'md_1',
    contributorKey: 'res:acme',
    contributorName: 'Acme',
    ratePerDay: '9000.00',
    ...HERE,
    distanceMeters: 0,
    observedAt: new Date('2026-08-01T00:00:00Z'),
    tier: 'LISTED',
    origin: 'MARKET_DATA',
    label: null,
  },
  {
    id: 'md_2',
    contributorKey: 'res:bravo',
    contributorName: 'Bravo',
    ratePerDay: '11000.00',
    ...HERE,
    distanceMeters: 0,
    observedAt: new Date('2026-08-01T00:00:00Z'),
    tier: 'LISTED',
    origin: 'MARKET_DATA',
    label: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  registerListingRepricePort(port);
  repository.getSettings.mockResolvedValue({
    id: 'default',
    ...SETTINGS_FALLBACK,
    maxBindingChangePct: '0.25',
    updatedAt: new Date(),
    updatedById: null,
  });
  repository.listingContext.mockResolvedValue(listing());
  repository.findFactor.mockResolvedValue(factor());
  repository.listFactors.mockResolvedValue([factor()]);
  // `factorProposals` is re-read after the write, so the application the
  // service just recorded is what the second read returns.
  repository.listingFactorApplications.mockResolvedValue([]);
  repository.setFactorApplied.mockImplementation(async (_l: string, factorId: string, applied: boolean) => {
    repository.listingFactorApplications.mockResolvedValue([{ factorId, suggested: false, applied }]);
  });
  repository.listingComparables.mockResolvedValue([]);
  repository.marketDataComparables.mockResolvedValue(marketRows());
  repository.activeSurgeWindows.mockResolvedValue([]);
  repository.listCities.mockResolvedValue([{ slug: 'mumbai', name: 'Mumbai', aliases: ['bombay'] }]);
  repository.publisherUserId.mockResolvedValue('usr_pub');
  createNotification.mockResolvedValue(undefined);
  port.reprice.mockResolvedValue(undefined);
  port.raisePriceCase.mockResolvedValue({ id: 'pa_1' });
});

afterEach(() => {
  resetListingRepricePort();
});

describe('an ADVISORY factor', () => {
  it('records the proposal and touches no price', async () => {
    const proposals = await setFactorApplied('lst_1', 'f_1', true, 'usr_admin');

    expect(repository.setFactorApplied).toHaveBeenCalledWith('lst_1', 'f_1', true, 'usr_admin', null);
    expect(port.reprice).not.toHaveBeenCalled();
    expect(port.raisePriceCase).not.toHaveBeenCalled();
    expect(proposals.find((p) => p.factorId === 'f_1')).toMatchObject({ applied: true, mode: 'ADVISORY' });
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_FACTOR_APPLIED',
      expect.objectContaining({ targetType: 'Listing', targetId: 'lst_1', module: 'pricing' })
    );
  });
});

describe('a BINDING factor', () => {
  beforeEach(() => {
    repository.findFactor.mockResolvedValue(factor({ mode: 'BINDING' }));
    repository.listFactors.mockResolvedValue([factor({ mode: 'BINDING' })]);
  });

  it('reprices through the listing write path and stamps the rate it wrote', async () => {
    await setFactorApplied('lst_1', 'f_1', true, 'usr_admin');

    // 10,000 x 1.15 — inside the 25% cap.
    expect(port.reprice).toHaveBeenCalledWith({ listingId: 'lst_1', ratePerDay: '11500.00', actorUserId: 'usr_admin' });
    expect(repository.setFactorApplied).toHaveBeenCalledWith('lst_1', 'f_1', true, 'usr_admin', '11500.00');
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_REPRICED_BY_FACTOR',
      expect.objectContaining({
        targetType: 'Listing',
        targetId: 'lst_1',
        diff: { ratePerDay: { before: '10000.00', after: '11500.00' } },
      })
    );
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', type: 'SYSTEM' }));
  });

  it('refuses a move above the cap and raises a price case instead', async () => {
    repository.findFactor.mockResolvedValue(factor({ mode: 'BINDING', multiplier: '1.5' }));
    repository.listFactors.mockResolvedValue([factor({ mode: 'BINDING', multiplier: '1.5' })]);

    // 10,000 -> 15,000 is a 50% move; the cap is 25%.
    await expect(setFactorApplied('lst_1', 'f_1', true, 'usr_admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'BINDING_CHANGE_TOO_LARGE',
    });
    expect(port.raisePriceCase).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'lst_1',
        requestedRatePerDay: '15000.00',
        requestedById: 'usr_admin',
        reason: expect.stringContaining('binding factor exceeded cap'),
      })
    );
    // Nothing was written: the factor stays unapplied and the price stands.
    expect(port.reprice).not.toHaveBeenCalled();
    expect(repository.setFactorApplied).not.toHaveBeenCalled();
  });

  it('is measured against the cap exactly — a move of the cap itself passes', async () => {
    repository.findFactor.mockResolvedValue(factor({ mode: 'BINDING', multiplier: '1.25' }));
    repository.listFactors.mockResolvedValue([factor({ mode: 'BINDING', multiplier: '1.25' })]);
    await setFactorApplied('lst_1', 'f_1', true, 'usr_admin');
    expect(port.reprice).toHaveBeenCalledWith(expect.objectContaining({ ratePerDay: '12500.00' }));
  });

  it('un-applying reprices back, so the price never keeps a factor nobody applied', async () => {
    repository.listingFactorApplications.mockResolvedValue([{ factorId: 'f_1', suggested: false, applied: true }]);
    repository.listingContext.mockResolvedValue(listing({ ratePerDay: '11500.00' }));

    await setFactorApplied('lst_1', 'f_1', false, 'usr_admin');

    expect(port.reprice).toHaveBeenCalledWith(expect.objectContaining({ ratePerDay: '10000.00' }));
    expect(repository.setFactorApplied).toHaveBeenCalledWith('lst_1', 'f_1', false, 'usr_admin', null);
  });

  it('refuses when the listing has no comparables to build a base from', async () => {
    repository.marketDataComparables.mockResolvedValue([]);
    await expect(setFactorApplied('lst_1', 'f_1', true, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    expect(port.reprice).not.toHaveBeenCalled();
    expect(repository.setFactorApplied).not.toHaveBeenCalled();
  });
});

describe('a factor that binds only during a surge', () => {
  const surgeOnly = factor({ mode: 'BINDING', bindingDuringSurgeOnly: true, multiplier: '1.10' });

  beforeEach(() => {
    repository.findFactor.mockResolvedValue(surgeOnly);
    repository.listFactors.mockResolvedValue([surgeOnly]);
  });

  it('is advisory when no window covers the listing', async () => {
    await setFactorApplied('lst_1', 'f_1', true, 'usr_admin');
    expect(port.reprice).not.toHaveBeenCalled();
    expect(repository.setFactorApplied).toHaveBeenCalledWith('lst_1', 'f_1', true, 'usr_admin', null);
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_FACTOR_APPLIED',
      expect.objectContaining({ metadata: expect.objectContaining({ binding: false }) })
    );
  });

  it('binds while a window covers the listing', async () => {
    repository.activeSurgeWindows.mockResolvedValue([
      {
        id: 'se_1',
        name: 'IPL final',
        scope: 'NATIONAL',
        upliftPct: '0.20',
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86_400_000),
        isPublic: true,
        latitude: null,
        longitude: null,
        radiusMeters: null,
        citySlug: null,
      },
    ]);
    await setFactorApplied('lst_1', 'f_1', true, 'usr_admin');
    expect(port.reprice).toHaveBeenCalledWith(expect.objectContaining({ ratePerDay: '11000.00' }));
  });
});

describe('the suggested rate', () => {
  it('names each applied factor with its mode, so the offer says which ones already moved the price', async () => {
    repository.listFactors.mockResolvedValue([factor(), factor({ id: 'f_2', slug: 'lit', name: 'Back-lit', mode: 'BINDING' })]);
    repository.listingFactorApplications.mockResolvedValue([
      { factorId: 'f_1', suggested: false, applied: true },
      { factorId: 'f_2', suggested: false, applied: true },
    ]);
    const offer = await suggestedRate('lst_1');
    expect(offer.base).toBe('10000.00');
    expect(offer.applied).toEqual([
      { name: 'Corner site', kind: 'MULTIPLIER', value: '1.15', mode: 'ADVISORY' },
      { name: 'Back-lit', kind: 'MULTIPLIER', value: '1.15', mode: 'BINDING' },
    ]);
  });
});
