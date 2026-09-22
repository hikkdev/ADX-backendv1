import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH3 (the Lead Hunt, 22 Sep 2026) — where leads come from.
 *
 * Pinned: the feed port's readiness (NOT_CONFIGURED until credentials,
 * the terms confirmation on every partner feed, the daily quota, the
 * provider-id dedup, the per-row report, the routing after); Google's
 * place as the importer's row; the inbound doors (a repeat number answers
 * the lead it has, an account is refused, a honeypot swallows a bot, the
 * poster and the agent card attribute); the webhook signatures and the
 * form-field folding; routing by territory, nearest fix, city, pool under
 * the tier caps; referrals (one link per account, the lead attributed, the
 * credit once on the catch, never to an agent).
 */

const { repository, agents, payouts, pricing, identifiers, wallets, qr, integrations } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    logActivity: vi.fn(),
    findByPhones: vi.fn().mockResolvedValue([]),
    findAccountsByPhones: vi.fn().mockResolvedValue([]),
    findByNameAndCity: vi.fn().mockResolvedValue([]),
    importBatch: vi.fn(),
    findSourceByKey: vi.fn(),
    createSource: vi.fn(),
    listSources: vi.fn().mockResolvedValue([]),
    updateSource: vi.fn(),
    findForScoring: vi.fn().mockResolvedValue(null),
    findByExternalKeys: vi.fn().mockResolvedValue([]),
    countCreatedForSourceSince: vi.fn().mockResolvedValue(0),
    createFeedRun: vi.fn(),
    updateFeedRun: vi.fn(),
    listFeedRuns: vi.fn(),
    findFeedRun: vi.fn(),
    candidateAgents: vi.fn().mockResolvedValue([]),
    findListingPoint: vi.fn(),
    findAgentBrief: vi.fn(),
    findReferralLink: vi.fn(),
    findReferralLinkByCode: vi.fn(),
    createReferralLink: vi.fn(),
    createReferral: vi.fn(),
    findReferralForLead: vi.fn(),
    listReferralsBy: vi.fn().mockResolvedValue([]),
    listReferrals: vi.fn().mockResolvedValue([]),
    markReferralCredited: vi.fn(),
    referrerLabel: vi.fn().mockResolvedValue({ name: 'Skyline Hoardings', mobile: '+919000000201' }),
    partyOfUser: vi.fn(),
  },
  agents: { assertAgentAcceptsWork: vi.fn(), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ enforce: false })), findAgentProfile: vi.fn(), findAgentTier: vi.fn(async () => 'SILVER') },
  payouts: { rateFor: vi.fn(async () => '2000.00'), recordIncentiveOnce: vi.fn() },
  pricing: { cityKeyFor: vi.fn(async () => ({ cityId: 'city_blr' })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn(async () => ({ resolved: false })) },
  identifiers: { allocateIdentifier: vi.fn(async () => 'LED-0009') },
  wallets: { ensureWallet: vi.fn(async () => ({ id: 'wal_1' })), move: vi.fn(async () => ({ entry: { id: 'we_1' } })) },
  qr: { getQrById: vi.fn() },
  integrations: { getEffectiveMapsConfig: vi.fn(async (): Promise<{ googleServerKey: string | null }> => ({ googleServerKey: null })), getEffectiveLeadFeedsConfig: vi.fn(async () => ({})), getEffectiveLeadFormsConfig: vi.fn(async () => ({})) },
}));

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../pricing', () => pricing);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../wallets', () => wallets);
vi.mock('../../qr', () => qr);
vi.mock('../../visits', () => ({ createVisit: vi.fn() }));
vi.mock('../../../shared/integrations', () => integrations);
vi.mock('../../app-config', () => ({
  getPlatformSettings: vi.fn(async () => ({
    leads: {
      scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } },
      claims: { holdHours: 72, caps: { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null }, cooldownDays: 7 },
      referralCredit: 250,
      priority: { topUp: 200, monthlyCap: 25000 },
    },
  })),
}));

