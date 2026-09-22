import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot U — a publisher's spots and their rate card, imported.
 *
 * LISTING: title, category, address and a price are required; the vocabulary
 * is resolved at validation (INVALID naming the field when unknown); a row
 * without coordinates is geocoded through the maps seam and warns when the
 * seam answers null; a rate under the ADX floor warns; the same externalRef
 * or the same normalised address on one of the publisher's listings plans a
 * MERGE that fills only the blanks and never a set rate; a duplicate inside
 * the batch is SKIPPED; another publisher's spot within 25 m warns and still
 * creates; nothing refuses the batch. Commit opens ONE supply attempt on the
 * first run and reuses it on a resume, creates every row through
 * `listings.createListing` and files it under the attempt (never ACTIVE),
 * merges through `updateListing`, and answers the attempt id for the
 * console's "Send the agreement".
 *
 * RATE_CARD: a listing named by displayId, externalRef or exact title, in
 * that order; unmatched is INVALID; an unchanged rate is SKIPPED; below the
 * floor or a running booking warns; a future effectiveFrom is INVALID.
 * Commit sets the rate through `updateListing` (the stamp is the
 * repository's) and audits the reprice per listing.
 */

type AnyFn = (...args: any[]) => any;

const { repository, pricing, audit, maps, listings, supply, rateCards, agents } = vi.hoisted(() => ({
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
  maps: { geocodeAddress: vi.fn<AnyFn>() },
  listings: { createListing: vi.fn<AnyFn>(), updateListing: vi.fn<AnyFn>(), assertCanCreateForPublisher: vi.fn<AnyFn>(), LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] },
  supply: { createAttempt: vi.fn<AnyFn>(), attachListingToAttempt: vi.fn<AnyFn>() },
  rateCards: { floorFor: vi.fn<AnyFn>() },
  agents: (() => { const o = { findAgentProfile: vi.fn<AnyFn>() }; return { ...o, findWorkingAgentProfile: o.findAgentProfile }; })(),
}));

vi.mock('../prisma-party-imports.repository', () => ({ prismaPartyImportsRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../../shared/maps', () => maps);
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

import { ApiError } from '../../../shared/errors';
import { commitListingImport, commitRateCardImport, validateListingImport, validateRateCardImport } from '../listing-imports.service';
import { importReportCsv } from '../party-imports.service';

type Row = { id?: string; rowNumber: number; outcome: string; message: string | null; targetId: string | null; data: Record<string, unknown> };

const admin = { userId: 'usr_admin', isAdmin: true };
const agent = { userId: 'usr_agent', isAdmin: false };
const publisher = { id: 'pub_1', displayId: 'PUB-1', name: 'Metro Spaces', agentId: 'agt_1', userId: 'usr_pub' };

const vocabulary = () => ({
  mediaTypes: [
    { id: 'mt_hoarding', name: 'Hoarding', slug: 'hoarding', category: 'OUTDOOR' },
    { id: 'mt_screen', name: 'Digital Screen', slug: 'digital-screen', category: 'INDOOR' },
  ],
  sizeClasses: [{ id: 'sc_20x10', name: '20 x 10 ft', slug: '20x10' }],
  materials: [{ id: 'mat_flex', name: 'Flex', slug: 'flex' }],
});

const own = (over: Record<string, unknown> = {}) => ({
  id: 'lst_old',
  displayId: 'ADX-LST-00001',
  title: 'Old Hoarding',
  address: '12, MG Road, Pune',
  latitude: 18.5204,
  longitude: 73.8567,
  ratePerDay: '1500.00',
  slotsTotal: 1,
  status: 'ACTIVE',
  fields: { subType: null, description: null, city: 'Pune', size: null, mediaTypeId: 'mt_hoarding', sizeClassId: null, materialId: null },
  ...over,
});

const validatedRows = () => repository.createImport.mock.calls[0]![0].rows as Row[];
const byRowNumber = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.rowNumber, row]));
const plan = (row: Row) => row.data['plan'] as { action: string; targetId?: string; fill?: Record<string, unknown>; ratePerDay?: string; warnings: string[] } | null;

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPublisher.mockResolvedValue(publisher);
  repository.listPublisherListings.mockResolvedValue([]);
  repository.findExternalRefs.mockResolvedValue(new Map());
  repository.findListingsNear.mockResolvedValue([]);
  repository.listSpotVocabulary.mockResolvedValue(vocabulary());
  repository.findCityIdByName.mockImplementation(async (name: string) => (/^pune$/i.test(name) ? 'city_pune' : null));
  repository.listingsWithRunningBooking.mockResolvedValue(new Set());
  repository.createImport.mockImplementation(async (data: { party: string; publisherId: string; rows: unknown[]; counts: Record<string, number> }) => ({ id: 'imp_1', party: data.party, publisherId: data.publisherId, attemptId: null, status: 'VALIDATED', ...data.counts, rows: data.rows }));
  repository.stampRow.mockResolvedValue(undefined);
  repository.setAttempt.mockResolvedValue(undefined);
  repository.finishCommit.mockImplementation(async (id: string, counts: Record<string, number>) => ({ id, status: 'COMMITTED', fileName: 'spots.csv', publisherId: 'pub_1', attemptId: 'att_1', ...counts, rows: [] }));
  pricing.resolveCity.mockImplementation(async (name: string | null) => (name && /^(pune|mumbai)$/i.test(name) ? name[0]!.toUpperCase() + name.slice(1).toLowerCase() : null));
  // Lot V: Pune is launched, Mumbai is planned (no supply intake), anything else is outside the catalogue.
  const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
  const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
  pricing.citySupport.mockImplementation(async (name: string) =>
    /^pune$/i.test(name)
      ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'pune', name: 'Pune' } }
      : /^mumbai$/i.test(name)
        ? { support: 'INACTIVE', resolved: true, stage: 'PLANNED', switches: OFF, city: { slug: 'mumbai', name: 'Mumbai' } }
        : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null },
  );
  maps.geocodeAddress.mockResolvedValue(null);
  rateCards.floorFor.mockResolvedValue(null);
  listings.assertCanCreateForPublisher.mockResolvedValue(undefined);
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  supply.createAttempt.mockResolvedValue({ id: 'att_1', publisherId: 'pub_1', status: 'DRAFT' });
  supply.attachListingToAttempt.mockImplementation(async (attemptId: string, listingId: string) => ({ id: listingId, attemptId, status: 'AWAITING_AGREEMENT' }));
  listings.createListing.mockImplementation(async (draft: { title: string }) => ({ id: `lst_${draft.title.replace(/\W+/g, '_').toLowerCase()}`, displayId: null, status: 'DRAFT', title: draft.title }));
  listings.updateListing.mockImplementation(async (id: string) => ({ id }));
});

