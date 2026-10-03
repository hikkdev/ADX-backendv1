import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LD-1 (the owner, 3 Oct 2026): "ask what we store, store what we ask".
 *
 * Pinned:
 *  - the new questions reach the columns: daily footfall, traffic,
 *    visibility, elevation, the screen's pixels, the vehicle kind, the
 *    live switch — the closed lists stored as codes, their words accepted
 *    and turned into the code, a desk word with no code kept as sent;
 *  - the answers that were thrown away are kept: the terms tick (from the
 *    body or the draft), the answers no column takes (from the draft,
 *    labelled from the stored flow, and from the body), the papers waived,
 *    the ownership tick, the coverage, the operating hours beside the
 *    visibility window, the pin's accuracy, a photograph's upload row;
 *  - an edit takes them too, and the slot duration the website's edit
 *    used to lose.
 */

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  uploadedPhotoFacts: vi.fn(),
  setContentRules: vi.fn(),
}));
const getFlow = vi.hoisted(() => vi.fn());

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../identifiers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../identifiers')>()), allocateIdentifier: async () => 'LST-0310-2601' }));
vi.mock('../../pricing', () => ({
  classifySpot: vi.fn(async () => ({ venueTypeId: null, mediaTypeId: null, sizeClassId: null, materialId: null, derivedFromDimensions: false })),
  activeSurge: vi.fn(async () => null),
  assertCityAllows: vi.fn(async () => undefined),
  cityKeyFor: vi.fn(async () => null),
  withCityKey: vi.fn(async (data: unknown) => data),
}));
vi.mock('../../app-config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app-config')>()), getFlow }));

import { createListing, updateListing } from '../listings.service';
import { createListingSchema, updateListingSchema } from '../listings.schema';

const base = { title: 'Station Road hoarding', category: 'OUTDOOR', address: 'Station Road, Pune', pricingUnit: 'PER_DAY', basePrice: '1500' };

/** The stored flow as the Flow Editor left it: the code's questions plus one somebody added. */
const STORED_FLOW = {
  label: 'Listing',
  version: 3,
  screens: [{ key: 'select-category', fields: [{ id: 'category', type: 'selectable-cards', label: 'Category' }] }],
  branches: {
    outdoor: {
      screens: [
        { key: 'spot-details', fields: [{ id: 'title', type: 'text', label: 'Ad spot name' }, { id: 'parking_nearby', type: 'select', label: 'Is there parking nearby?' }] },
      ],
    },
  },
};

const parsedCreate = (body: Record<string, unknown>) => {
  const parsed = createListingSchema.safeParse({ ...base, ...body });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.flatten()));
  return parsed.data;
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.create.mockImplementation(async (data: unknown) => ({ id: 'lst_1', ...(data as object) }));
  repository.update.mockImplementation(async (_id: string, data: unknown) => data);
  repository.uploadedPhotoFacts.mockResolvedValue([]);
  getFlow.mockResolvedValue(STORED_FLOW);
});