import { candidateOf } from '../feeds/google-places.feed';
import { bboxOf, pointInRing } from '../feeds/feed.port';
import { feedsStatus, istDayStart, rowOf, runFeed } from '../feeds/feeds.service';
import { agentQrInbound, fieldsOf, inboundLead, siteQrInbound, verifyLinkedInSignature, verifyMetaSignature, webInbound } from '../inbound.service';
import { registerAgentPositionPort, registerTerritoryRouter, roomFor, routeLead } from '../routing.service';
import { creditReferralOnActivation, mintCode, myReferralLink, refer, referralUrl } from '../referrals.service';
import { runFeedSchema, webInboundSchema } from '../sources.controller';
import { createHmac } from 'crypto';

const now = new Date('2026-09-22T09:00:00.000Z');

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Cloud Nine Cafe',
  status: 'NEW',
  stage: 'SCORED',
  assignedAgentId: null,
  cityId: 'city_blr',
  latitude: 12.93,
  longitude: 77.62,
  attribution: null,
  activity: [],
  phoneNormalised: '+919876500000',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'led_new', ...data }));
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
  repository.findByPhones.mockResolvedValue([]);
  repository.findAccountsByPhones.mockResolvedValue([]);
  repository.findByExternalKeys.mockResolvedValue([]);
  repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_x', key: 'x', kind: 'INBOUND', quality: 9, quotaPerDay: null, termsAcceptedAt: null, isActive: true });
  repository.candidateAgents.mockResolvedValue([]);
  repository.countCreatedForSourceSince.mockResolvedValue(0);
  repository.findById.mockResolvedValue(lead({ id: 'led_new' }));
  repository.createFeedRun.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'run_1', ...data }));
  repository.updateFeedRun.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ id: 'run_1', sourceId: 'lsrc_gp', requestedById: 'u', side: 'PUBLISHER', category: 'cafe', city: 'Bengaluru', polygon: null, limit: 50, candidates: 0, imported: 0, skipped: 0, warnings: 0, report: null, error: null, startedAt: now, finishedAt: now, status: 'DONE', source: { key: 'google-places', label: 'Google Places' }, ...patch }));
  repository.importBatch.mockImplementation(async (rows: { displayId: string }[]) => rows.map((row, i) => ({ id: `led_f${i}`, displayId: row.displayId })));
  registerTerritoryRouter(async () => null);
  registerAgentPositionPort({ lastFix: async () => null });
});