describe('listings: who may import for the publisher', () => {
  it('404s an unknown publisher and applies the act rule an agent\'s own listing creation uses', async () => {
    repository.findPublisher.mockResolvedValue(null);
    await expect(validateListingImport('pub_x', { rows: [] }, admin)).rejects.toMatchObject({ statusCode: 404 });

    repository.findPublisher.mockResolvedValue(publisher);
    listings.assertCanCreateForPublisher.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This is not your publisher.'));
    await expect(validateListingImport('pub_1', { rows: [{ rowNumber: 2, data: { title: 'X' } }] }, agent)).rejects.toMatchObject({ statusCode: 403 });
    expect(listings.assertCanCreateForPublisher).toHaveBeenCalledWith('pub_1', agent);
    expect(repository.createImport).not.toHaveBeenCalled();
  });
});

describe('listings: validating', () => {
  it('plans every outcome — vocabulary, geocoding, the floor, merges, batch duplicates, the 25 m warning — and never refuses the batch', async () => {
    repository.listPublisherListings.mockResolvedValue([own()]);
    repository.findExternalRefs.mockResolvedValue(new Map([['REF-7', 'lst_old']]));
    repository.findListingsNear.mockResolvedValue([
      // 10 m from row 3's point, another publisher's — a warning, not a refusal.
      { id: 'lst_other', displayId: 'ADX-LST-00099', title: 'Rival Hoarding', publisherId: 'pub_2', latitude: 18.52049, longitude: 73.85671 },
    ]);
    maps.geocodeAddress.mockImplementation(async (address: string) => (address.startsWith('44, FC Road') ? { formattedAddress: address, latitude: 18.5236, longitude: 73.8412, placeId: null, city: 'Pune', state: 'MH', postalCode: null } : null));
    rateCards.floorFor.mockImplementation(async (mediaTypeId: string) => (mediaTypeId === 'mt_hoarding' ? { cardId: 'rc_1', cardRate: '2000.00', floor: '1640.00' } : null));

    const result = await validateListingImport(
      'pub_1',
      {
        fileName: 'spots.csv',
        rows: [
          // Fresh, geocoded, under the floor: WARNING and still creates.
          { rowNumber: 2, data: { title: 'FC Road Hoarding', category: 'outdoor', address: '44, FC Road', city: 'pune', mediaType: 'hoarding', sizeClass: '20x10', material: 'Flex', ratePerDay: '1200', photos: 'https://cdn.adx.in/a.jpg|https://cdn.adx.in/b.jpg', instantBooking: 'Yes', slotsTotal: '1' } },
          // Coordinates given, another publisher's spot 10 m away: WARNING, still creates.
          { rowNumber: 3, data: { title: 'Station Wall', category: 'OUTDOOR', address: '1, Station Road, Pune', latitude: '18.5205', longitude: '73.8567', monthlyPrice: '90000' } },
          // No coordinates and the seam answers null: WARNING, still creates.
          { rowNumber: 4, data: { title: 'Nowhere Board', category: 'OUTDOOR', address: 'Plot 9, Unknown Lane', city: 'Atlantis', ratePerDay: '500' } },
          // The same externalRef as an earlier import's row: MERGE, filling only the blanks; the set rate stays.
          { rowNumber: 5, data: { externalRef: 'REF-7', title: 'Old Hoarding Renamed', category: 'OUTDOOR', address: 'Somewhere else', description: 'Faces the junction', material: 'flex', ratePerDay: '9999' } },
          // The same normalised address as the publisher's listing, nothing left to fill: SKIPPED.
          { rowNumber: 6, data: { title: 'Old Hoarding Again', category: 'OUTDOOR', address: '12 MG ROAD, PUNE', ratePerDay: '1500' } },
          // A duplicate inside the batch (same address as row 2): SKIPPED.
          { rowNumber: 7, data: { title: 'FC Road Twin', category: 'OUTDOOR', address: '44, FC Road', ratePerDay: '1200' } },
          // Unknown media type: INVALID naming the field.
          { rowNumber: 8, data: { title: 'Odd One', category: 'OUTDOOR', address: '5, Odd Street', mediaType: 'Blimp', ratePerDay: '100' } },
          // No price: INVALID.
          { rowNumber: 9, data: { title: 'Free Board', category: 'OUTDOOR', address: '6, Free Street' } },
          // No address: INVALID.
          { rowNumber: 10, data: { title: 'Lost Board', category: 'OUTDOOR', ratePerDay: '100' } },
          // A category off the enum: INVALID naming the field.
          { rowNumber: 11, data: { title: 'Sky Board', category: 'SKY', address: '7, Sky Street', ratePerDay: '100' } },
          // Lot V: a new spot in a city whose stage has supply intake off: SKIPPED, named.
          { rowNumber: 12, data: { title: 'Planned City Board', category: 'OUTDOOR', address: '8, Marine Drive', city: 'Mumbai', latitude: '18.94', longitude: '72.82', ratePerDay: '100' } },
        ],
      },
      admin,
    );

    const byRow = byRowNumber(validatedRows());
    expect(byRow[12]).toMatchObject({ outcome: 'SKIPPED', message: 'ADX is not taking new listings in Mumbai (planned)' });
    expect(byRow[2]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('below the ADX floor') });
    expect(byRow[2]!.data).toMatchObject({ category: 'OUTDOOR', city: 'Pune', latitude: '18.5236', longitude: '73.8412', geocoded: true, mediaTypeId: 'mt_hoarding', sizeClassId: 'sc_20x10', materialId: 'mat_flex', instantBooking: 'yes' });
    expect(plan(byRow[2]!)!.action).toBe('CREATE');
    expect(maps.geocodeAddress).toHaveBeenCalledWith('44, FC Road, Pune');

    expect(byRow[3]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('Possible duplicate of ADX-LST-00099') });
    expect(byRow[3]!.data).not.toHaveProperty('geocoded', true);
    expect(plan(byRow[3]!)!.action).toBe('CREATE');

    expect(byRow[4]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('place it on the map before publishing') });
    expect(byRow[4]!.message).toContain('Atlantis');
    expect(plan(byRow[4]!)!.action).toBe('CREATE');

    expect(byRow[5]).toMatchObject({ outcome: 'MERGED', targetId: 'lst_old', message: expect.stringContaining('ADX-LST-00001') });
    expect(plan(byRow[5]!)!.fill).toEqual({ description: 'Faces the junction', materialId: 'mat_flex' });

    expect(byRow[6]).toMatchObject({ outcome: 'SKIPPED', targetId: 'lst_old', message: expect.stringContaining('nothing to add') });
    expect(byRow[7]).toMatchObject({ outcome: 'SKIPPED', message: 'Duplicate of row 2 in this file' });
    expect(byRow[8]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^mediaType: /) });
    expect(byRow[9]).toMatchObject({ outcome: 'INVALID', message: 'ratePerDay or monthlyPrice is required' });
    expect(byRow[10]).toMatchObject({ outcome: 'INVALID', message: 'address is required' });
    expect(byRow[11]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^category: /) });

    expect(repository.createImport).toHaveBeenCalledWith(
      expect.objectContaining({
        party: 'LISTING',
        publisherId: 'pub_1',
        fileName: 'spots.csv',
        uploadedById: 'usr_admin',
        counts: { rowCount: 11, createdCount: 3, mergedCount: 1, skippedCount: 3, warningCount: 3, invalidCount: 4 },
      }),
    );
    expect(result).toMatchObject({ id: 'imp_1', status: 'VALIDATED', publisherId: 'pub_1' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_IMPORT_VALIDATED',
      expect.objectContaining({ targetType: 'PartyImport', targetId: 'imp_1', metadata: expect.objectContaining({ publisherId: 'pub_1', counts: expect.objectContaining({ rowCount: 11 }) }) }),
    );
  });

  it('never fails for the maps seam: a 503 from a keyless provider is the same warning as no match', async () => {
    maps.geocodeAddress.mockRejectedValue(new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No maps key'));
    await validateListingImport('pub_1', { rows: [{ rowNumber: 2, data: { title: 'A', category: 'OUTDOOR', address: '1 Lane', ratePerDay: '100' } }] }, admin);
    const [row] = validatedRows();
    expect(row).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('No coordinates') });
  });

  it('merges by address into the publisher\'s unpriced listing, filling the rate — and never overwrites a set one', async () => {
    repository.listPublisherListings.mockResolvedValue([own({ id: 'lst_free', ratePerDay: null, fields: { ...own().fields, mediaTypeId: null } }), own({ id: 'lst_priced', address: '9, Priced Lane' })]);
    await validateListingImport(
      'pub_1',
      {
        rows: [
          { rowNumber: 2, data: { title: 'A', category: 'OUTDOOR', address: '12, MG Road, Pune', ratePerDay: '800', mediaType: 'Digital Screen' } },
          { rowNumber: 3, data: { title: 'B', category: 'OUTDOOR', address: '9 Priced Lane', ratePerDay: '800' } },
        ],
      },
      admin,
    );
    const byRow = byRowNumber(validatedRows());
    expect(byRow[2]).toMatchObject({ outcome: 'MERGED', targetId: 'lst_free' });
    expect(plan(byRow[2]!)!.fill).toEqual({ mediaTypeId: 'mt_screen', ratePerDay: '800.00' });
    expect(byRow[3]).toMatchObject({ outcome: 'SKIPPED', targetId: 'lst_priced', message: expect.stringContaining('rate kept') });
  });
});