describe('the new questions', () => {
  it('are taken on create, the closed lists stored as codes', () => {
    const data = parsedCreate({
      estimatedDailyFootfall: 2500,
      trafficGrade: 'VERY_HIGH',
      visibility: '50_150M',
      elevation: 'ROOFTOP',
      widthPx: 1920,
      heightPx: 1080,
      vehicleType: 'AUTO',
      availableNow: false,
    });
    expect(data).toMatchObject({
      estimatedDailyFootfall: 2500,
      trafficGrade: 'VERY_HIGH',
      visibility: '50_150M',
      elevation: 'ROOFTOP',
      widthPx: 1920,
      heightPx: 1080,
      vehicleType: 'AUTO',
      availableNow: false,
    });
  });

  it('turn the list’s words into its code, in any case and with any dash', () => {
    const data = parsedCreate({ trafficGrade: 'very high', visibility: '150-300 m', elevation: 'Ground level', vehicleType: 'Auto-rickshaw' });
    expect(data).toMatchObject({ trafficGrade: 'VERY_HIGH', visibility: '150_300M', elevation: 'GROUND', vehicleType: 'AUTO' });
    expect(parsedCreate({ trafficGrade: 'Prime', visibility: 'Under 50 m', elevation: 'Elevated structure', vehicleType: 'Taxi' })).toMatchObject({
      trafficGrade: 'VERY_HIGH',
      visibility: 'UNDER_50M',
      elevation: 'ELEVATED',
      vehicleType: 'CAB',
    });
  });

  it('keep a desk word that has no code as sent, so the console’s create still works', () => {
    expect(parsedCreate({ elevation: 'Mid-rise', visibility: 'Landmark' })).toMatchObject({ elevation: 'Mid-rise', visibility: 'Landmark' });
  });

  it('take footfall as a whole number of people, never negative', () => {
    expect(createListingSchema.safeParse({ ...base, estimatedDailyFootfall: 0 }).success).toBe(true);
    expect(createListingSchema.safeParse({ ...base, estimatedDailyFootfall: -1 }).success).toBe(false);
    expect(createListingSchema.safeParse({ ...base, estimatedDailyFootfall: 12.5 }).success).toBe(false);
  });

  it('are all optional — a listing without any of them is still a listing', () => {
    expect(createListingSchema.safeParse(base).success).toBe(true);
  });

  it('are patched and cleared on an edit', () => {
    const patch = updateListingSchema.safeParse({ estimatedDailyFootfall: 900, trafficGrade: 'Low', visibility: null, elevation: null, vehicleType: null, widthPx: null });
    expect(patch.success && patch.data).toMatchObject({ estimatedDailyFootfall: 900, trafficGrade: 'LOW', visibility: null, elevation: null, vehicleType: null, widthPx: null });
  });

  it('reach the columns on create', async () => {
    await createListing({ ...parsedCreate({ estimatedDailyFootfall: 2500, trafficGrade: 'HIGH', visibility: 'OVER_300M', elevation: 'FIRST_FLOOR' }), publisherId: 'pub_1', category: 'OUTDOOR' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedDailyFootfall: 2500, trafficGrade: 'HIGH', visibility: 'OVER_300M', elevation: 'FIRST_FLOOR' }),
    );
  });
});

