import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH7 (the Lead Hunt, 22 Sep 2026) — digital conversion.
 *
 * Pinned: the invite's arithmetic (an unambiguous code, the URL under the
 * public domain, thirty days, the state, the opens cap, "opened 2 h ago");
 * issuing once and re-issuing (the old code revoked); the landing — the
 * open recorded on the invite and as LINK_OPENED once an hour with the
 * holder told, the copy per side from the ladder, the publisher's rate
 * hook from the comparables and the advertiser's spots / sample / packages,
 * the proposals marked opened, an expired code still answering its state;
 * the OTP door (sign-in, the side opened through the app's own door, the
 * lead converted through the link — channel LINK — the invite marked, a
 * session started; an expired code refused); a callback and a slot (a
 * visit offered to the holder, a call task otherwise); the three proposals
 * (from the comparables, overridden, refused without any; the catalogue's
 * quote; the wrong side refused; PROPOSED; Accept engaging through the
 * link and telling the holder).
 */

type Row = Record<string, unknown> & { id: string };
type NewRow = Record<string, unknown>;

const { leadsRepo, outreach, mocks, state } = vi.hoisted(() => {
  const state = {
    now: new Date('2026-09-22T09:00:00.000Z'),
    leads: new Map<string, Row>(),
    flow: null as Record<string, unknown> | null,
    median: '450.00' as string | null,
    comparables: 4,
    demand: 6,
    spots: 12,
  };
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const invites: Row[] = [];
  const proposals: Row[] = [];
  const outreach = {
    invites,
    proposals,
    reset() {
      invites.length = 0;
      proposals.length = 0;
    },
    async findActiveInvite(leadId: string, now: Date) {
      return [...invites].reverse().find((i) => i['leadId'] === leadId && !i['revokedAt'] && (i['expiresAt'] as Date) > now) ?? null;
    },
    async findInviteByCode(code: string) {
      const i = invites.find((x) => x['code'] === code);
      return i ? { ...i, lead: state.leads.get(i['leadId'] as string) } : null;
    },
    async listInvites(leadId: string) {
      return invites.filter((i) => i['leadId'] === leadId);
    },
    async createInvite(data: NewRow) {
      const row = { opens: [], convertedAt: null, revokedAt: null, createdAt: state.now, ...data, id: id('inv') };
      invites.push(row);
      return row;
    },
    async updateInvite(iid: string, patch: NewRow) {
      const row = invites.find((i) => i.id === iid)!;
      Object.assign(row, patch);
      return row;
    },
    async createProposal(data: NewRow) {
      const row = { openedAt: null, acceptedAt: null, createdAt: state.now, ...data, id: id('prop') };
      proposals.push(row);
      return row;
    },
    async listProposals(leadId: string) {
      return proposals.filter((p) => p['leadId'] === leadId);
    },
    async findProposal(pid: string) {
      return proposals.find((p) => p.id === pid) ?? null;
    },
    async updateProposal(pid: string, patch: NewRow) {
      const row = proposals.find((p) => p.id === pid)!;
      Object.assign(row, patch);
      return row;
    },
    async markProposalsOpened(leadId: string, now: Date) {
      let n = 0;
      for (const p of proposals) if (p['leadId'] === leadId && !p['openedAt']) {
        p['openedAt'] = now;
        n += 1;
      }
      return n;
    },
    async findAgentUser(agentId: string) {
      return agentId === 'agt_1' ? { userId: 'usr_agent', name: 'Asha', mobile: '+919000000001' } : null;
    },
    async findCaller() {
      return null;
    },
    async findUserRoles() {
      return ['PUBLISHER'];
    },
    async findConversation() {
      return null;
    },
    async createConversation(data: NewRow) {
      return { ...data, id: id('conv'), lastInboundAt: null, lastOutboundAt: null, windowClosesAt: null, providerThreadId: null };
    },
    async updateConversation(cid: string, patch: NewRow) {
      return { ...patch, id: cid };
    },
    async createMessage(data: NewRow) {
      return { ...data, id: id('msg') };
    },
    async findMessageByProviderId() {
      return null;
    },
    async listConversations() {
      return [];
    },
    async listMessages() {
      return [];
    },
    async stopRuns() {
      return 0;
    },
  };
  const leadsRepo = {
    findById: vi.fn(async (leadId: string) => state.leads.get(leadId) ?? null),
    update: vi.fn(async (leadId: string, patch: Row) => {
      const row = state.leads.get(leadId);
      if (row) Object.assign(row, patch);
      return row;
    }),
    logActivity: vi.fn(async () => undefined),
    findAccountsByPhones: vi.fn(async () => []),
    rewardsFor: vi.fn(async () => []),
    findByPhones: vi.fn(async () => []),
    findForScoring: vi.fn(async () => null),
    medianLiveRateNear: vi.fn(async () => state.median),
    countLiveListingsNear: vi.fn(async () => state.comparables),
    demandPoints: vi.fn(async () => Array.from({ length: state.demand }, () => ({ latitude: 0, longitude: 0 }))),
    liveListingPoints: vi.fn(async () => Array.from({ length: state.spots }, () => ({ latitude: 0, longitude: 0 }))),
    findAgentBrief: vi.fn(async (agentId: string) => (agentId === 'agt_1' ? { id: 'agt_1', userId: 'usr_agent', city: null, cityId: null, sides: ['PUBLISHER'] } : null)),
  };
  const mocks = {
    auth: {
      normalizeMobile: vi.fn((m: string) => `+91${m.replace(/[^\d]/g, '').slice(-10)}`),
      sendOtp: vi.fn(async () => ({ expiresInSeconds: 300, sendsLeft: 2 })),
      verifyOtp: vi.fn(async () => 'usr_new'),
      startSession: vi.fn(async () => ({ accessToken: 'acc', refreshToken: 'ref' })),
      sessionMeta: vi.fn(() => ({})),
    },
    users: { chooseParty: vi.fn(async (_userId: string, input: { party: string }) => ({ party: input.party, accountType: 'BUSINESS', profileId: input.party === 'PUBLISHER' ? 'pub_1' : 'adv_1', displayId: 'PUB-0001', created: true })) },
    packages: {
      quotePackage: vi.fn(async (input: { tier: string; cycle: string }) => ({ plan: { tier: input.tier, name: 'Growth', pricePerMonth: '4999.00' }, priced: { months: input.cycle === 'ANNUAL' ? 12 : 1, perMonth: '4999.00', total: input.cycle === 'ANNUAL' ? '53989.20' : '5898.82' }, addOns: [{ code: 'BOOST', name: 'Boost', pricePerMonth: '999.00' }] })),
      listCatalogue: vi.fn(async () => ({ packages: [{ tier: 'STARTER', name: 'Starter', pricePerMonth: '1999.00', description: 'Two spots', isPopular: false }, { tier: 'GROWTH', name: 'Growth', pricePerMonth: '4999.00', description: 'Six spots', isPopular: true }], addOns: [] })),
    },
    visits: { createVisit: vi.fn(async (input: { agentId?: string; scheduledFor?: string }) => ({ id: 'vis_1', displayId: 'VIS-0001', agentId: input.agentId ?? 'agt_1', status: 'REQUESTED', scheduledFor: input.scheduledFor })) },
    work: { createSystemTask: vi.fn(async () => ({ id: 'tsk_1', displayId: 'TSK-1', created: true })), completeTaggedTasks: vi.fn(async () => 0), openTaggedTasks: vi.fn(async () => []) },
    notifications: {
      notify: vi.fn(async () => ({ notificationId: 'ntf', templateKey: null, deliveries: [] })),
      quietHoursDeferral: vi.fn(() => null),
      weekWindowIST: vi.fn((now: Date) => ({ start: new Date(now.getTime() - 3 * 86_400_000), end: new Date(now.getTime() + 4 * 86_400_000) })),
      renderText: vi.fn((t: string) => t),
      renderHtml: vi.fn((t: string) => t),
    },
    settings: {
      comms: { quietHours: { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' }, weeklyCapPerUser: 5 },
      leads: { scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } }, claims: { holdHours: 72, caps: { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null }, cooldownDays: 7 }, referralCredit: 250, priority: { topUp: 200, monthlyCap: 25000 } },
    },
    env: { env: { PUBLIC_WEB_URL: 'https://adx.in', BASE_URL: 'http://localhost:3000', PORT: 3000, NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x' } },
  };
  return { leadsRepo, outreach, mocks, state };
});

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: leadsRepo, distanceM: actual.distanceM };
});
vi.mock('../prisma-outreach.repository', () => ({ prismaOutreachRepository: outreach }));
vi.mock('../../auth', () => mocks.auth);
vi.mock('../../visits', () => mocks.visits);
vi.mock('../../work', () => mocks.work);
vi.mock('../../notifications', () => mocks.notifications);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn(async () => null), requireAgentProfile: vi.fn(), findAgentTier: vi.fn(async () => 'SILVER'), assertAgentAcceptsWork: vi.fn(), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ enforce: false })) }));
vi.mock('../../payouts', () => ({ rateFor: vi.fn(async () => '100.00'), recordIncentiveOnce: vi.fn(async () => ({ id: 'inc_1', amount: '100.00' })) }));
vi.mock('../../pricing', () => ({ cityKeyFor: vi.fn(async () => ({ cityId: null })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn(async () => ({ resolved: false })) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'LED-0100') }));
vi.mock('../../qr', () => ({ getQrById: vi.fn() }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn() }));
vi.mock('../../uploads', () => ({ storeGeneratedFile: vi.fn(), purgeStoredFile: vi.fn(), findUploadedFile: vi.fn() }));
vi.mock('../../app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app-config')>();
  return { ...actual, getPlatformSettings: vi.fn(async () => mocks.settings), getFlow: vi.fn(async () => state.flow) };
});
vi.mock('../../../shared/integrations', () => ({ getEffectiveLeadChannelsConfig: vi.fn(async () => ({})), getEffectiveSmsConfig: vi.fn(async () => ({})), getEffectiveEmailConfig: vi.fn(async () => ({})), getEffectiveLeadFormsConfig: vi.fn(async () => ({})), getEffectiveMapsConfig: vi.fn(async () => ({ googleServerKey: null })), DEFAULT_CONSENT_LINE: 'x', DEFAULT_IVR: { greeting: '', publisherPrompt: '', advertiserPrompt: '' } }));
vi.mock('../../../shared/integrations/integration-config', () => ({ getEffectiveLeadChannelsConfig: vi.fn(async () => ({})) }));
vi.mock('../../../shared/cache', () => ({ redis: { set: vi.fn(async () => 'OK'), get: vi.fn(async () => null), del: vi.fn(async () => 1) } }));
vi.mock('../../../config/env', () => mocks.env);