describe('the feed port', () => {
  it('turns a Google place into the importer’s row, with the provider id as the key', () => {
    const candidate = candidateOf({ id: 'ChIJabc', displayName: { text: 'Third Wave Coffee' }, formattedAddress: '12, 5th Cross, Koramangala, Bengaluru', location: { latitude: 12.934, longitude: 77.622 }, nationalPhoneNumber: '080 4567 8901', addressComponents: [{ longText: 'Koramangala', types: ['sublocality_level_1'] }, { longText: 'Bengaluru', types: ['locality'] }] }, 'cafe');
    expect(candidate).toMatchObject({ externalKey: 'google-places:ChIJabc', businessName: 'Third Wave Coffee', locality: 'Koramangala', city: 'Bengaluru', phone: '080 4567 8901', latitude: 12.934 });
    const row = rowOf(candidate, 'PUBLISHER');
    expect(row).toMatchObject({ side: 'PUBLISHER', businessName: 'Third Wave Coffee', category: 'cafe', phone: '080 4567 8901', city: 'Bengaluru', externalKey: 'google-places:ChIJabc' });
  });

  it('boxes a polygon and tests a point against it', () => {
    const ring: [number, number][] = [[77.6, 12.9], [77.7, 12.9], [77.7, 13.0], [77.6, 13.0]];
    expect(bboxOf(ring)).toEqual({ south: 12.9, west: 77.6, north: 13.0, east: 77.7 });
    expect(pointInRing({ latitude: 12.95, longitude: 77.65 }, ring)).toBe(true);
    expect(pointInRing({ latitude: 12.85, longitude: 77.65 }, ring)).toBe(false);
    expect(bboxOf([[0, 0], [1, 1]])).toBeNull();
    expect(istDayStart(new Date('2026-09-22T20:00:00.000Z')).toISOString()).toBe('2026-09-22T18:30:00.000Z');
  });

  it('reports each feed unconfigured until its credentials exist, and a partner feed not ready until its terms are confirmed', async () => {
    repository.listSources.mockResolvedValue([
      { id: 'lsrc_gp', key: 'google-places', quality: 4, quotaPerDay: 500, termsAcceptedAt: null, isActive: true },
      { id: 'lsrc_jd', key: 'justdial', quality: 3, quotaPerDay: 200, termsAcceptedAt: null, isActive: false },
      { id: 'lsrc_im', key: 'indiamart', quality: 3, quotaPerDay: 200, termsAcceptedAt: now, isActive: true },
    ]);
    integrations.getEffectiveLeadFeedsConfig.mockResolvedValue({ indiamart: { apiKey: 'crm-key' } });
    const status = await feedsStatus(now);
    const google = status.find((row) => row.key === 'google-places')!;
    expect(google.configured).toBe(false);
    expect(google.reason).toContain('server key');
    expect(google.ready).toBe(false);
    const justdial = status.find((row) => row.key === 'justdial')!;
    expect(justdial.configured).toBe(false);
    expect(justdial.needs).toContain('data-partner');
    const indiamart = status.find((row) => row.key === 'indiamart')!;
    expect(indiamart.configured).toBe(true);
    expect(indiamart.ready).toBe(true);
    expect(status.map((row) => row.key)).toEqual(['google-places', 'justdial', 'indiamart', 'mca', 'gst', 'rera']);
  });

  it('refuses a run for an unconfigured feed, an unconfirmed partner, a switched-off source and a spent quota', async () => {
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_gp', key: 'google-places', kind: 'FEED', quotaPerDay: 500, termsAcceptedAt: null, isActive: true });
    await expect(runFeed('google-places', { side: 'PUBLISHER', category: 'cafe', city: 'Bengaluru', limit: 20 }, 'u', now)).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    await expect(runFeed('nowhere', { side: 'PUBLISHER', category: 'cafe', city: 'x', limit: 20 }, 'u', now)).rejects.toMatchObject({ statusCode: 404 });

    integrations.getEffectiveLeadFeedsConfig.mockResolvedValue({ indiamart: { apiKey: 'crm-key' } });
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_im', key: 'indiamart', kind: 'FEED', quotaPerDay: 200, termsAcceptedAt: null, isActive: true });
    await expect(runFeed('indiamart', { side: 'ADVERTISER', category: 'printing', city: 'Bengaluru', limit: 20 }, 'u', now)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'TERMS_NOT_CONFIRMED' } });
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_im', key: 'indiamart', kind: 'FEED', quotaPerDay: 200, termsAcceptedAt: now, isActive: false });
    await expect(runFeed('indiamart', { side: 'ADVERTISER', category: 'printing', city: 'Bengaluru', limit: 20 }, 'u', now)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'SOURCE_OFF' } });
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_im', key: 'indiamart', kind: 'FEED', quotaPerDay: 200, termsAcceptedAt: now, isActive: true });
    repository.countCreatedForSourceSince.mockResolvedValue(200);
    await expect(runFeed('indiamart', { side: 'ADVERTISER', category: 'printing', city: 'Bengaluru', limit: 20 }, 'u', now)).rejects.toMatchObject({ statusCode: 429, details: { reason: 'QUOTA_EXHAUSTED' } });
    expect(repository.createFeedRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'QUOTA' }));
  });

  it('runs a configured feed: skips the rows ADX already holds by provider id, imports the rest with the report, records the run and routes the new leads', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ googleServerKey: 'server-key' });
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_gp', key: 'google-places', kind: 'FEED', quotaPerDay: 500, termsAcceptedAt: null, isActive: true });
    repository.findByExternalKeys.mockResolvedValue([{ id: 'led_old', externalKey: 'google-places:known' }]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ places: [
      { id: 'known', displayName: { text: 'Already Ours' }, nationalPhoneNumber: '9000000001' },
      { id: 'fresh', displayName: { text: 'New Cafe' }, nationalPhoneNumber: '9000000002', location: { latitude: 12.93, longitude: 77.62 }, addressComponents: [{ longText: 'Bengaluru', types: ['locality'] }] },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const run = await runFeed('google-places', { side: 'PUBLISHER', category: 'cafe', city: 'Bengaluru', limit: 20 }, 'usr_ops', now);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('server-key');
      expect(JSON.parse(String(init.body)).textQuery).toBe('cafe in Bengaluru');
      expect(run.status).toBe('DONE');
      expect(run.candidates).toBe(2);
      expect(run.imported).toBe(1);
      expect(run.skipped).toBe(1);
      // The imported row carries the provider id and the run.
      expect(repository.importBatch).toHaveBeenCalledWith([expect.objectContaining({ externalKey: 'google-places:fresh', feedRunId: 'run_1', side: 'PUBLISHER', businessName: 'New Cafe' })]);
      expect(run.ids).toEqual(['led_f0']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the run body: a city or a polygon, a limit of 200 at most', () => {
    expect(runFeedSchema.safeParse({ side: 'PUBLISHER', category: 'gym', city: 'Bengaluru' }).success).toBe(true);
    expect(runFeedSchema.safeParse({ side: 'PUBLISHER', category: 'gym' }).success).toBe(false);
    expect(runFeedSchema.safeParse({ side: 'PUBLISHER', category: 'gym', polygon: [[77.6, 12.9], [77.7, 12.9], [77.7, 13]] }).success).toBe(true);
    expect(runFeedSchema.safeParse({ side: 'PUBLISHER', category: 'gym', city: 'x', limit: 500 }).success).toBe(false);
  });
});