describe('the answers that were thrown away', () => {
  it('keeps every draft answer no column takes, labelled from the stored flow — never dropped again', async () => {
    const draftAnswers = {
      category: 'outdoor',
      title: 'Station Road hoarding',
      traffic_grade: 'HIGH',
      parking_nearby: 'Yes, a paid lot',
      // A question the flow no longer asks keeps its id as the label.
      old_question: 42,
      blank_question: '',
      content_rules: [],
      instant_booking: false,
      web: true,
      photo_meta: { main_photo: { uploadedFileId: 'upl_1', takenAt: '2026-10-02T04:30:00.000Z' } },
    };
    await createListing({ ...parsedCreate({}), publisherId: 'pub_1', category: 'OUTDOOR', draftAnswers });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['extraAnswers']).toEqual([
      { key: 'parking_nearby', label: 'Is there parking nearby?', value: 'Yes, a paid lot' },
      { key: 'old_question', label: 'old_question', value: 42 },
    ]);
    expect(getFlow).toHaveBeenCalledWith('listing');
  });

  it('merges the body’s extra answers with the draft’s, the body’s word winning', async () => {
    await createListing({
      ...parsedCreate({ extraAnswers: [{ key: 'parking_nearby', label: 'Is there parking nearby?', value: 'No' }, { key: 'landmark', label: 'Nearest landmark', value: 'Metro gate 2' }] }),
      publisherId: 'pub_1',
      category: 'OUTDOOR',
      draftAnswers: { parking_nearby: 'Yes' },
    });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['extraAnswers']).toEqual([
      { key: 'parking_nearby', label: 'Is there parking nearby?', value: 'No' },
      { key: 'landmark', label: 'Nearest landmark', value: 'Metro gate 2' },
    ]);
  });

  it('asks nothing of the flow and writes no extra answers when every answer has a column', async () => {
    await createListing({ ...parsedCreate({}), publisherId: 'pub_1', category: 'OUTDOOR', draftAnswers: { title: 'x', estimated_daily_footfall: 300 } });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty('extraAnswers');
    expect(getFlow).not.toHaveBeenCalled();
  });

  it('stamps the terms tick from the body, with the wording named or the flow’s version', async () => {
    await createListing({ ...parsedCreate({ termsAccepted: true, termsVersion: 'listing-guidelines-2026-09' }), publisherId: 'pub_1', category: 'OUTDOOR' });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ termsAcceptedAt: expect.any(Date), termsVersion: 'listing-guidelines-2026-09' });

    await createListing({ ...parsedCreate({ termsAccepted: true }), publisherId: 'pub_1', category: 'OUTDOOR' });
    expect(repository.create.mock.calls[1]![0]).toMatchObject({ termsAcceptedAt: expect.any(Date), termsVersion: 'flows.listing:v3' });
  });

  it('stamps the terms tick from the draft’s `terms` answer', async () => {
    await createListing({ ...parsedCreate({}), publisherId: 'pub_1', category: 'OUTDOOR', draftAnswers: { terms: true } });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ termsAcceptedAt: expect.any(Date), termsVersion: 'flows.listing:v3' });
  });

  it('records no tick that was not made', async () => {
    await createListing({ ...parsedCreate({ termsAccepted: false }), publisherId: 'pub_1', category: 'OUTDOOR', draftAnswers: { terms: false } });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty('termsAcceptedAt');
    expect(data).not.toHaveProperty('ownershipDeclaredAt');
  });

  it('still makes the listing when the stored flow cannot be read — labelled by id, versioned plainly', async () => {
    getFlow.mockRejectedValue(new Error('config row unreadable'));
    await createListing({ ...parsedCreate({ termsAccepted: true }), publisherId: 'pub_1', category: 'OUTDOOR', draftAnswers: { parking_nearby: 'Yes' } });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({
      extraAnswers: [{ key: 'parking_nearby', label: 'parking_nearby', value: 'Yes' }],
      termsVersion: 'flows.listing',
    });
  });

  it('keeps the waived papers, the ownership tick, the coverage, both sets of hours and the pin’s accuracy', async () => {
    await createListing({
      ...parsedCreate({
        documentWaivers: [{ kind: 'municipal_permit', reason: 'Private land, no permit needed' }, { kind: 'OWNER_NOC' }],
        ownershipDeclared: true,
        coverage: 'Whole of Pune',
        availableHoursFrom: '18:00',
        availableHoursTo: '23:00',
        operatingHoursFrom: '09:00',
        operatingHoursTo: '23:00',
        locationAccuracyM: 6.5,
        city: 'Pune',
      }),
      publisherId: 'pub_1',
      category: 'OUTDOOR',
    });
    const [data] = repository.create.mock.calls[0] as [Record<string, unknown>];
    expect(data['documentWaivers']).toEqual([
      { kind: 'MUNICIPAL_PERMIT', reason: 'Private land, no permit needed', at: expect.any(String) },
      { kind: 'OWNER_NOC', at: expect.any(String) },
    ]);
    expect(data).toMatchObject({
      ownershipDeclaredAt: expect.any(Date),
      coverage: 'Whole of Pune',
      // The coverage is its own column; the city stays what was typed.
      city: 'Pune',
      availableHoursFrom: '18:00',
      availableHoursTo: '23:00',
      operatingHoursFrom: '09:00',
      operatingHoursTo: '23:00',
      locationAccuracyM: 6.5,
    });
    expect(data).not.toHaveProperty('ownershipDeclared');
    expect(data).not.toHaveProperty('termsAccepted');
  });

  it('files each photograph with its upload row and capture time, asking the register only for the ones the client did not describe', async () => {
    const takenAt = new Date('2026-10-02T04:30:00Z');
    repository.uploadedPhotoFacts.mockResolvedValue([{ id: 'upl_left', url: 'https://files.example/left.jpg', takenAt: new Date('2026-10-01T09:00:00Z') }]);
    await createListing({
      ...parsedCreate({
        photos: [
          { url: 'https://files.example/front.jpg', type: 'FRONT', uploadedFileId: 'upl_front', takenAt: takenAt.toISOString() },
          { url: 'https://files.example/left.jpg', type: 'LEFT' },
          { url: 'https://files.example/elsewhere.jpg', type: 'WIDE' },
        ],
      }),
      publisherId: 'pub_1',
      category: 'OUTDOOR',
    });
    expect(repository.uploadedPhotoFacts).toHaveBeenCalledWith(['https://files.example/left.jpg', 'https://files.example/elsewhere.jpg']);
    expect(repository.create.mock.calls[0]![0]['photos']).toEqual([
      { url: 'https://files.example/front.jpg', type: 'FRONT', uploadedFileId: 'upl_front', takenAt },
      { url: 'https://files.example/left.jpg', type: 'LEFT', uploadedFileId: 'upl_left', takenAt: new Date('2026-10-01T09:00:00Z') },
      { url: 'https://files.example/elsewhere.jpg', type: 'WIDE', uploadedFileId: null, takenAt: null },
    ]);
  });
});