import { CODE_LEAD_LANDING_LADDER } from '../../app-config';
import { inviteState, inviteUrl, inviteView, mintInviteCode, openedAgo, withOpen, INVITE_DAYS, OPENS_KEPT } from '../invites.rules';
import { callbackFromInvite, copyForSide, inviteFor, issueInvite, landingCopy, openLanding, registerPartyOpenerPort, requestInviteOtp, slotFromInvite, verifyInviteOtp } from '../invites.service';
import { acceptProposal, registerPackagePorts, sendProposal, summaryLine } from '../proposals.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const lead = (over: Record<string, unknown> = {}): Row => ({
  id: 'lead_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Sharma Stores',
  contactName: 'Ravi Sharma',
  phone: '+919876543210',
  phoneNormalised: '+919876543210',
  email: null,
  city: 'Pune',
  locality: 'Kothrud',
  category: 'Wall',
  latitude: 18.5,
  longitude: 73.8,
  stage: 'CONTACTED',
  status: 'CONTACTED',
  temperature: 'WARM',
  attribution: null,
  firstContactedAt: new Date('2026-09-21T09:00:00.000Z'),
  assignedAgentId: 'agt_1',
  claimedByAgentId: null,
  claimExpiresAt: null,
  lastTouchedAt: null,
  convertedAt: null,
  convertedPublisherId: null,
  convertedAdvertiserId: null,
  activity: [],
  importance: 'STANDARD',
  requiredGrade: null,
  estimatedCommission: null,
  visitBooked: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  registerPartyOpenerPort(mocks.users.chooseParty as never);
  registerPackagePorts({ quote: mocks.packages.quotePackage as never, catalogue: mocks.packages.listCatalogue as never });
  outreach.reset();
  state.leads.clear();
  state.leads.set('lead_1', lead());
  state.flow = null;
  state.median = '450.00';
  state.comparables = 4;
  state.demand = 6;
  state.spots = 12;
});

