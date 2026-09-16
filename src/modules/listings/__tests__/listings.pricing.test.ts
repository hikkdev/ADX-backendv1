import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam between a listing and the pricing engine.
 *
 * Everything here was absent when the engine first landed: nothing wrote
 * `ratePerDay`, nothing classified a spot, and nothing recorded whether a price
 * was set during a surge window. The engine was internally coherent and
 * externally unwired, so its ADX half could never fire.
 */

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
}));

const classifySpot = vi.hoisted(() => vi.fn());
const activeSurge = vi.hoisted(() => vi.fn());
/* Lot A (Q31): create asks the city table whether ADX is open there. Every
   city in this suite is one it has never heard of, which is allowed. */
const assertCityAllows = vi.hoisted(() => vi.fn());

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
/** Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns. */
const cityKeyFor = vi.hoisted(() => async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null));
const withCityKey = vi.hoisted(() => async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }));
vi.mock('../../pricing', () => ({ classifySpot, activeSurge, assertCityAllows, cityKeyFor, withCityKey }));

import { createListing, updateListing } from '../listings.service';
import { createListingSchema, updateListingSchema } from '../listings.schema';

const NOTHING_CLASSIFIED = {
  venueTypeId: null,
  mediaTypeId: null,
  sizeClassId: null,
  materialId: null,
  derivedFromDimensions: false,
};

const draft = (overrides: Record<string, unknown> = {}) => ({
  publisherId: 'pub_1',
  agentId: 'agt_1',
  title: 'Andheri East hoarding',
  category: 'OUTDOOR' as const,
  address: 'Western Express Highway',
  city: 'Mumbai',
  latitude: 19.076,
  longitude: 72.8777,
  monthlyPrice: 36000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  activeSurge.mockResolvedValue(null);
  classifySpot.mockResolvedValue(NOTHING_CLASSIFIED);
  repository.create.mockImplementation(async (data: unknown) => data);
});

describe('rate normalisation', () => {
  it('derives the daily rate from the deprecated monthly one', async () => {
    await createListing(draft());
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ratePerDay: '1200.00' })
    );
  });

  it('prefers an explicit daily rate and keeps it exact', async () => {
    await createListing(draft({ ratePerDay: '1249.99', monthlyPrice: undefined }));
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ratePerDay: '1249.99' })
    );
  });

  it('refuses a listing with no price at all', async () => {
    await expect(
      createListing(draft({ monthlyPrice: undefined, ratePerDay: undefined }))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('never lets a monthly float reach the caller as a rate', async () => {
    // 1000/30 is 33.333…; the wire format has to be a fixed two-decimal string,
    // not a binary float that renders differently on every screen.
    await createListing(draft({ monthlyPrice: 1000 }));
    const [data] = repository.create.mock.calls[0] as [{ ratePerDay: string }];
    expect(data.ratePerDay).toBe('33.33');
    expect(typeof data.ratePerDay).toBe('string');
  });

  /**
   * The compatibility path the dual-field shape exists to protect. Deriving the
   * monthly figure back from a 2dp daily rate returned 999.9 for an input of
   * 1000, so a legacy client posting a price and reading it back got a
   * different number than it sent.
   */
  it('passes a caller-supplied monthly price through untouched', async () => {
    await createListing(draft({ monthlyPrice: 1000 }));
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyPrice: 1000 })
    );
  });

  it('refuses a price that rounds away to nothing', async () => {
    // 0.01 a month is 0.0003 a day, which rounds to zero and would trip the
    // positivity CHECK as a 500 rather than arriving as a 400.
    await expect(createListing(draft({ monthlyPrice: 0.01 }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('spot classification', () => {
  it('hands the whole description to the engine, names and slugs together', async () => {
    classifySpot.mockResolvedValue({
      mediaTypeId: 'mt_unipole',
      sizeClassId: 'sz_20x10',
      materialId: 'mat_flex',
    });
    await createListing(
      draft({ mediaTypeName: 'Unipole Hoarding', sizeClassSlug: '20x10', materialSlug: 'flex' })
    );
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'OUTDOOR',
        mediaTypeName: 'Unipole Hoarding',
        sizeClassSlug: '20x10',
        materialSlug: 'flex',
      })
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypeId: 'mt_unipole',
        sizeClassId: 'sz_20x10',
        materialId: 'mat_flex',
      })
    );
  });

  /**
   * The match key is not partial. A listing carrying a media type but no size
   * class never enters any pool, so a half-classification would look like a
   * working listing that the indicator silently ignores.
   */
  it('leaves an unclassified listing unclassified rather than guessing', async () => {
    await createListing(draft());
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['mediaTypeId']).toBeUndefined();
    expect(data['sizeClassId']).toBeUndefined();
  });

  it('never lets a resolved slug reach the repository as a column', async () => {
    await createListing(draft({ sizeClassSlug: '20x10', materialSlug: 'flex' }));
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['sizeClassSlug']).toBeUndefined();
    expect(data['materialSlug']).toBeUndefined();
  });
});

