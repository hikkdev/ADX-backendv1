import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH4 (the Lead Hunt, 22 Sep 2026) — street capture.
 *
 * Pinned: the capture lands on the agent's own list, on the capture
 * source, with the address read back from the point when none was typed
 * and the photos checked as the agent's own LEAD_CAPTURE uploads; the same
 * side within thirty metres is the same wall (409, naming it, saying
 * whether it is theirs); a number on a lead or an account is refused; a
 * seam that cannot reverse-geocode never stops a capture; the placeholder
 * name; the body's bounds.
 */

const { repository, agents, identifiers, pricing, uploads, maps, integrations } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    logActivity: vi.fn(),
    findByPhones: vi.fn().mockResolvedValue([]),
    findAccountsByPhones: vi.fn().mockResolvedValue([]),
    findOpenNear: vi.fn().mockResolvedValue([]),
    findByVehicleNumber: vi.fn().mockResolvedValue(null),
    findSourceByKey: vi.fn().mockResolvedValue({ id: 'lsrc_capture', key: 'capture', kind: 'CAPTURE' }),
    createSource: vi.fn(),
    findForScoring: vi.fn().mockResolvedValue(null),
  },
  agents: { requireAgentProfile: vi.fn(async () => ({ id: 'agt_1', userId: 'usr_agent' })), findAgentProfile: vi.fn(), findAgentTier: vi.fn(async () => 'SILVER'), assertAgentAcceptsWork: vi.fn(), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ enforce: false })) },
  identifiers: { allocateIdentifier: vi.fn(async () => 'LED-0042') },
  pricing: { cityKeyFor: vi.fn(async () => ({ cityId: 'city_blr' })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn() },
  uploads: { findUploadedFile: vi.fn() },
  maps: { reverseGeocode: vi.fn(async () => ({ formattedAddress: '5th Cross, Koramangala, Bengaluru', latitude: 12.93, longitude: 77.62, placeId: null, city: 'Bengaluru', state: 'Karnataka', postalCode: null })) },
  /* VH-2: the RC vendor. Unconfigured by default, which is how it answers
     until Cashfree whitelists us — a capture must survive that. */
  integrations: {
    lookupVehicleRc: vi.fn(async () => ({ ok: false as const, code: 'UNCONFIGURED' as const, message: 'not configured' })),
    normaliseVehicleNumber: (value: string) => value.toUpperCase().replace(/\s+/g, ''),
  },
}));

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../agents', () => agents);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../pricing', () => pricing);
vi.mock('../../uploads', () => uploads);
vi.mock('../../payouts', () => ({ rateFor: vi.fn(async () => '2000.00'), recordIncentiveOnce: vi.fn() }));
vi.mock('../../visits', () => ({ createVisit: vi.fn() }));
vi.mock('../../../shared/maps', () => maps);
vi.mock('../../../shared/integrations', () => integrations);
// Cashfree Phase 1: the RC check goes through the verification router; the vendor's answer is mocked at that door.
vi.mock('../../../shared/verification', () => ({ routedVehicleRc: integrations.lookupVehicleRc }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ leads: { scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } } } })) }));

import { CAPTURE_RADIUS_M, captureLead, captureLeadSchema, placeholderName } from '../capture.service';

const point = { latitude: 12.9352, longitude: 77.6245 };

beforeEach(() => {
  vi.clearAllMocks();
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'led_cap', ...data }));
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
  repository.findById.mockResolvedValue({ id: 'led_cap', displayId: 'LED-0042', side: 'PUBLISHER', businessName: 'x', status: 'NEW', stage: 'SCORED', assignedAgentId: 'agt_1', activity: [], attribution: null });
  repository.findOpenNear.mockResolvedValue([]);
  repository.findByPhones.mockResolvedValue([]);
  repository.findAccountsByPhones.mockResolvedValue([]);
  uploads.findUploadedFile.mockImplementation(async (id: string) => ({ id, purpose: 'LEAD_CAPTURE', userId: 'usr_agent' }));
});