describe('LH7: the invite arithmetic (D6)', () => {
  it('mints eight unambiguous characters, builds the link under the public domain, and keeps thirty days', () => {
    const code = mintInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(inviteUrl('ABCD2345')).toBe('https://adx.in/j/ABCD2345');
    expect(INVITE_DAYS).toBe(30);
    const now = new Date('2026-09-22T09:00:00.000Z');
    const live = { expiresAt: new Date(now.getTime() + DAY), revokedAt: null, convertedAt: null };
    expect(inviteState(live, now)).toBe('LIVE');
    expect(inviteState({ ...live, expiresAt: now }, now)).toBe('EXPIRED');
    expect(inviteState({ ...live, revokedAt: now }, now)).toBe('REVOKED');
    expect(inviteState({ ...live, convertedAt: now, revokedAt: now }, now)).toBe('CONVERTED');
  });

  it('keeps the last fifty opens and writes "opened 2 h ago"', () => {
    const now = new Date('2026-09-22T09:00:00.000Z');
    let opens: unknown = [];
    for (let i = 0; i < OPENS_KEPT + 5; i += 1) opens = withOpen(opens, new Date(now.getTime() + i * 1000), i === 0 ? 'Mozilla' : null);
    expect((opens as unknown[]).length).toBe(OPENS_KEPT);
    expect((opens as { ua?: string }[])[0]!.ua).toBeUndefined();
    const view = inviteView({ id: 'inv', leadId: 'l', code: 'ABCD2345', expiresAt: new Date(now.getTime() + DAY), opens, convertedAt: null, revokedAt: null, issuedByUserId: null, createdAt: now } as never, now);
    expect(view).toMatchObject({ url: 'https://adx.in/j/ABCD2345', appLink: 'adx://join/ABCD2345', state: 'LIVE', opens: OPENS_KEPT });
    expect(openedAgo(new Date(now.getTime() - 2 * HOUR).toISOString(), now)).toBe('opened 2 h ago');
    expect(openedAgo(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('opened 5 min ago');
    expect(openedAgo(new Date(now.getTime() - 3 * DAY).toISOString(), now)).toBe('opened 3 d ago');
    expect(openedAgo(now.toISOString(), now)).toBe('opened just now');
    expect(openedAgo(null, now)).toBeNull();
  });

  it('issues once, hands the same live link back, and re-issues by revoking the old code', async () => {
    const first = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    expect(first.state).toBe('LIVE');
    expect(new Date(first.expiresAt).getTime() - state.now.getTime()).toBe(30 * DAY);
    const again = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    expect(again.code).toBe(first.code);
    expect(await inviteFor('lead_1', state.now)).toMatchObject({ code: first.code });
    const fresh = await issueInvite('lead_1', 'usr_agent', { reissue: true, now: state.now });
    expect(fresh.code).not.toBe(first.code);
    expect(outreach.invites[0]).toMatchObject({ revokedAt: state.now });
    expect(await inviteFor('lead_1', state.now)).toMatchObject({ code: fresh.code });
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'NOTE', note: expect.stringContaining('re-issued') }));
  });
});