describe('listings: committing', () => {
  const validated = (rows: Row[], over: Record<string, unknown> = {}) => ({ id: 'imp_1', party: 'LISTING', publisherId: 'pub_1', attemptId: null, status: 'VALIDATED', fileName: 'spots.csv', note: null, rows, ...over });

  const rows = (): Row[] =>
    (
      [
        { rowNumber: 2, outcome: 'WARNING', targetId: null, message: 'Will create; below floor', data: { title: 'FC Road Hoarding', category: 'OUTDOOR', address: '44, FC Road', city: 'Pune', latitude: '18.5236', longitude: '73.8412', geocoded: true, mediaTypeId: 'mt_hoarding', ratePerDay: '1200', photos: 'https://cdn.adx.in/a.jpg|https://cdn.adx.in/b.jpg', instantBooking: 'yes', slotsTotal: '1', plan: { action: 'CREATE', warnings: ['below floor'] } } },
        { rowNumber: 3, outcome: 'CREATED', targetId: null, message: null, data: { title: 'Station Wall', category: 'OUTDOOR', address: '1, Station Road, Pune', monthlyPrice: '90000', plan: { action: 'CREATE', warnings: [] } } },
        { rowNumber: 5, outcome: 'MERGED', targetId: 'lst_old', message: null, data: { externalRef: 'REF-7', title: 'Old', category: 'OUTDOOR', address: 'x', description: 'Faces the junction', ratePerDay: '9999', plan: { action: 'MERGE', targetId: 'lst_old', fill: { description: 'Faces the junction', materialId: 'mat_flex' }, warnings: [] } } },
        { rowNumber: 7, outcome: 'SKIPPED', targetId: null, message: 'Duplicate of row 2 in this file', data: { title: 'Twin', plan: null } },
        { rowNumber: 8, outcome: 'INVALID', targetId: null, message: 'mediaType: unknown', data: { title: 'Odd', plan: null } },
      ] as Row[]
    ).map((row, index) => ({ ...row, id: `r${index}` }));

  it('opens one attempt, creates through listings.createListing, files each under the attempt (never ACTIVE), merges through updateListing, audits, and answers the attempt id', async () => {
    repository.findImport.mockResolvedValue(validated(rows()));
    repository.listPublisherListings.mockResolvedValue([own()]);
    repository.findExternalRefs.mockResolvedValue(new Map([['REF-7', 'lst_old']]));

    const result = await commitListingImport('imp_1', admin, 'usr_admin');

    expect(supply.createAttempt).toHaveBeenCalledTimes(1);
    expect(supply.createAttempt).toHaveBeenCalledWith({ publisherId: 'pub_1', origin: 'ADMIN_BULK', createdByUserId: 'usr_admin', sourceFilename: 'spots.csv', note: expect.stringContaining('imp_1') });
    expect(repository.setAttempt).toHaveBeenCalledWith('imp_1', 'att_1');

    expect(listings.createListing).toHaveBeenCalledTimes(2);
    const first = listings.createListing.mock.calls[0]![0];
    expect(first).toMatchObject({
      publisherId: 'pub_1',
      title: 'FC Road Hoarding',
      category: 'OUTDOOR',
      address: '44, FC Road',
      city: 'Pune',
      latitude: 18.5236,
      longitude: 73.8412,
      mediaTypeId: 'mt_hoarding',
      ratePerDay: '1200',
      instantBooking: true,
      slotsTotal: 1,
      photos: [{ url: 'https://cdn.adx.in/a.jpg', type: 'main' }, { url: 'https://cdn.adx.in/b.jpg', type: 'main' }],
    });
    // An admin's import carries no agent; the status is never set here — createListing's DRAFT, then the attempt's AWAITING_AGREEMENT.
    expect(first).not.toHaveProperty('agentId');
    expect(first).not.toHaveProperty('status');
    expect(listings.createListing.mock.calls[1]![0]).toMatchObject({ title: 'Station Wall', monthlyPrice: 90000 });
    expect(listings.createListing.mock.calls[1]![0]).not.toHaveProperty('ratePerDay');
    expect(supply.attachListingToAttempt).toHaveBeenCalledWith('att_1', 'lst_fc_road_hoarding');
    expect(supply.attachListingToAttempt).toHaveBeenCalledWith('att_1', 'lst_station_wall');
    expect(supply.attachListingToAttempt).toHaveBeenCalledTimes(2);

    // The merge fills only the blanks, through the listing's own update door — and never the rate.
    expect(listings.updateListing).toHaveBeenCalledWith('lst_old', { description: 'Faces the junction', materialId: 'mat_flex' });

    const stamps = repository.stampRow.mock.calls as [string, { targetId: string | null; outcome?: string; data: { result: { action: string; attemptId?: string } } }][];
    expect(stamps.find(([rowId]) => rowId === 'r0')![1]).toMatchObject({ targetId: 'lst_fc_road_hoarding', data: { result: { action: 'CREATED', attemptId: 'att_1' } } });
    expect(stamps.find(([rowId]) => rowId === 'r0')![1]).not.toHaveProperty('outcome');
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).toMatchObject({ targetId: 'lst_station_wall', outcome: 'CREATED' });
    expect(stamps.find(([rowId]) => rowId === 'r2')![1]).toMatchObject({ targetId: 'lst_old', outcome: 'MERGED' });
    expect(stamps.some(([rowId]) => rowId === 'r3' || rowId === 'r4')).toBe(false);

    expect(repository.finishCommit).toHaveBeenCalledWith('imp_1', { createdCount: 2, mergedCount: 1, skippedCount: 1, warningCount: 1, invalidCount: 1 }, expect.any(Date));
    expect(result).toMatchObject({ status: 'COMMITTED', attemptId: 'att_1' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LISTING_CREATED', expect.objectContaining({ targetType: 'Listing', targetId: 'lst_fc_road_hoarding', metadata: expect.objectContaining({ importId: 'imp_1', rowNumber: 2, attemptId: 'att_1', source: 'import' }) }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LISTING_UPDATED', expect.objectContaining({ targetType: 'Listing', targetId: 'lst_old', metadata: expect.objectContaining({ importId: 'imp_1', rowNumber: 5, source: 'import', fields: ['description', 'materialId'] }) }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LISTING_IMPORT_COMMITTED', expect.objectContaining({ targetType: 'PartyImport', targetId: 'imp_1', metadata: expect.objectContaining({ attemptId: 'att_1', counts: { createdCount: 2, mergedCount: 1, skippedCount: 1, warningCount: 1, invalidCount: 1 } }) }));
  });

  it('resumes: reuses the attempt already on the import, skips stamped rows, and merges into a listing that joined since validation', async () => {
    const stamped = rows();
    stamped[0]!.data['result'] = { action: 'CREATED', targetId: 'lst_fc_road_hoarding', attemptId: 'att_1', at: '2026-09-15T09:00:00.000Z' };
    stamped[0]!.targetId = 'lst_fc_road_hoarding';
    repository.findImport.mockResolvedValue(validated(stamped, { attemptId: 'att_1' }));
    // Station Road joined between validation and commit.
    repository.listPublisherListings.mockResolvedValue([own(), own({ id: 'lst_station', displayId: 'ADX-LST-00002', title: 'Station Wall', address: '1 Station Road Pune', ratePerDay: '3000.00', fields: { ...own().fields, description: null } })]);
    repository.findExternalRefs.mockResolvedValue(new Map([['REF-7', 'lst_old']]));

    await commitListingImport('imp_1', admin, 'usr_admin');

    expect(supply.createAttempt).not.toHaveBeenCalled();
    expect(listings.createListing).not.toHaveBeenCalled();
    const stamps = repository.stampRow.mock.calls as [string, { outcome?: string; message?: string; data: { result: { action: string } } }][];
    expect(stamps.some(([rowId]) => rowId === 'r0')).toBe(false);
    // Nothing left to fill on the listing that joined — SKIPPED with the reason, not a duplicate.
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).toMatchObject({ outcome: 'SKIPPED', message: expect.stringContaining('joined after validation') });
    expect(repository.finishCommit).toHaveBeenCalledWith('imp_1', { createdCount: 1, mergedCount: 1, skippedCount: 2, warningCount: 1, invalidCount: 1 }, expect.any(Date));
  });

  it('an agent\'s import stamps the agent on every created listing and opens an AGENT attempt', async () => {
    repository.findImport.mockResolvedValue(validated([rows()[1]!]));
    await commitListingImport('imp_1', agent, 'usr_agent');
    expect(listings.assertCanCreateForPublisher).toHaveBeenCalledWith('pub_1', agent);
    expect(supply.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ origin: 'AGENT', createdByUserId: 'usr_agent' }));
    expect(listings.createListing.mock.calls[0]![0]).toMatchObject({ agentId: 'agt_1' });
  });

  it('a row the listing service refuses is INVALID with the reason and the commit goes on; 409 twice and after a revoke', async () => {
    listings.createListing.mockImplementationOnce(async () => {
      throw new ApiError(409, 'FEATURE_OFF', 'Instant booking is not enabled');
    });
    repository.findImport.mockResolvedValue(validated([rows()[0]!, rows()[1]!]));
    await commitListingImport('imp_1', admin, 'usr_admin');
    const stamps = repository.stampRow.mock.calls as [string, { outcome?: string; message?: string }][];
    expect(stamps.find(([rowId]) => rowId === 'r0')![1]).toMatchObject({ outcome: 'INVALID', message: 'Not created: Instant booking is not enabled' });
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).toMatchObject({ outcome: 'CREATED' });

    repository.findImport.mockResolvedValue(validated([], { status: 'COMMITTED' }));
    await expect(commitListingImport('imp_1', admin, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findImport.mockResolvedValue(validated([], { status: 'REVOKED' }));
    await expect(commitListingImport('imp_1', admin, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('the report carries the listing columns after the outcome', async () => {
    repository.findImport.mockResolvedValue(validated([rows()[1]!]));
    const csv = await importReportCsv('listings', 'imp_1');
    expect(csv.split('\r\n')[0]).toBe('rowNumber,outcome,message,targetId,externalRef,title,category,subType,description,address,city,state,latitude,longitude,mediaType,sizeClass,size,material,ratePerDay,monthlyPrice,slotsTotal,instantBooking,photos');
    expect(csv).toContain('3,CREATED,,,,Station Wall,OUTDOOR');
  });
});

describe('rate card: validating', () => {
  it('resolves the listing by displayId, externalRef then exact title; warns below the floor and on a running booking; skips an unchanged rate; refuses a future date', async () => {
    repository.listPublisherListings.mockResolvedValue([
      own(),
      own({ id: 'lst_two', displayId: 'ADX-LST-00002', title: 'Station Wall', address: '1 Station Road', ratePerDay: '3000.00' }),
      own({ id: 'lst_five', displayId: 'ADX-LST-00005', title: 'Five Board', address: '5 Five Road', ratePerDay: '1500.00' }),
      own({ id: 'lst_three', displayId: null, title: 'Untitled Twin', address: 'a' }),
      own({ id: 'lst_four', displayId: null, title: 'Untitled Twin', address: 'b' }),
    ]);
    repository.findExternalRefs.mockResolvedValue(new Map([['REF-2', 'lst_two']]));
    repository.listingsWithRunningBooking.mockResolvedValue(new Set(['lst_two']));
    rateCards.floorFor.mockResolvedValue({ cardId: 'rc_1', cardRate: '2000.00', floor: '1640.00' });

    await validateRateCardImport(
      'pub_1',
      {
        fileName: 'rates.csv',
        rows: [
          { rowNumber: 2, data: { listing: 'adx-lst-00001', ratePerDay: '1800' } },
          { rowNumber: 3, data: { listing: 'REF-2', monthlyPrice: '45000', slotsTotal: '2' } },
          { rowNumber: 4, data: { listing: 'Five Board', ratePerDay: '1500' } },
          { rowNumber: 5, data: { listing: 'Nowhere Board', ratePerDay: '100' } },
          { rowNumber: 6, data: { listing: 'ADX-LST-00001', ratePerDay: '1700' } },
          { rowNumber: 7, data: { listing: 'ADX-LST-00002', ratePerDay: '2500', effectiveFrom: '2999-01-01' } },
          { rowNumber: 8, data: { listing: 'Untitled Twin', ratePerDay: '100' } },
          { rowNumber: 9, data: { listing: 'ADX-LST-00002', ratePerDay: 'lots' } },
          { rowNumber: 10, data: { ratePerDay: '100' } },
        ],
      },
      admin,
    );
    const byRow = byRowNumber(validatedRows());
    // Above the floor, no booking: a plain set.
    expect(byRow[2]).toMatchObject({ outcome: 'MERGED', targetId: 'lst_old', message: expect.stringContaining('1500.00 → 1800.00') });
    expect(plan(byRow[2]!)).toMatchObject({ action: 'SET', targetId: 'lst_old', ratePerDay: '1800.00' });
    // By externalRef; monthly converted; a booking runs: WARNING saying the accrual snapshots stay.
    expect(byRow[3]).toMatchObject({ outcome: 'WARNING', targetId: 'lst_two', message: expect.stringContaining('accrual snapshots') });
    expect(plan(byRow[3]!)).toMatchObject({ action: 'SET', ratePerDay: '1500.00', slotsTotal: 2 });
    expect(byRow[3]!.message).toContain('below the ADX floor');
    // By exact title, the same rate: SKIPPED.
    expect(byRow[4]).toMatchObject({ outcome: 'SKIPPED', targetId: 'lst_five', message: expect.stringContaining('unchanged') });
    expect(byRow[5]).toMatchObject({ outcome: 'INVALID', message: 'listing: no listing "Nowhere Board" on this publisher' });
    // The same listing twice in the file: the later row is SKIPPED.
    expect(byRow[6]).toMatchObject({ outcome: 'SKIPPED', message: 'Duplicate of row 2 in this file' });
    expect(byRow[7]).toMatchObject({ outcome: 'INVALID', message: 'effectiveFrom: future rates are not supported' });
    expect(byRow[8]).toMatchObject({ outcome: 'INVALID', message: expect.stringContaining('names 2 listings') });
    expect(byRow[9]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^ratePerDay: /) });
    expect(byRow[10]).toMatchObject({ outcome: 'INVALID', message: 'listing is required' });
    expect(repository.createImport).toHaveBeenCalledWith(expect.objectContaining({ party: 'RATE_CARD', publisherId: 'pub_1', counts: { rowCount: 9, createdCount: 0, mergedCount: 2, skippedCount: 2, warningCount: 1, invalidCount: 5 } }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'RATE_CARD_IMPORT_VALIDATED', expect.objectContaining({ targetId: 'imp_1' }));
  });
});

describe('rate card: committing', () => {
  it('sets each rate through listings.updateListing — the repository stamps ratePerDaySetAt — audits the reprice per listing, skips a rate already there, and audits the import', async () => {
    const rows = (
      [
        { rowNumber: 2, outcome: 'MERGED', targetId: 'lst_old', message: null, data: { listing: 'ADX-LST-00001', ratePerDay: '1800', plan: { action: 'SET', targetId: 'lst_old', ratePerDay: '1800.00', from: '1500.00', warnings: [] } } },
        { rowNumber: 3, outcome: 'WARNING', targetId: 'lst_two', message: 'below floor', data: { listing: 'REF-2', monthlyPrice: '45000', slotsTotal: '2', plan: { action: 'SET', targetId: 'lst_two', ratePerDay: '1500.00', slotsTotal: 2, from: '3000.00', warnings: ['below floor'] } } },
        { rowNumber: 4, outcome: 'MERGED', targetId: 'lst_gone', message: null, data: { listing: 'X', ratePerDay: '10', plan: { action: 'SET', targetId: 'lst_gone', ratePerDay: '10.00', from: '5.00', warnings: [] } } },
        { rowNumber: 5, outcome: 'INVALID', targetId: null, message: 'listing is required', data: { plan: null } },
      ] as Row[]
    ).map((row, index) => ({ ...row, id: `r${index}` }));
    repository.findImport.mockResolvedValue({ id: 'imp_1', party: 'RATE_CARD', publisherId: 'pub_1', attemptId: null, status: 'VALIDATED', fileName: 'rates.csv', rows });
    // Since validation, lst_two was already moved to 1500 by hand.
    repository.listPublisherListings.mockResolvedValue([own(), own({ id: 'lst_two', displayId: 'ADX-LST-00002', ratePerDay: '1500.00', slotsTotal: 2 })]);
    repository.finishCommit.mockImplementation(async (id: string, counts: Record<string, number>) => ({ id, status: 'COMMITTED', fileName: 'rates.csv', publisherId: 'pub_1', attemptId: null, ...counts, rows: [] }));

    const result = await commitRateCardImport('imp_1', admin, 'usr_admin');

    expect(listings.updateListing).toHaveBeenCalledTimes(1);
    expect(listings.updateListing).toHaveBeenCalledWith('lst_old', { ratePerDay: '1800.00' });
    const stamps = repository.stampRow.mock.calls as [string, { outcome?: string; message?: string; targetId?: string | null; data: { result: { action: string } } }][];
    expect(stamps.find(([rowId]) => rowId === 'r0')![1]).toMatchObject({ targetId: 'lst_old', outcome: 'MERGED', data: { result: { action: 'MERGED' } } });
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).toMatchObject({ outcome: 'SKIPPED', message: expect.stringContaining('already at') });
    expect(stamps.find(([rowId]) => rowId === 'r2')![1]).toMatchObject({ outcome: 'SKIPPED', message: expect.stringContaining('no longer on the platform') });
    expect(stamps.some(([rowId]) => rowId === 'r3')).toBe(false);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_REPRICED_BY_IMPORT',
      expect.objectContaining({ targetType: 'Listing', targetId: 'lst_old', metadata: expect.objectContaining({ importId: 'imp_1', rowNumber: 2, source: 'import', from: '1500.00', to: '1800.00' }) }),
    );
    expect(audit.auditDiff).toHaveBeenCalledWith({ ratePerDay: '1500.00' }, { ratePerDay: '1800.00' });
    expect(repository.finishCommit).toHaveBeenCalledWith('imp_1', { createdCount: 0, mergedCount: 1, skippedCount: 2, warningCount: 0, invalidCount: 1 }, expect.any(Date));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'RATE_CARD_IMPORT_COMMITTED', expect.objectContaining({ targetType: 'PartyImport', targetId: 'imp_1', metadata: expect.objectContaining({ publisherId: 'pub_1' }) }));
    expect(result).toMatchObject({ status: 'COMMITTED' });
  });
});
