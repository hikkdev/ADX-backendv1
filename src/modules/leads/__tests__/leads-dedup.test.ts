import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q56/Q93) — lead dedup.
 *
 * The normalised phone is the hard key: a second lead on the same number is
 * skipped and reported, never merged; a number that already belongs to a
 * publisher or advertiser account is skipped and reported, never converted
 * into a lead. Business name + city (case and spaces folded) is a warning —
 * the lead is created and the row says why to look twice. The import runs
 * as one transaction with a per-row report, and `dryRun` gives the report
 * without writing. Converting a lead checks its phone against both account
 * tables and links the match.
 */

const { repository, identifiers, payouts, visits, agents, pricing } = vi.hoisted(() => ({
  pricing: { citySupport: vi.fn() },
  visits: { createVisit: vi.fn() },
  agents: { assertAgentAcceptsWork: vi.fn() },
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findNear: vi.fn(),
    findForAdmin: vi.fn(),
    clustersNear: vi.fn(),
    logActivity: vi.fn(),
    findByPhones: vi.fn(),
    findAccountsByPhones: vi.fn(),
    findByNameAndCity: vi.fn(),
    importBatch: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  payouts: { rateFor: vi.fn() },
}));

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../identifiers', () => ({ allocateIdentifier: identifiers.allocateIdentifier }));
vi.mock('../../payouts', () => ({ rateFor: payouts.rateFor }));
vi.mock('../../visits', () => ({ createVisit: visits.createVisit }));
vi.mock('../../agents', () => agents);
// Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued; Mysuru, Navi Mumbai and the rest are typed towns here.
vi.mock('../../pricing', () => ({
  citySupport: pricing.citySupport,
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
}));

import { ApiError } from '../../../shared/errors';
import { convertLead, createLead, importLeads, patchLead, registerWaitlistLead } from '../leads.service';

/** Lot V: the city gate as pricing answers it — Bengaluru launched, Mysuru planned, anything else off the catalogue. */
const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
const cityView = (name: string | null | undefined) =>
  name && /^kochi$/i.test(name)
    ? { support: 'INACTIVE', resolved: true, stage: 'PLANNED', switches: OFF, city: { slug: 'kochi', name: 'Kochi' } }
    : name && /^bengaluru$/i.test(name)
      ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'bengaluru', name: 'Bengaluru' } }
      : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null };
const gate = async (name: string | null | undefined, fn: keyof typeof OPEN) => {
  const view = cityView(name);
  if (view.resolved && !view.switches[fn]) {
    throw new ApiError(400, 'CITY_NOT_OPEN', `ADX is not open for ${fn} in ${view.city!.name} (planned).`, { stage: view.stage, function: fn, city: view.city!.slug });
  }
  return view;
};
import { foldNameCity, normalisePhone } from '../leads.phone';

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Suraj Kumar Prints',
  category: null,
  locality: null,
  city: 'Bengaluru',
  status: 'NEW',
  estimatedCommission: null,
  latitude: null,
  longitude: null,
  contactName: null,
  phone: '9000000001',
  phoneNormalised: '+919000000001',
  interest: null,
  source: null,
  bestTimeFrom: null,
  bestTimeTo: null,
  firstContactedAt: null,
  assignedAgentId: null,
  address: null,
  email: null,
  activity: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  pricing.citySupport.mockImplementation(async (name: string) => cityView(name));
  let seq = 0;
  identifiers.allocateIdentifier.mockImplementation(async () => `LED-000${++seq}`);
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  payouts.rateFor.mockResolvedValue('1450.00');
  repository.findById.mockResolvedValue(lead());
  repository.create.mockImplementation(async (data: Record<string, unknown>) => lead(data));
  repository.update.mockResolvedValue(lead());
  repository.logActivity.mockResolvedValue({});
  repository.findByPhones.mockResolvedValue([]);
  repository.findAccountsByPhones.mockResolvedValue([]);
  repository.findByNameAndCity.mockResolvedValue([]);
  repository.importBatch.mockImplementation(async (rows: { displayId: string }[]) => rows.map((row, i) => ({ id: `led_new_${i}`, displayId: row.displayId })));
});

describe('the phone key', () => {
  it('normalises Indian numbers to E.164 with +91 as the default country', () => {
    expect(normalisePhone('9000000001')).toBe('+919000000001');
    expect(normalisePhone('09000000001')).toBe('+919000000001');
    expect(normalisePhone('+91 90000 00001')).toBe('+919000000001');
    expect(normalisePhone('91-9000000001')).toBe('+919000000001');
    expect(normalisePhone('+1 415 555 0132')).toBe('+14155550132');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });

  it('folds a business name and city for the soft key', () => {
    expect(foldNameCity('Suraj  Kumar Prints ', 'BENGALURU')).toBe('surajkumarprints|bengaluru');
    expect(foldNameCity('Suraj Kumar Prints', null)).toBe('surajkumarprints|');
  });
});