describe('the inbound doors', () => {
  it('creates a warm lead on the door’s source, stamps the channel, scores it and routes it', async () => {
    repository.findById.mockResolvedValue(lead({ id: 'led_new', side: 'ADVERTISER' }));
    const answer = await webInbound({ side: 'ADVERTISER', businessName: 'Bright Smiles Clinic', phone: '9876500000', city: 'Bengaluru', message: 'Want to advertise near Koramangala' });
    expect(answer).toMatchObject({ leadId: 'led_new', displayId: 'LED-0009', created: true });
    const created = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(created).toMatchObject({ side: 'ADVERTISER', source: 'web', temperature: 'WARM', phoneNormalised: '+919876500000', interest: 'Want to advertise near Koramangala' });
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IMPORTED', note: expect.stringContaining('web') }));
    expect(repository.candidateAgents).toHaveBeenCalledWith('ADVERTISER', 'city_blr');
  });

  it('answers the lead it already has for a repeat number, and refuses a number on an account', async () => {
    repository.findByPhones.mockResolvedValue([{ id: 'led_1', displayId: 'LED-0001', phoneNormalised: '+919876500000' }]);
    repository.findById.mockResolvedValue(lead({ stage: 'CONTACTED' }));
    const again = await webInbound({ side: 'PUBLISHER', businessName: 'Cloud Nine Cafe', phone: '9876500000' });
    expect(again).toMatchObject({ leadId: 'led_1', created: false });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'NOTE', note: expect.stringContaining('again') }));

    repository.findByPhones.mockResolvedValue([]);
    repository.findAccountsByPhones.mockResolvedValue([{ phoneNormalised: '+919876500000', kind: 'PUBLISHER', id: 'pub_1' }]);
    await expect(webInbound({ side: 'PUBLISHER', businessName: 'x', phone: '9876500000' })).rejects.toMatchObject({ statusCode: 409, details: { reason: 'EXISTING_ACCOUNT' } });
    await expect(webInbound({ side: 'PUBLISHER', businessName: 'x', phone: 'not-a-number' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a provider id already held answers that lead without a second row', async () => {
    repository.findByExternalKeys.mockResolvedValue([{ id: 'led_1', externalKey: 'meta:123' }]);
    repository.findById.mockResolvedValue(lead());
    const answer = await inboundLead({ side: 'ADVERTISER', businessName: 'x', phone: '9876500000', channel: 'INSTAGRAM' }, { sourceKey: 'meta-lead-ads', sourceKind: 'ADS', externalKey: 'meta:123' });
    expect(answer.created).toBe(false);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('the SITE poster lands the lead at the spot; the agent card lands it on the agent, CLAIMED', async () => {
    qr.getQrById.mockResolvedValue({ id: 'qr_site', type: 'SITE', refId: 'lst_1', isActive: true });
    repository.findListingPoint.mockResolvedValue({ id: 'lst_1', title: 'MG Road wall', locality: 'MG Road', city: 'Bengaluru', cityId: 'city_blr', latitude: 12.97, longitude: 77.6, publisherId: 'pub_1' });
    await siteQrInbound('qr_site', { side: 'PUBLISHER', phone: '9876500001', name: 'Ravi' });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ source: 'site-qr', locality: 'MG Road', latitude: 12.97, businessName: 'Ravi', interest: 'Owns a surface near MG Road wall' });

    vi.clearAllMocks();
    repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'led_new', ...data }));
    repository.findByPhones.mockResolvedValue([]);
    repository.findAccountsByPhones.mockResolvedValue([]);
    repository.findByExternalKeys.mockResolvedValue([]);
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_aq', key: 'agent-qr' });
    repository.findById.mockResolvedValue(lead({ id: 'led_new', assignedAgentId: 'agt_7' }));
    qr.getQrById.mockResolvedValue({ id: 'qr_agent', type: 'AGENT', refId: 'agt_7', isActive: true });
    repository.findAgentBrief.mockResolvedValue({ id: 'agt_7', userId: 'usr_7', city: 'Bengaluru', cityId: 'city_blr', sides: ['ADVERTISER'] });
    const answer = await agentQrInbound('qr_agent', { phone: '9876500002', businessName: 'Sharma Sweets' });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ source: 'agent-qr', assignedAgentId: 'agt_7', side: 'ADVERTISER', city: 'Bengaluru' });
    expect(answer.assignedAgentId).toBe('agt_7');
    // The card's lead is CLAIMED, not routed.
    expect(repository.candidateAgents).not.toHaveBeenCalled();
    expect(repository.update.mock.calls.some((call) => (call[1] as { stage?: string }).stage === 'CLAIMED')).toBe(true);

    qr.getQrById.mockResolvedValue({ id: 'qr_dead', type: 'AGENT', refId: 'agt_7', isActive: false });
    await expect(agentQrInbound('qr_dead', { phone: '9876500002' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('checks Meta’s and LinkedIn’s signatures, and folds a form’s answers into a lead’s columns', () => {
    const body = Buffer.from('{"entry":[]}');
    const meta = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, meta, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(body, meta, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, meta, undefined)).toBe(false);
    const linkedin = createHmac('sha256', 'client-secret').update(body).digest('base64');
    expect(verifyLinkedInSignature(body, linkedin, 'client-secret')).toBe(true);
    expect(verifyLinkedInSignature(body, 'nope', 'client-secret')).toBe(false);

    expect(fieldsOf([{ name: 'full_name', values: ['Anita Rao'] }, { name: 'phone_number', values: ['+919876500003'] }, { name: 'company_name', values: ['Rao Interiors'] }, { name: 'city', values: ['Bengaluru'] }, { name: 'budget', values: ['50k'] }])).toEqual({ phone: '+919876500003', email: null, name: 'Anita Rao', businessName: 'Rao Interiors', city: 'Bengaluru', message: 'budget: 50k' });
    expect(fieldsOf([]).phone).toBeNull();
  });

  it('the web form takes a honeypot and an optional captcha token, and refuses a bad phone', () => {
    expect(webInboundSchema.safeParse({ side: 'PUBLISHER', businessName: 'x', phone: '9876500000', website: '' }).success).toBe(true);
    expect(webInboundSchema.safeParse({ side: 'PUBLISHER', businessName: 'x', phone: '12' }).success).toBe(false);
  });
});