describe('surge provenance', () => {
  const ENDS = new Date('2026-09-30T00:00:00Z');
  const COVER_UNTIL = new Date('2026-11-30T00:00:00Z');

  /**
   * A timestamp, not a flag. The exclusion has to expire: a NATIONAL window
   * covers every spot in the country, so a permanent mark would remove every
   * listing priced during one election from every pool, for good.
   *
   * And it is `coverUntil`, not `endsAt`. A price set during a one-day final
   * that overlaps a three-month festive window has to stay out of the pool for
   * the whole three months, even though the advertiser is told about the final.
   */
  it('excludes until the last covering window closes, not the strongest one', async () => {
    activeSurge.mockResolvedValue({
      id: 'sg_1',
      name: 'IPL final',
      upliftPct: '0.25',
      endsAt: ENDS,
      coverUntil: COVER_UNTIL,
    });
    await createListing(draft());
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ratePerDaySurgeUntil: COVER_UNTIL })
    );
  });

  it('leaves an ordinary rate unmarked', async () => {
    await createListing(draft());
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ratePerDaySurgeUntil: null })
    );
  });

  it('does not ask about surge for a spot with no coordinates', async () => {
    await createListing(draft({ latitude: undefined, longitude: undefined }));
    expect(activeSurge).not.toHaveBeenCalled();
  });

  /**
   * Editing a price during a window is exactly what the indicator invites, so
   * an edit has to be marked the same way a create is — otherwise raising a
   * rate is a route into everyone else's baseline that creating one is not.
   */
  it('re-marks provenance when a price is edited during a window', async () => {
    repository.findById.mockResolvedValue({
      id: 'lst_1',
      latitude: 19.076,
      longitude: 72.8777,
      city: 'Mumbai',
    });
    activeSurge.mockResolvedValue({
      id: 'sg_1',
      name: 'Ganesh Chaturthi',
      upliftPct: '0.15',
      endsAt: ENDS,
      coverUntil: ENDS,
    });
    await updateListing('lst_1', { ratePerDay: '1500' });
    // The stored unit and figure are rewritten to match. They exist so the
    // publisher reads back the number they typed, which only holds while they
    // still derive the rate — "150 per sq ft per month" printed beside a rate
    // that no longer comes from it is worse than no figure at all.
    expect(repository.update).toHaveBeenCalledWith('lst_1', {
      ratePerDay: '1500.00',
      pricingUnit: 'PER_DAY',
      basePrice: '1500.00',
      ratePerDaySurgeUntil: ENDS,
    });
  });

  it('leaves the rate alone on a patch that does not touch it', async () => {
    await updateListing('lst_1', { title: 'Renamed' });
    // The listing is still read — an unknown id has to answer 404 whichever
    // field the caller touched — but nothing about the price is reconsidered,
    // so no surge window is consulted and no rate reaches the update.
    expect(activeSurge).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('lst_1', { title: 'Renamed' });
  });

  it('answers 404 on a patch that touches no priced field', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(updateListing('lst_missing', { title: 'Renamed' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

/**
 * Classifying after the fact. Without this, every listing predating the engine
 * is permanently outside every comparable pool, and the whole feature only
 * applies to spots created after one particular deploy.
 */
describe('classifying an existing listing', () => {
  beforeEach(() => {
    repository.findById.mockResolvedValue({
      id: 'lst_1',
      category: 'OUTDOOR',
      latitude: 19.076,
      longitude: 72.8777,
      city: 'Mumbai',
    });
  });

  it('resolves a classification patch without touching the price', async () => {
    classifySpot.mockResolvedValue({
      mediaTypeId: 'mt_unipole',
      sizeClassId: 'sz_20x10',
      materialId: null,
    });
    await updateListing('lst_1', { mediaTypeName: 'Unipole Hoarding', sizeClassSlug: '20x10' });
    expect(repository.update).toHaveBeenCalledWith('lst_1', {
      mediaTypeId: 'mt_unipole',
      sizeClassId: 'sz_20x10',
    });
  });

  it('gates the media-type threshold on the listing existing category', async () => {
    classifySpot.mockResolvedValue(NOTHING_CLASSIFIED);
    await updateListing('lst_1', { mediaTypeName: 'Gantry' });
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'OUTDOOR', listingId: 'lst_1' })
    );
  });

  it('never lets a slug through to the repository as a column', async () => {
    classifySpot.mockResolvedValue(NOTHING_CLASSIFIED);
    await updateListing('lst_1', { sizeClassSlug: '20x10', materialSlug: 'flex' });
    const [, data] = repository.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(data['sizeClassSlug']).toBeUndefined();
    expect(data['materialSlug']).toBeUndefined();
  });
});

/**
 * The four things DR 02 collects that nothing used to store.
 *
 * Every one of them had a column, a repository field, an index and a test —
 * and no writer. The schema said the engine matched on venue and derived a
 * size class from a tape measure; the API accepted neither, so `venueTypeId`
 * was null on both sides of every comparison and null matched null. It looked
 * like it worked, which is the whole problem: the first listing to carry a
 * venue would have split every pool it touched, silently.
 */
describe('what the listing form actually collects', () => {
  beforeEach(() => {
    classifySpot.mockResolvedValue({ ...NOTHING_CLASSIFIED, venueTypeId: 'vt_gym' });
  });

  it('sends the venue to be classified and stores what comes back', async () => {
    await createListing(draft({ venueTypeSlug: 'gyms-fitness-clubs' }));
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({ venueTypeSlug: 'gyms-fitness-clubs' })
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ venueTypeId: 'vt_gym' })
    );
  });

  it('never lets a venue slug through to the repository as a column', async () => {
    await createListing(draft({ venueTypeSlug: 'gyms-fitness-clubs' }));
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['venueTypeSlug']).toBeUndefined();
  });

  /** Area is derived from the tape, never accepted, so the two cannot disagree. */
  it('works the area out from the dimensions', async () => {
    await createListing(draft({ widthFt: '6', heightFt: '4' }));
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ widthFt: '6', heightFt: '4', areaSqFt: '24.00' })
    );
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({ widthFt: '6', heightFt: '4' })
    );
  });

  /**
   * The conversion DR 02 step 7 exists to avoid.
   *
   * A mall quotes rupees per square foot per month. 150 x 24 sq ft = 3,600 a
   * month = 120 a day. Asking the publisher to do that division themselves is
   * how a rate arrives thirty times too large.
   */
  it('converts the publisher own unit into the daily rate', async () => {
    await createListing(
      draft({
        monthlyPrice: undefined,
        pricingUnit: 'PER_SQFT_PER_MONTH',
        basePrice: '150',
        widthFt: '6',
        heightFt: '4',
      })
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ratePerDay: '120.00', basePrice: '150', pricingUnit: 'PER_SQFT_PER_MONTH' })
    );
  });

  it('refuses a per-square-foot price with nothing to multiply', async () => {
    await expect(
      createListing(
        draft({ monthlyPrice: undefined, pricingUnit: 'PER_SQFT_PER_DAY', basePrice: '5' })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps a picked size class in preference to a measured one', async () => {
    await createListing(draft({ sizeClassId: 'sz_chosen', widthFt: '6', heightFt: '4' }));
    // Both are passed on; `classifySpot` is the single place that decides, and
    // it prefers the decision already taken.
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({ sizeClassId: 'sz_chosen', widthFt: '6', heightFt: '4' })
    );
  });
});