describe('creating one lead', () => {
  it('writes the normalised phone and refuses a number already on a lead', async () => {
    await createLead({ side: 'PUBLISHER', businessName: 'Suraj Kumar Prints', phone: '90000 00001' }, 'usr_admin');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ phone: '90000 00001', phoneNormalised: '+919000000001' }));

    repository.findByPhones.mockResolvedValue([{ id: 'led_9', displayId: 'LED-0009', phoneNormalised: '+919000000001' }]);
    await expect(createLead({ side: 'PUBLISHER', businessName: 'Again', phone: '9000000001' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a number that already belongs to an account', async () => {
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919000000001', kind: 'PUBLISHER', id: 'pub_1' }]);
    await expect(createLead({ side: 'PUBLISHER', businessName: 'X', phone: '9000000001' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, details: { reason: 'EXISTING_ACCOUNT' } });
  });

  it('a patch re-normalises the phone', async () => {
    await patchLead('led_1', 'usr_admin', { phone: '+91 90000 00002' });
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ phone: '+91 90000 00002', phoneNormalised: '+919000000002' }));
  });

  /* Lot X-B: the key beside the typed city. */
  it('a create stamps the city key — the catalogue row for an old spelling, null for a typed town; a patch that moves the city re-keys it, one that does not leaves it alone', async () => {
    await createLead({ side: 'PUBLISHER', businessName: 'Old Spelling', city: 'Bangalore' }, 'usr_admin');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await createLead({ side: 'PUBLISHER', businessName: 'Typed', city: 'Rameswaram' }, 'usr_admin');
    expect(repository.create).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
    await patchLead('led_1', 'usr_admin', { city: 'bengaluru' });
    expect(repository.update).toHaveBeenLastCalledWith('led_1', { city: 'bengaluru', cityId: 'city_bengaluru' });
    await patchLead('led_1', 'usr_admin', { contactName: 'Asha' });
    expect(repository.update).toHaveBeenLastCalledWith('led_1', { contactName: 'Asha' });
  });
});

describe('the waitlist (W-B)', () => {
  const tap = { side: 'ADVERTISER' as const, businessName: 'Nandini Dairy', contactName: 'Asha', phone: '9000000001', city: 'Navi Mumbai', latitude: 19.033, longitude: 73.0297, interest: 'Notify me when Navi Mumbai launches' };

  it('creates the lead once, source WAITLIST, with an IMPORTED row naming the source, and does not refuse the number of the account that tapped', async () => {
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919000000001', kind: 'ADVERTISER', id: 'adv_1' }]);
    const result = await registerWaitlistLead(tap, 'usr_adv');
    expect(result.created).toBe(true);
    // Lot X-B: the waitlist row carries its key too — null here, Navi Mumbai being a typed town in this fixture.
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'WAITLIST', phoneNormalised: '+919000000001', city: 'Navi Mumbai', cityId: null, latitude: 19.033, createdByUserId: 'usr_adv', interest: 'Notify me when Navi Mumbai launches' }));
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IMPORTED', note: 'Added from WAITLIST', actorUserId: 'usr_adv' }));
    // The city gate is not asked: a waitlist is for a city whose lead feeds are off by definition.
    expect(pricing.citySupport).not.toHaveBeenCalled();
  });

  it('a second tap answers the lead the phone is already on and notes the ask on its thread, writing no second lead', async () => {
    repository.findByPhones.mockResolvedValue([{ id: 'led_1', displayId: 'LED-0001', phoneNormalised: '+919000000001' }]);
    const result = await registerWaitlistLead({ ...tap, note: 'Two hoardings on Palm Beach Road' }, 'usr_adv');
    expect(result.created).toBe(false);
    expect(result.lead.id).toBe('led_1');
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'led_1', kind: 'NOTE', note: expect.stringContaining('Navi Mumbai') }));
  });

  it('carries the note onto the IMPORTED row and refuses a number that is not a number', async () => {
    await registerWaitlistLead({ ...tap, note: 'Call after 6' }, 'usr_adv');
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IMPORTED', note: 'Added from WAITLIST: Call after 6' }));
    await expect(registerWaitlistLead({ ...tap, phone: '12' }, 'usr_adv')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('two taps racing each other write one lead: the loser of the partial unique on the phone answers the lead the winner wrote, 200 not 500', async () => {
    // Both taps read no lead on the number; the second insert is refused by
    // `Lead_phoneNormalised_key` and re-reads the row the first one wrote.
    repository.findByPhones.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'led_1', displayId: 'LED-0001', phoneNormalised: '+919000000001' }]);
    repository.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const result = await registerWaitlistLead({ ...tap, note: 'Second tap' }, 'usr_adv');
    expect(result.created).toBe(false);
    expect(result.lead.id).toBe('led_1');
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.logActivity).toHaveBeenCalledTimes(1);
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'led_1', kind: 'NOTE', note: expect.stringContaining('Second tap') }));
  });
});