describe('capturing a lead', () => {
  it('lands on the agent, on the capture source, with the address read back from the point, the photos, and the touch', async () => {
    await captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', ...point, photoFileIds: ['file_1', 'file_2'], note: 'Blank wall facing the main road' });
    const created = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(created).toMatchObject({
      side: 'PUBLISHER',
      category: 'Wall',
      businessName: 'Wall surface near 5th Cross',
      address: '5th Cross, Koramangala, Bengaluru',
      locality: '5th Cross',
      city: 'Bengaluru',
      latitude: 12.9352,
      source: 'capture',
      sourceId: 'lsrc_capture',
      assignedAgentId: 'agt_1',
      capturedByAgentId: 'agt_1',
      photoFileIds: ['file_1', 'file_2'],
      interest: 'Blank wall facing the main road',
    });
    expect(created.capturedAt).toBeInstanceOf(Date);
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IMPORTED', note: 'Spotted in the street · 2 photos — Blank wall facing the main road' }));
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'TOUCH_LOGGED' }));
    expect(repository.update.mock.calls.some((call) => (call[1] as { stage?: string }).stage === 'CLAIMED')).toBe(true);
  });

  it('keeps what the agent typed, notes a wide fix, and survives a seam that cannot reverse-geocode', async () => {
    maps.reverseGeocode.mockRejectedValueOnce(new Error('no key'));
    await captureLead('usr_agent', { side: 'ADVERTISER', category: 'Cafe', businessName: 'Third Wave', ...point, accuracy: 120, address: 'Typed address', city: 'Bengaluru', photoFileIds: [] });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ businessName: 'Third Wave', address: 'Typed address', city: 'Bengaluru' });
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ note: 'Spotted in the street (fix ±120 m)' }));
  });

  it('refuses the same wall within thirty metres, naming the lead and whether it is theirs', async () => {
    repository.findOpenNear.mockResolvedValue([
      { id: 'led_far', displayId: 'LED-0001', businessName: 'Far Wall', side: 'PUBLISHER', assignedAgentId: 'agt_9', latitude: 12.9360, longitude: 77.6245 },
      { id: 'led_near', displayId: 'LED-0002', businessName: 'Near Wall', side: 'PUBLISHER', assignedAgentId: 'agt_1', latitude: 12.9353, longitude: 77.6246 },
    ]);
    await expect(captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', ...point, photoFileIds: [] })).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'DUPLICATE_NEARBY', leadId: 'led_near', displayId: 'LED-0002', mine: true },
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(CAPTURE_RADIUS_M).toBe(30);
  });

  it('refuses a number already on a lead or an account, and a photo that is not the agent’s capture', async () => {
    repository.findByPhones.mockResolvedValue([{ id: 'led_1', displayId: 'LED-0001', phoneNormalised: '+919876500000' }]);
    await expect(captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', phone: '9876500000', ...point, photoFileIds: [] })).rejects.toMatchObject({ statusCode: 409, details: { reason: 'DUPLICATE_LEAD' } });
    repository.findByPhones.mockResolvedValue([]);
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919876500000', kind: 'ADVERTISER', id: 'adv_1' }]);
    await expect(captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', phone: '9876500000', ...point, photoFileIds: [] })).rejects.toMatchObject({ statusCode: 409, details: { reason: 'EXISTING_ACCOUNT' } });
    repository.findAccountsByPhones.mockResolvedValue([]);
    uploads.findUploadedFile.mockResolvedValueOnce({ id: 'file_x', purpose: 'LISTING_PHOTO', userId: 'usr_agent' });
    await expect(captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', ...point, photoFileIds: ['file_x'] })).rejects.toMatchObject({ statusCode: 400 });
    uploads.findUploadedFile.mockResolvedValueOnce({ id: 'file_y', purpose: 'LEAD_CAPTURE', userId: 'usr_other' });
    await expect(captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', ...point, photoFileIds: ['file_y'] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('names a nameless capture by what and where, and bounds the body', () => {
    expect(placeholderName({ side: 'PUBLISHER', category: 'Wall', locality: 'Koramangala' })).toBe('Wall surface near Koramangala');
    expect(placeholderName({ side: 'ADVERTISER', category: 'Cafe', address: '12, 5th Cross, Koramangala' })).toBe('Cafe near 12');
    expect(placeholderName({ side: 'PUBLISHER', category: 'Shop front' })).toBe('Shop front surface (spotted)');
    expect(captureLeadSchema.safeParse({ side: 'PUBLISHER', category: 'Wall', latitude: 12.9, longitude: 77.6 }).success).toBe(true);
    expect(captureLeadSchema.safeParse({ side: 'PUBLISHER', category: 'Wall', latitude: 12.9 }).success).toBe(false);
    expect(captureLeadSchema.safeParse({ side: 'PUBLISHER', category: 'Wall', latitude: 12.9, longitude: 77.6, photoFileIds: new Array(7).fill('f') }).success).toBe(false);
  });
});

/**
 * VH-2: a vehicle spotted as an ad spot.
 *
 * Pinned: the registration is the identity, because the thing moves — the
 * thirty-metre dedup that catches the same wall twice cannot catch the same
 * auto a kilometre away, so a registration already on a lead is refused; the
 * RC lookup fills the owner's name and what the vehicle is, so the agent
 * knocks on the window knowing who they are talking to; and an unconfigured
 * vendor never costs the agent the lead.
 */
describe('VH-2: capturing a vehicle', () => {
  const point = { latitude: 12.9352, longitude: 77.6245 };

  /* `clearAllMocks` clears the calls, not the implementations, so the
     defaults these tests share are re-set rather than inherited from
     whichever one ran last. */
  beforeEach(() => {
    repository.findByVehicleNumber.mockResolvedValue(null);
    integrations.lookupVehicleRc.mockResolvedValue({ ok: false, code: 'UNCONFIGURED', message: 'not configured' } as never);
  });

  it('refuses a registration another lead already holds, wherever the vehicle happens to be', async () => {
    repository.findByVehicleNumber.mockResolvedValue({ id: 'led_9', displayId: 'LED-0009', businessName: 'Bajaj RE · KA01AB1234', assignedAgentId: 'agt_2' });
    await expect(
      captureLead('usr_agent', { side: 'PUBLISHER', category: 'Auto', ...point, photoFileIds: [], vehicleNumber: 'ka 01 ab 1234' }),
    ).rejects.toMatchObject({ statusCode: 409, details: { reason: 'DUPLICATE_VEHICLE', displayId: 'LED-0009', mine: false } });
    // Normalised before it is looked up: a plate is read with spaces and in any case.
    expect(repository.findByVehicleNumber).toHaveBeenCalledWith('KA01AB1234');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('names the lead and its contact from the RC when the lookup answers', async () => {
    integrations.lookupVehicleRc.mockResolvedValue({
      ok: true,
      facts: { registrationNumber: 'KA01AB1234', ownerName: 'Ramesh Kumar', maker: 'Bajaj', model: 'RE', vehicleClass: 'Three Wheeler (Passenger)', rcStatus: 'ACTIVE' },
      raw: {},
    } as never);
    await captureLead('usr_agent', { side: 'PUBLISHER', category: 'Auto', ...point, photoFileIds: [], vehicleNumber: 'KA01AB1234' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: 'Bajaj RE · KA01AB1234',
        contactName: 'Ramesh Kumar',
        vehicleNumber: 'KA01AB1234',
        vehicleRcVerifiedAt: expect.any(Date),
      }),
    );
    // The activity line says what was checked and who it belongs to.
    expect(repository.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining('KA01AB1234 verified, Ramesh Kumar') }),
    );
  });

  it('still captures the vehicle when the vendor is unconfigured, and says the RC was not checked', async () => {
    await captureLead('usr_agent', { side: 'PUBLISHER', category: 'Auto', ...point, photoFileIds: [], vehicleNumber: 'KA01AB1234' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'KA01AB1234', vehicleNumber: 'KA01AB1234', vehicleRcVerifiedAt: null, vehicleRcPayload: null }),
    );
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ note: expect.stringContaining('(RC not checked)') }));
  });

  it('leaves an ordinary wall capture exactly as it was', async () => {
    await captureLead('usr_agent', { side: 'PUBLISHER', category: 'Wall', ...point, photoFileIds: [] });
    expect(repository.findByVehicleNumber).not.toHaveBeenCalled();
    expect(integrations.lookupVehicleRc).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ vehicleNumber: null, vehicleRcPayload: null }));
  });
});