describe('an edit', () => {
  const stored = {
    id: 'lst_1',
    category: 'OUTDOOR',
    publisherId: 'pub_1',
    mediaTypeId: null,
    subType: null,
    slotsTotal: 1,
    basePrice: null,
    pricingUnit: 'PER_DAY',
    documentWaivers: [{ kind: 'OWNER_NOC', at: '2026-09-01T00:00:00.000Z' }],
    ownershipDeclaredAt: new Date('2026-09-01T00:00:00Z'),
  };

  beforeEach(() => repository.findById.mockResolvedValue(stored));

  it('takes the slot duration the website’s edit used to lose, and the new columns', () => {
    const parsed = updateListingSchema.safeParse({ size: '30 seconds', coverage: 'Route 500D', operatingHoursFrom: '10:00', locationAccuracyM: 12 });
    expect(parsed.success && parsed.data).toMatchObject({ size: '30 seconds', coverage: 'Route 500D', operatingHoursFrom: '10:00', locationAccuracyM: 12 });
  });

  it('replaces the waivers, keeping the moment a paper was first waived', async () => {
    await updateListing('lst_1', { documentWaivers: [{ kind: 'OWNER_NOC' }, { kind: 'ADDRESS_PROOF', reason: 'Highway site' }] });
    const [, patch] = repository.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch['documentWaivers']).toEqual([
      { kind: 'OWNER_NOC', at: '2026-09-01T00:00:00.000Z' },
      { kind: 'ADDRESS_PROOF', reason: 'Highway site', at: expect.any(String) },
    ]);
  });

  it('keeps the ownership tick’s first moment while it stays ticked, and clears it when unticked', async () => {
    await updateListing('lst_1', { ownershipDeclared: true });
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ ownershipDeclaredAt: new Date('2026-09-01T00:00:00Z') });
    await updateListing('lst_1', { ownershipDeclared: false });
    expect(repository.update.mock.calls[1]![1]).toMatchObject({ ownershipDeclaredAt: null });
  });

  it('replaces or clears the extra answers, and leaves them alone when not sent', async () => {
    await updateListing('lst_1', { extraAnswers: [{ key: 'parking_nearby', label: 'Is there parking nearby?', value: 'No' }] });
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ extraAnswers: [{ key: 'parking_nearby', label: 'Is there parking nearby?', value: 'No' }] });
    await updateListing('lst_1', { extraAnswers: null, documentWaivers: [] });
    expect(repository.update.mock.calls[1]![1]).toMatchObject({ extraAnswers: null, documentWaivers: null });
    await updateListing('lst_1', { title: 'Renamed' });
    const third = repository.update.mock.calls[2]![1] as Record<string, unknown>;
    expect(third).not.toHaveProperty('extraAnswers');
    expect(third).not.toHaveProperty('documentWaivers');
    expect(third).not.toHaveProperty('ownershipDeclaredAt');
  });
});