describe('LH7: the landing', () => {
  it('records the open once an hour as intent and tells the holder; draws the publisher hook from the comparables', async () => {
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    const page = await openLanding(invite.code, { ua: 'Mozilla/5.0' }, state.now);
    expect(page).toMatchObject({ code: invite.code, state: 'LIVE', side: 'PUBLISHER', business: { name: 'Sharma Stores', city: 'Pune' }, agent: { name: 'Asha' }, converted: false, appLink: `adx://join/${invite.code}` });
    expect(page.copy).toMatchObject({ headline: 'Earn from your wall, shutter or screen', cta: 'Get my rate' });
    expect(page.copy.bullets).toHaveLength(3);
    expect(page.copy.blocks.map((b) => b.key)).toEqual(['RATE_ESTIMATE', 'NEARBY_CAMPAIGNS', 'PROPOSALS']);
    expect(page.hook).toEqual({ side: 'PUBLISHER', rateEstimate: { perDay: '450.00', perMonth: '13500.00', comparables: 4, radiusM: 200 }, nearbyCampaigns: 6 });
    expect(leadsRepo.medianLiveRateNear).toHaveBeenCalledWith({ latitude: 18.5, longitude: 73.8 }, 200);
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'LINK_OPENED' }));
    expect(mocks.notifications.notify).toHaveBeenCalledWith('LEAD_LINK_OPENED', 'usr_agent', expect.objectContaining({ businessName: 'Sharma Stores' }), expect.anything());
    expect(outreach.invites[0]!['opens']).toHaveLength(1);
    // A second open inside the hour: recorded on the invite, no second signal.
    vi.clearAllMocks();
    await openLanding(invite.code, {}, new Date(state.now.getTime() + 10 * 60_000));
    expect(outreach.invites[0]!['opens']).toHaveLength(2);
    expect(leadsRepo.logActivity).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'LINK_OPENED' }));
    // Past the hour: the signal again.
    await openLanding(invite.code, {}, new Date(state.now.getTime() + 2 * HOUR));
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'LINK_OPENED' }));
  });

  it('draws the advertiser hook — spots nearby, a sample campaign, the packages — and marks the proposals opened', async () => {
    state.leads.set('lead_1', lead({ side: 'ADVERTISER' }));
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    await sendProposal('lead_1', 'usr_agent', { kind: 'PACKAGE_QUOTE', tier: 'GROWTH', cycle: 'ANNUAL' }, state.now);
    const page = await openLanding(invite.code, {}, state.now);
    expect(page.copy).toMatchObject({ headline: 'Reach your customers on the street', cta: 'Plan my campaign' });
    expect(page.hook).toMatchObject({ side: 'ADVERTISER', nearbySpots: 12, sampleEstimate: { spots: 3, days: 30, perSpotPerDay: '450.00', amount: '40500.00' } });
    expect((page.hook as { packages: { tier: string }[] }).packages.map((p) => p.tier)).toEqual(['STARTER', 'GROWTH']);
    expect(page.proposals).toHaveLength(1);
    expect(page.proposals[0]).toMatchObject({ kind: 'PACKAGE_QUOTE', openedAt: state.now.toISOString(), payload: { tier: 'GROWTH', total: '53989.20', months: 12 } });
  });

  it('an expired or replaced code still answers the page with its state, and records nothing', async () => {
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    const later = new Date(state.now.getTime() + 31 * DAY);
    const page = await openLanding(invite.code, {}, later);
    expect(page.state).toBe('EXPIRED');
    expect(outreach.invites[0]!['opens']).toHaveLength(0);
    await expect(openLanding('NOPE1234', {}, later)).rejects.toMatchObject({ statusCode: 404 });
    await expect(requestInviteOtp(invite.code, '9876543210', later)).rejects.toMatchObject({ statusCode: 410, details: { reason: 'INVITE_EXPIRED' } });
  });

  it('serves the stored copy when the row holds a valid ladder, else the code copy', async () => {
    expect((await landingCopy()).source).toBe('code');
    state.flow = { ...CODE_LEAD_LANDING_LADDER, steps: [{ ...CODE_LEAD_LANDING_LADDER.steps[0]!, title: 'Your wall could pay your rent', hint: 'One\nTwo' }, CODE_LEAD_LANDING_LADDER.steps[1]!], version: 3 };
    const stored = await landingCopy();
    expect(stored.source).toBe('config');
    expect(copyForSide(stored, 'PUBLISHER')).toMatchObject({ headline: 'Your wall could pay your rent', bullets: ['One', 'Two'] });
    state.flow = { steps: 'not a ladder' };
    expect((await landingCopy()).source).toBe('code');
  });
});