describe('the import', () => {
  const rows = [
    { side: 'PUBLISHER' as const, businessName: 'Suraj Kumar Prints', city: 'Bengaluru', phone: '9000000001' },
    { side: 'PUBLISHER' as const, businessName: 'Cafe Azzure', city: 'Bengaluru', phone: '9000000002' },
    { side: 'PUBLISHER' as const, businessName: 'Cafe Azzure', city: 'Bengaluru', phone: '9000000002' },
    { side: 'ADVERTISER' as const, businessName: 'Nandini Dairy', city: 'Mysuru', phone: '9000000003' },
    { side: 'PUBLISHER' as const, businessName: 'suraj kumar prints', city: 'bengaluru', phone: '9000000004' },
    { side: 'PUBLISHER' as const, businessName: 'Bad Number', city: 'Mysuru', phone: '12' },
    { side: 'PUBLISHER' as const, businessName: 'No Phone', city: 'Mysuru' },
    // Lot V: Kochi is in the catalogue and PLANNED — no lead feeds there yet. Mysuru is not in this test's catalogue: free text.
    { side: 'PUBLISHER' as const, businessName: 'Backwater Cafe', city: 'Kochi', phone: '9000000005' },
  ];

  it('reports every row, skips duplicates and existing accounts, warns on a name + city match, and writes the rest in one batch', async () => {
    repository.findByPhones.mockResolvedValue([{ id: 'led_old', displayId: 'LED-0009', phoneNormalised: '+919000000001' }]);
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919000000003', kind: 'ADVERTISER', id: 'adv_1' }]);

    const result = await importLeads('Sheet', rows, 'usr_admin');

    expect(result.report.map((row) => [row.row, row.outcome])).toEqual([
      [1, 'DUPLICATE_LEAD'],
      [2, 'CREATED'],
      [3, 'DUPLICATE_LEAD'],
      [4, 'EXISTING_ACCOUNT'],
      [5, 'WARNING'],
      [6, 'INVALID'],
      [7, 'CREATED'],
      [8, 'CITY_NOT_OPEN'],
    ]);
    expect(result.report[0]).toMatchObject({ ref: 'LED-0009' });
    expect(result.report[3]).toMatchObject({ ref: 'adv_1' });
    expect(result.report[4]!.message).toContain('Suraj Kumar Prints');
    expect(result.report[7]).toMatchObject({ message: 'ADX is not taking leads in Kochi (planned)' });
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(5);
    // One lookup per distinct city in the sheet, not one per row.
    expect(pricing.citySupport).toHaveBeenCalledTimes(4);

    expect(repository.importBatch).toHaveBeenCalledTimes(1);
    const batch = repository.importBatch.mock.calls[0]![0] as { businessName: string; phoneNormalised: string | null; source: string; displayId: string; cityId: string | null }[];
    expect(batch.map((row) => row.businessName)).toEqual(['Cafe Azzure', 'suraj kumar prints', 'No Phone']);
    expect(batch[0]).toMatchObject({ phoneNormalised: '+919000000002', source: 'Sheet', displayId: 'LED-0001' });
    // Lot X-B: every imported row carries its key — the catalogue row for Bengaluru however spelt, null for a typed town.
    expect(batch.map((row) => row.cityId)).toEqual(['city_bengaluru', 'city_bengaluru', null]);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledTimes(3);
  });

  it('dryRun returns the same report and writes nothing', async () => {
    const result = await importLeads('Sheet', rows.slice(0, 2), 'usr_admin', { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.report.map((row) => row.outcome)).toEqual(['CREATED', 'CREATED']);
    expect(repository.importBatch).not.toHaveBeenCalled();
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
  });
});

describe('converting', () => {
  it('links the account the phone already belongs to when the caller names none', async () => {
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919000000001', kind: 'PUBLISHER', id: 'pub_7' }]);
    await convertLead('led_1', 'usr_agent', {});
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ status: 'CONVERTED', convertedPublisherId: 'pub_7', convertedAdvertiserId: null }));
  });

  it('refuses a named account that disagrees with the phone, and needs one or the other', async () => {
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919000000001', kind: 'PUBLISHER', id: 'pub_7' }]);
    await expect(convertLead('led_1', 'usr_agent', { publisherId: 'pub_other' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findAccountsByPhones.mockResolvedValue([]);
    await expect(convertLead('led_1', 'usr_agent', {})).rejects.toMatchObject({ statusCode: 400 });
    await convertLead('led_1', 'usr_agent', { advertiserId: 'adv_2' });
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ convertedAdvertiserId: 'adv_2' }));
  });
});