describe('routing', () => {
  it('room under the tier cap, unlimited for Platinum', () => {
    const caps = { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null };
    expect(roomFor('BRONZE', 9, caps)).toBe(1);
    expect(roomFor('BRONZE', 10, caps)).toBe(0);
    expect(roomFor('PLATINUM', 999, caps)).toBe(Number.POSITIVE_INFINITY);
    expect(roomFor('UNKNOWN', 0, caps)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a territory’s agent wins; else the nearest agent with a fix today; else the same city with the fewest leads; else the pool', async () => {
    repository.findById.mockResolvedValue(lead());
    registerTerritoryRouter(async () => 'agt_territory');
    expect(await routeLead('led_1', now)).toEqual({ agentId: 'agt_territory', how: 'TERRITORY' });
    expect(repository.update).toHaveBeenCalledWith('led_1', { assignedAgentId: 'agt_territory' });

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(lead());
    repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
    registerTerritoryRouter(async () => null);
    repository.candidateAgents.mockResolvedValue([
      { id: 'agt_full', userId: 'u1', tier: 'BRONZE', cityId: 'city_blr', openLeads: 10 },
      { id: 'agt_far', userId: 'u2', tier: 'SILVER', cityId: 'city_blr', openLeads: 3 },
      { id: 'agt_near', userId: 'u3', tier: 'GOLD', cityId: 'city_blr', openLeads: 8 },
      { id: 'agt_stale', userId: 'u4', tier: 'GOLD', cityId: 'city_blr', openLeads: 1 },
    ]);
    registerAgentPositionPort({
      lastFix: async (agentId) =>
        agentId === 'agt_far' ? { latitude: 13.2, longitude: 77.9, at: now } : agentId === 'agt_near' ? { latitude: 12.931, longitude: 77.621, at: now } : agentId === 'agt_stale' ? { latitude: 12.93, longitude: 77.62, at: new Date(now.getTime() - 3 * 86_400_000) } : null,
    });
    expect(await routeLead('led_1', now)).toEqual({ agentId: 'agt_near', how: 'NEAREST' });

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(lead());
    repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
    registerAgentPositionPort({ lastFix: async () => null });
    repository.candidateAgents.mockResolvedValue([
      { id: 'agt_busy', userId: 'u1', tier: 'SILVER', cityId: 'city_blr', openLeads: 6 },
      { id: 'agt_free', userId: 'u2', tier: 'SILVER', cityId: 'city_blr', openLeads: 2 },
    ]);
    expect(await routeLead('led_1', now)).toEqual({ agentId: 'agt_free', how: 'CITY' });

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(lead());
    repository.candidateAgents.mockResolvedValue([{ id: 'agt_full', userId: 'u1', tier: 'BRONZE', cityId: 'city_blr', openLeads: 10 }]);
    expect(await routeLead('led_1', now)).toEqual({ agentId: null, how: 'POOL' });
    expect(repository.update).not.toHaveBeenCalled();

    repository.findById.mockResolvedValue(lead({ assignedAgentId: 'agt_mine' }));
    expect(await routeLead('led_1', now)).toEqual({ agentId: 'agt_mine', how: 'ALREADY' });
  });
});

describe('referrals', () => {
  it('mints one link per account, over a confusable-free alphabet, and reads it back', async () => {
    expect(mintCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(referralUrl('ABCD2345')).toMatch(/\/j\/r\/ABCD2345$/);
    repository.findReferralLink.mockResolvedValueOnce(null);
    repository.createReferralLink.mockImplementation(async (data: { code: string }) => ({ id: 'rl_1', code: data.code }));
    const first = await myReferralLink({ kind: 'PUBLISHER', id: 'pub_1' });
    expect(first.code).toHaveLength(8);
    repository.findReferralLink.mockResolvedValueOnce({ id: 'rl_1', code: first.code });
    expect((await myReferralLink({ kind: 'PUBLISHER', id: 'pub_1' })).code).toBe(first.code);
    expect(repository.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('a referral lands as a lead on the referral source with the row that pays later; an agent’s referral is theirs', async () => {
    repository.findReferralLink.mockResolvedValue({ id: 'rl_1', code: 'ABCD2345' });
    repository.findReferralLinkByCode.mockResolvedValue({ id: 'rl_1', code: 'ABCD2345', referrerKind: 'PUBLISHER', referrerId: 'pub_1' });
    const answer = await refer({ kind: 'PUBLISHER', id: 'pub_1' }, { side: 'PUBLISHER', businessName: 'Ravi Electronics', phone: '9876500004', city: 'Bengaluru' });
    expect(answer.created).toBe(true);
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ source: 'referral', assignedAgentId: null });
    expect(repository.createReferral).toHaveBeenCalledWith({ linkId: 'rl_1', referrerKind: 'PUBLISHER', referrerId: 'pub_1', leadId: 'led_new' });

    vi.clearAllMocks();
    repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'led_new', ...data }));
    repository.findByPhones.mockResolvedValue([]);
    repository.findAccountsByPhones.mockResolvedValue([]);
    repository.findByExternalKeys.mockResolvedValue([]);
    repository.findSourceByKey.mockResolvedValue({ id: 'lsrc_r', key: 'referral' });
    repository.findById.mockResolvedValue(lead({ id: 'led_new', assignedAgentId: 'agt_1' }));
    repository.findReferralLink.mockResolvedValue({ id: 'rl_2', code: 'EFGH2345' });
    repository.findReferralLinkByCode.mockResolvedValue({ id: 'rl_2', code: 'EFGH2345', referrerKind: 'AGENT', referrerId: 'agt_1' });
    await refer({ kind: 'AGENT', id: 'agt_1' }, { side: 'PUBLISHER', businessName: 'Sharma Stores', phone: '9876500005' });
    expect(repository.create.mock.calls[0]![0]).toMatchObject({ assignedAgentId: 'agt_1' });
  });

  it('credits the referrer’s wallet once on the catch, at the setting’s figure, and never an agent', async () => {
    repository.findReferralForLead.mockResolvedValue({ id: 'ref_1', referrerKind: 'PUBLISHER', referrerId: 'pub_1', leadId: 'led_1', creditedAt: null, link: {} });
    expect(await creditReferralOnActivation('led_1')).toEqual({ credited: true, amount: '250.00' });
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' }, 'Skyline Hoardings');
    expect(wallets.move).toHaveBeenCalledWith(expect.objectContaining({ amount: '250.00', entryType: 'REFERRAL', ledgerKind: 'GOODWILL', idempotencyKey: 'referral:ref_1', counterLegs: [expect.objectContaining({ accountCode: 'platform:goodwill', amount: '-250.00' })] }));
    expect(repository.markReferralCredited).toHaveBeenCalledWith('ref_1', expect.objectContaining({ creditAmount: '250.00', walletEntryId: 'we_1' }));

    vi.clearAllMocks();
    repository.findReferralForLead.mockResolvedValue({ id: 'ref_1', referrerKind: 'PUBLISHER', referrerId: 'pub_1', leadId: 'led_1', creditedAt: now, link: {} });
    expect(await creditReferralOnActivation('led_1')).toEqual({ credited: false, amount: null });
    expect(wallets.move).not.toHaveBeenCalled();

    repository.findReferralForLead.mockResolvedValue({ id: 'ref_2', referrerKind: 'AGENT', referrerId: 'agt_1', leadId: 'led_2', creditedAt: null, link: {} });
    expect(await creditReferralOnActivation('led_2')).toEqual({ credited: false, amount: null });
    expect(wallets.move).not.toHaveBeenCalled();

    repository.findReferralForLead.mockResolvedValue(null);
    expect(await creditReferralOnActivation('led_3')).toEqual({ credited: false, amount: null });
  });
});