describe('editing what was measured', () => {
  beforeEach(() => {
    classifySpot.mockResolvedValue(NOTHING_CLASSIFIED);
    repository.findById.mockResolvedValue({
      id: 'lst_1',
      category: 'INDOOR',
      latitude: 19.076,
      longitude: 72.8777,
      city: 'Mumbai',
      widthFt: '6',
      heightFt: '4',
      areaSqFt: '24',
      pricingUnit: 'PER_SQFT_PER_MONTH',
      basePrice: '150',
    });
  });

  /** One side of the pair moves; the other comes off the listing. */
  it('recomputes the area from the stored height when only the width changes', async () => {
    await updateListing('lst_1', { widthFt: '8' });
    const [, data] = repository.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(data['areaSqFt']).toBe('32.00');
  });

  /** A bigger spot at the same rate per square foot is a bigger daily rate. */
  it('reprices when the tape moves under a per-square-foot unit', async () => {
    await updateListing('lst_1', { widthFt: '8' });
    const [, data] = repository.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(data['ratePerDay']).toBe('160.00');
  });

  /** A unit change with the same figure is a different rate, so it reprices. */
  it('reprices the stored figure when only the unit changes', async () => {
    await updateListing('lst_1', { pricingUnit: 'PER_MONTH' });
    const [, data] = repository.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(data['ratePerDay']).toBe('5.00');
  });

  /** New dimensions re-derive the class, or a corrected width leaves the
   *  listing in the pool its first mistyped measurement put it in. */
  it('reclassifies on a measurement change', async () => {
    await updateListing('lst_1', { heightFt: '5' });
    expect(classifySpot).toHaveBeenCalledWith(
      expect.objectContaining({ widthFt: '6', heightFt: '5' })
    );
  });

  /** But not on an unrelated edit, or a class ops corrected by hand snaps back. */
  it('does not re-derive the class on an unrelated patch', async () => {
    await updateListing('lst_1', { mediaTypeName: 'Mirror Decal' });
    const [call] = classifySpot.mock.calls as [Record<string, unknown>][];
    expect(call?.[0]?.['widthFt']).toBeUndefined();
  });
});