describe('LH7: the OTP door and the two asks', () => {
  it('signs the number in, opens the lead’s side through the app’s own door, converts through the link (LINK), marks the invite and starts a session', async () => {
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    const sent = await requestInviteOtp(invite.code, '98765 43210');
    expect(sent).toMatchObject({ mobile: '+919876543210', expiresInSeconds: 300 });
    expect(mocks.auth.sendOtp).toHaveBeenCalledWith('+919876543210', 'LOGIN');
    const result = await verifyInviteOtp(invite.code, { mobile: '9876543210', otp: '123456', name: 'Ravi Sharma' }, {} as never, state.now);
    expect(mocks.auth.verifyOtp).toHaveBeenCalledWith('+919876543210', '123456', 'LOGIN');
    expect(mocks.users.chooseParty).toHaveBeenCalledWith('usr_new', { party: 'PUBLISHER', accountType: 'BUSINESS', name: 'Ravi Sharma' });
    expect(result).toMatchObject({ accessToken: 'acc', refreshToken: 'ref', party: { party: 'PUBLISHER', profileId: 'pub_1' }, lead: { id: 'lead_1', converted: true }, appLink: `adx://join/${invite.code}` });
    expect(state.leads.get('lead_1')).toMatchObject({ status: 'CONVERTED', stage: 'CONVERTED', convertedPublisherId: 'pub_1', attribution: { converted: { channel: 'LINK' } } });
    expect(outreach.invites[0]!['convertedAt']).toEqual(state.now);
    expect(mocks.auth.startSession).toHaveBeenCalledWith('usr_new', ['PUBLISHER'], {});
    // Converting again through the same link is a no-op on the lead.
    const again = await verifyInviteOtp(invite.code, { mobile: '9876543210', otp: '123456' }, {} as never, state.now);
    expect(again.lead.converted).toBe(true);
    expect(mocks.users.chooseParty).toHaveBeenCalledTimes(2);
  });

  it('a callback lands on the holder’s day through the hub and engages the lead through the link', async () => {
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    const result = await callbackFromInvite(invite.code, { note: 'After 6 pm' }, state.now);
    expect(result).toEqual({ taskId: 'tsk_1' });
    expect(mocks.work.createSystemTask).toHaveBeenCalledWith(expect.objectContaining({ tag: 'callback', assigneeUserIds: ['usr_agent'], description: expect.stringContaining('their link') }), state.now);
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'ENGAGED', attribution: { engaged: { channel: 'LINK' } } });
    expect(mocks.notifications.notify).toHaveBeenCalledWith('LEAD_CALLBACK_REQUESTED', 'usr_agent', expect.anything(), expect.anything());
  });

  it('a slot is a visit offered to the holder, or a call task when nobody holds the lead or a call was asked for', async () => {
    const invite = await issueInvite('lead_1', 'usr_agent', { now: state.now });
    const at = new Date(state.now.getTime() + 2 * DAY);
    const visit = await slotFromInvite(invite.code, { at, kind: 'VISIT' }, state.now);
    expect(visit).toEqual({ kind: 'VISIT', visitId: 'vis_1', displayId: 'VIS-0001', at: at.toISOString() });
    expect(mocks.visits.createVisit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ONBOARDING', leadId: 'lead_1', agentId: 'agt_1', scheduledFor: at.toISOString() }), { userId: 'usr_agent', isAdmin: true }, state.now);
    const call = await slotFromInvite(invite.code, { at, kind: 'CALL', note: 'Morning is best' }, state.now);
    expect(call).toMatchObject({ kind: 'CALL', taskId: 'tsk_1' });
    expect(mocks.work.createSystemTask).toHaveBeenCalledWith(expect.objectContaining({ tag: 'callback', deadline: at, assigneeUserIds: ['usr_agent'] }), state.now);
    state.leads.set('lead_1', lead({ assignedAgentId: null }));
    const unheld = await slotFromInvite(invite.code, { at, kind: 'VISIT' }, state.now);
    expect(unheld.kind).toBe('CALL');
    expect(mocks.work.createSystemTask).toHaveBeenLastCalledWith(expect.objectContaining({ assigneeUserIds: [] }), state.now);
    await expect(slotFromInvite(invite.code, { at: new Date(state.now.getTime() - DAY), kind: 'VISIT' }, state.now)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('LH7: proposals', () => {
  it('prices a rate estimate from the comparables, takes the agent’s own figure, and refuses without any', async () => {
    const fromComparables = await sendProposal('lead_1', 'usr_agent', { kind: 'RATE_ESTIMATE' }, state.now);
    expect(fromComparables).toMatchObject({ kind: 'RATE_ESTIMATE', payload: { perDay: '450.00', perMonth: '13500.00', comparables: 4, radiusM: 200, overridden: false } });
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'PROPOSED' });
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PROPOSAL_SENT', note: 'Rate estimate · ₹450.00/day (₹13500.00/month)' }));
    const own = await sendProposal('lead_1', 'usr_agent', { kind: 'RATE_ESTIMATE', perDay: '600', note: 'Corner wall, two-sided' }, state.now);
    expect(own.payload).toMatchObject({ perDay: '600.00', perMonth: '18000.00', overridden: true });
    expect(own.note).toBe('Corner wall, two-sided');
    state.median = null;
    await expect(sendProposal('lead_1', 'usr_agent', { kind: 'RATE_ESTIMATE' }, state.now)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'NO_COMPARABLES' } });
    // The wider radius is tried before giving up.
    expect(leadsRepo.medianLiveRateNear).toHaveBeenLastCalledWith({ latitude: 18.5, longitude: 73.8 }, 2000);
    await expect(sendProposal('lead_1', 'usr_agent', { kind: 'CAMPAIGN_ESTIMATE' }, state.now)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('prices a campaign estimate as spots × days and a package quote off the catalogue, for an advertiser', async () => {
    state.leads.set('lead_1', lead({ side: 'ADVERTISER' }));
    const campaign = await sendProposal('lead_1', 'usr_agent', { kind: 'CAMPAIGN_ESTIMATE', spots: 5, days: 14 }, state.now);
    expect(campaign.payload).toMatchObject({ spots: 5, days: 14, perSpotPerDay: '450.00', amount: '31500.00', overridden: false });
    expect(summaryLine('CAMPAIGN_ESTIMATE', campaign.payload)).toBe('Campaign estimate · 5 spots × 14 days = ₹31500.00');
    const pack = await sendProposal('lead_1', 'usr_agent', { kind: 'PACKAGE_QUOTE', tier: 'GROWTH', addOnCodes: ['BOOST'] }, state.now);
    expect(mocks.packages.quotePackage).toHaveBeenCalledWith({ tier: 'GROWTH', addOnCodes: ['BOOST'], cycle: 'MONTHLY', advertiserId: null });
    expect(pack.payload).toMatchObject({ tier: 'GROWTH', name: 'Growth', cycle: 'MONTHLY', months: 1, perMonth: '4999.00', total: '5898.82', addOns: [{ code: 'BOOST' }] });
    await expect(sendProposal('lead_1', 'usr_agent', { kind: 'RATE_ESTIMATE' }, state.now)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('Accept on the landing stamps the moments, engages through the link and tells the holder — once', async () => {
    const sent = await sendProposal('lead_1', 'usr_agent', { kind: 'RATE_ESTIMATE' }, state.now);
    const accepted = await acceptProposal('lead_1', sent.id, new Date(state.now.getTime() + HOUR));
    expect(accepted.acceptedAt).toBe(new Date(state.now.getTime() + HOUR).toISOString());
    expect(accepted.openedAt).toBe(new Date(state.now.getTime() + HOUR).toISOString());
    expect(state.leads.get('lead_1')).toMatchObject({ attribution: { engaged: { channel: 'LINK' } } });
    expect(mocks.notifications.notify).toHaveBeenCalledWith('LEAD_PROPOSAL_ACCEPTED', 'usr_agent', expect.objectContaining({ proposal: 'Rate estimate · ₹450.00/day (₹13500.00/month)' }), expect.anything());
    vi.clearAllMocks();
    await acceptProposal('lead_1', sent.id, new Date(state.now.getTime() + 2 * HOUR));
    expect(mocks.notifications.notify).not.toHaveBeenCalled();
    await expect(acceptProposal('lead_1', 'prop_nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