/**
 * One price per request.
 *
 * Three shapes are accepted and they are not alternatives that happen to agree:
 * `{monthlyPrice: 30000, pricingUnit: "PER_DAY", basePrice: "100"}` says both
 * 1,000 a day and 100 a day. Create resolved the pair first and update resolved
 * `ratePerDay` first, so the same body stored rates ten times apart depending on
 * which verb sent it — and on create the row landed with `ratePerDay` 100.00
 * beside `monthlyPrice` 30000, which `findSimilar` then queried on.
 */
describe('a request that states the price twice', () => {
  const base = {
    publisherId: 'pub_1',
    title: 'Andheri East hoarding',
    category: 'OUTDOOR',
    address: 'Western Express Highway',
  };

  it('refuses a monthly price alongside a unit and a figure', () => {
    const parsed = createListingSchema.safeParse({
      ...base,
      monthlyPrice: 30000,
      pricingUnit: 'PER_DAY',
      basePrice: '100',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a daily rate alongside a monthly one', () => {
    const parsed = createListingSchema.safeParse({
      ...base,
      ratePerDay: '100',
      monthlyPrice: 30000,
    });
    expect(parsed.success).toBe(false);
  });

  it('still accepts each shape on its own', () => {
    for (const price of [
      { ratePerDay: '100' },
      { monthlyPrice: 30000 },
      { pricingUnit: 'PER_DAY', basePrice: '100' },
    ]) {
      expect(createListingSchema.safeParse({ ...base, ...price }).success).toBe(true);
    }
  });

  /**
   * A patch may move one half of the pair, unlike a create — the other half is
   * already on the listing. The schema used to demand both, which made the
   * merge in `repricedFrom` unreachable and the test covering it a fiction.
   */
  it('accepts a unit on its own in a patch', () => {
    expect(updateListingSchema.safeParse({ pricingUnit: 'PER_MONTH' }).success).toBe(true);
    expect(updateListingSchema.safeParse({ basePrice: '150' }).success).toBe(true);
  });

  it('refuses a measurement no listing could hold', () => {
    const parsed = createListingSchema.safeParse({
      ...base,
      ratePerDay: '100',
      widthFt: '20000',
      heightFt: '10000',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('patching a listing category', () => {
  beforeEach(() => {
    classifySpot.mockResolvedValue(NOTHING_CLASSIFIED);
    repository.findById.mockResolvedValue({
      id: 'lst_1',
      category: 'INDOOR',
      latitude: 19.076,
      longitude: 72.8777,
      city: 'Mumbai',
      pricingUnit: 'PER_DAY',
      basePrice: null,
    });
  });

  /**
   * `category` is destructured out of the patch, so every path that writes has
   * to put it back. One did not: a patch touching nothing else answered 200 and
   * wrote an empty object. Category gates the media-type similarity threshold,
   * so an ops correction here was a silent no-op for the life of the listing.
   */
  it('writes a category change that touches nothing else', async () => {
    await updateListing('lst_1', { category: 'OUTDOOR' });
    expect(repository.update).toHaveBeenCalledWith('lst_1', { category: 'OUTDOOR' });
  });

  it('writes it alongside an unrelated field', async () => {
    await updateListing('lst_1', { category: 'OUTDOOR', title: 'Renamed' });
    expect(repository.update).toHaveBeenCalledWith('lst_1', {
      category: 'OUTDOOR',
      title: 'Renamed',
    });
  });
});
