import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyPaths, pathsEndingIn, project, row, SECRET_KEYS, type ProjectionOptions } from '../support/prisma-projection';
import { ORDER_RISK_KEYS } from '../../src/shared/database/prisma';
import { ORDER_RISK_FIELDS, ORDER_REVIEW_NOTICE } from '../../src/modules/orders/orders.redact';

/**
 * 2 Oct 2026: `GET /orders/:id` answered the publisher, the agent and the
 * advertiser of an order with each other's whole User rows — `passwordHash`,
 * `totpSecretEnc`, email, date of birth, gender — and whole AgentProfile and
 * Publisher rows (home address, emergency contact, screening notes, GSTIN).
 *
 * Two layers now stand in the way: the client's global omit (no credential
 * column leaves a read that does not name it) and an explicit `select` on
 * every person and party an order carries. These tests run the real
 * controller, queries and repositories over a stand-in for Prisma that shapes
 * whole fixture rows by the arguments the repositories pass — once with the
 * global omit and once without it, so each layer is shown to hold on its own.
 */

const fake = vi.hoisted(() => ({
  prisma: {} as Record<string, Record<string, (args?: any) => unknown>>,
  agentProfile: { current: null as { id: string } | null },
}));

vi.mock('../../src/shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/database')>();
  return { ...actual, prisma: fake.prisma };
});

vi.mock('../../src/modules/agents', () => ({
  requireAgentProfile: vi.fn(async () => fake.agentProfile.current),
  findAgentProfile: vi.fn(async () => fake.agentProfile.current),
  dispatchAskFor: vi.fn(async () => ({})),
  isBelowRequiredGrade: vi.fn(async () => false),
  agentMeetsGrade: vi.fn(async () => true),
  getRoutingSettings: vi.fn(async () => ({ bands: {}, leadBands: {}, enforce: true })),
}));

vi.mock('../../src/modules/orders/print-job.port', () => ({
  printJobPort: () => ({
    printJobFor: async () => null,
    pickupsFor: async () => new Map(),
    markCollected: async () => undefined,
  }),
}));

import { getOrderByIdHandler } from '../../src/modules/orders/orders.controller';
import { getAllOrders, getOrdersForAdvertiser, getOrdersForAgent, getOrdersForPublisher } from '../../src/modules/orders/orders.queries';
import { listingViewHandler } from '../../src/modules/listings/listings.controller';
import { prismaOrdersRepository } from '../../src/modules/orders/prisma-orders.repository';
import { prismaOrderMilestonesRepository } from '../../src/modules/order-milestones/prisma-order-milestones.repository';
import { prismaOnboardingRepository } from '../../src/modules/onboarding/prisma-onboarding.repository';
import { listCampaignsPage } from '../../src/modules/campaigns/campaigns.service';
import { launchQueue, listLandingPagesForConsole, consoleDetailExtras } from '../../src/modules/campaigns/console.service';
import { campaignPerformance } from '../../src/modules/campaigns/analytics.service';
import { getListingForAdmin } from '../../src/modules/listings/listings.service';
import { getListingRecordForAdmin } from '../../src/modules/listings/listing-desk.service';
import { landingPageListQuerySchema, launchQueueQuerySchema, listCampaignsQuerySchema } from '../../src/modules/campaigns/campaigns.schema';

/* ── Whole rows: every column a careless include would let out ───────── */

const person = (id: string, name: string, mobile: string) =>
  row('user', {
    id,
    displayId: `ADX-${id}`,
    mobile,
    name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1] ?? null,
    dateOfBirth: new Date('1990-04-01'),
    gender: 'FEMALE',
    email: `${id}@example.com`,
    emailVerifiedAt: new Date('2026-09-01'),
    passwordHash: `$2a$10$hash-of-${id}`,
    totpSecretEnc: `iv:tag:secret-of-${id}`,
    totpEnrolledAt: new Date('2026-09-02'),
    twoFactorRequiredAt: null,
    emailOtpFallbackCount: 0,
    avatarUrl: `https://cdn.example/${id}.jpg`,
    lastLoginAt: new Date('2026-10-01'),
    isActive: true,
  });

const ADVERTISER = person('usr_adv', 'Asha Rao', '+919800000001');
const PUBLISHER_LOGIN = person('usr_pub', 'Pavan Kumar', '+919800000002');
const INSTALLER_LOGIN = person('usr_agent', 'Imran Shaikh', '+919800000003');
const OFFERED_LOGIN = person('usr_agent2', 'Om Prakash', '+919800000004');
const SPOT_AGENT_LOGIN = person('usr_lagent', 'Lata Iyer', '+919800000005');

const agentProfile = (id: string, user: { id: string }) =>
  row('agentProfile', {
    id,
    userId: user.id,
    displayId: `AGT-${id}`,
    city: 'Pune',
    currentAddress: '12 Home Street, Pune',
    permanentAddress: '4 Village Road',
    emergencyContactName: 'Next Of Kin',
    emergencyContactPhone: '+919811111111',
    screeningNote: 'private screening note',
    rejectionReason: null,
    grade: 'G2',
    user,
  });

const INSTALLER = agentProfile('agt_1', INSTALLER_LOGIN);
const OFFERED = agentProfile('agt_2', OFFERED_LOGIN);
const SPOT_AGENT = agentProfile('agt_spot', SPOT_AGENT_LOGIN);

const PUBLISHER = row('publisher', {
  id: 'pub_1',
  userId: 'usr_pub',
  agentId: 'agt_spot',
  displayId: 'PUB-1',
  name: 'Kumar Hoardings',
  mobile: '+919822222222',
  email: 'billing@kumar.example',
  gstin: '27ABCDE1234F1Z5',
  contactEmail: 'owner@kumar.example',
  address: '7 Market Road',
  city: 'Pune',
  state: 'MH',
  suspensionReason: null,
  user: PUBLISHER_LOGIN,
  agent: SPOT_AGENT,
});

const LISTING = row('listing', {
  id: 'lst_1',
  title: 'Station Road hoarding',
  city: 'Pune',
  publisherId: 'pub_1',
  agentId: 'agt_spot',
  // LD-1 (3 Oct 2026): the publisher's own statement to ADX about the spot.
  extraAnswers: [{ key: 'society_contact', label: 'Society secretary’s number', value: '+919833333333' }],
  documentWaivers: [{ kind: 'MUNICIPAL_PERMIT', reason: 'Private land', at: '2026-10-01T00:00:00.000Z' }],
  termsAcceptedAt: new Date('2026-10-01T00:00:00Z'),
  termsVersion: 'flows.listing:v3',
  ownershipDeclaredAt: new Date('2026-10-01T00:00:00Z'),
  // 3 Oct 2026: the sticker's token (scanning it proves presence) and the RC answer (the vehicle owner's name).
  qrToken: 'qr-token-that-opens-a-check-in',
  vehicleRcPayload: { owner_name: 'Vikram Vehicle-Owner', address: '9 Garage Lane' },
  publisher: PUBLISHER,
  agent: SPOT_AGENT,
});

/** The listing's private columns: no order read hands them to anyone (3 Oct 2026). */
const LISTING_PRIVATE_KEYS = ['qrToken', 'vehicleRcPayload'];

/** LD-1: the listing columns another party to an order never reads. */
const PUBLISHER_RECORD_KEYS = ['extraAnswers', 'documentWaivers', 'termsAcceptedAt', 'termsVersion', 'ownershipDeclaredAt'];

const ORDER = row('order', {
  id: 'ord_1',
  displayId: 'BKG-1',
  advertiserId: 'usr_adv',
  listingId: 'lst_1',
  agentId: 'agt_1',
  status: 'PENDING_OTP',
  completionOtp: '$2a$10$hash-of-the-code',
  completionOtpPlain: '482913',
  completionOtpExpiry: new Date('2026-10-02T10:00:00Z'),
  // Order fraud screening (2 Oct 2026): held, flagged, with reasons that name the word a party must never read.
  riskScore: '0.870',
  riskSignals: [{ key: 'LINKED_PARTIES', weight: 0.5, value: 1, detail: 'Possible fraud ring: the advertiser and the publisher share a bank account.', side: 'ORDER' }],
  riskBand: 'HOLD',
  riskScoredAt: new Date('2026-10-02T09:00:00Z'),
  riskReviewStatus: 'FLAGGED',
  riskReviewedById: null,
  riskReviewedAt: null,
  riskReviewNote: 'Looks like fraud — check the bank',
  riskClearedSignalKeys: [],
  heldAt: new Date('2026-10-02T09:05:00Z'),
  heldById: 'usr_admin',
  holdReason: 'Suspected fraud: shared bank account',
  fraudCaseId: 'frd_1',
  listing: LISTING,
  advertiser: ADVERTISER,
  agent: INSTALLER,
  agentAssignments: [
    row('orderAgentAssignment', { id: 'asg_1', agentId: 'agt_1', status: 'ACCEPTED', quotedFee: null, agent: INSTALLER }),
    row('orderAgentAssignment', { id: 'asg_2', agentId: 'agt_2', status: 'REJECTED', quotedFee: null, agent: OFFERED }),
  ],
  checkIn: row('checkIn', { id: 'chk_1', orderId: 'ord_1', latitude: 18.5, longitude: 73.8, distanceM: 12 }),
  verification: row('orderVerification', { id: 'ver_1', orderId: 'ord_1', qrScanned: true }),
  milestones: [row('orderMilestone', { id: 'ms_1', status: 'DONE', order: 1, template: row('orderMilestoneTemplate', { id: 'tpl_1', title: 'Install' }) })],
  campaignSpot: row('campaignSpot', { id: 'spot_1', campaignId: 'cmp_1' }),
});

const MILESTONE = row('orderMilestone', {
  id: 'ms_1',
  orderId: 'ord_1',
  status: 'DISPATCHED',
  template: row('orderMilestoneTemplate', { id: 'tpl_1', title: 'Install' }),
  assignedAgent: INSTALLER,
  evidence: [row('milestoneEvidence', { id: 'ev_1', url: 'https://cdn.example/ev.jpg' })],
  orderRecord: ORDER,
});

const SUBMISSION = row('onboardingSubmission', {
  id: 'sub_1',
  status: 'PENDING',
  flowTemplate: row('onboardingFlowTemplate', { id: 'flow_1', key: 'publisher' }),
  user: row('user', { ...ADVERTISER, roles: [row('userRole', { id: 'role_1', role: 'ADVERTISER' })] }),
});

/* The Campaigns lot (2 Oct 2026): a campaign with its advertiser's whole party row and login behind it. */
const ADVERTISER_PARTY = row('advertiser', {
  id: 'adv_1',
  userId: 'usr_adv',
  displayId: 'ADV-1909-2601',
  name: 'Rao Foods',
  companyName: 'Rao Foods Pvt Ltd',
  mobile: '+919833333333',
  email: 'accounts@rao.example',
  gstin: '29ABCDE1234F1Z5',
  billingAddress: '1 Billing Street',
  city: 'Pune',
  kycStatus: 'PENDING',
  suspensionScopes: [],
  suspensionReason: null,
  user: ADVERTISER,
});

const CAMPAIGN = row('campaign', {
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-482913',
  name: 'Diwali push',
  status: 'SCHEDULED',
  advertiserId: 'adv_1',
  agentId: null,
  goal: 'BRAND_AWARENESS',
  brandName: 'Rao',
  targetLocation: 'Pune',
  budget: '60000.00',
  total: '59000.00',
  startDate: new Date('2026-10-12T00:00:00Z'),
  endDate: new Date('2026-10-25T00:00:00Z'),
  createdAt: new Date('2026-09-20T10:00:00Z'),
  updatedAt: new Date('2026-09-25T10:00:00Z'),
  submittedForPaymentAt: null,
  paidAt: new Date('2026-09-25T10:00:00Z'),
  reservationFeeStatus: null,
  reservationFeeAmount: null,
  reservationFeeDueAt: null,
  reservationFeePaidAt: null,
  creativePath: 'STATIC_IMAGES',
  designQuoteStatus: null,
  designQuoteAmount: null,
  designQuotedAt: null,
  contactEmail: 'brand@rao.example',
  contactPhone: '+919844444444',
  _count: { spots: 1 },
  advertiser: ADVERTISER_PARTY,
  creatives: [row('campaignCreative', { id: 'cr_1', resubmissionOfId: null, fileUrl: 'https://cdn.example/a.png', status: 'IN_REVIEW', designedByAdx: false, reviewNote: 'internal' })],
  spots: [row('campaignSpot', { id: 'spot_1', status: 'BOOKED', ratePerDay: '1000.00', quantity: 1, order: ORDER })],
  // The whole page row behind it — the list carries only the detail's narrow summary.
  landingPage: row('landingPage', { id: 'lp_1', campaignId: 'cmp_1', slug: 'rao-diwali', status: 'PUBLISHED', publishedAt: new Date('2026-09-28T10:00:00Z'), blocks: [{ type: 'hero', headline: 'x' }], theme: null, version: 2, createdByUserId: 'usr_adv' }),
});

const LANDING_PAGE = row('landingPage', {
  id: 'lp_1',
  campaignId: 'cmp_1',
  slug: 'rao-diwali',
  blocks: [{ type: 'hero', headline: 'Diwali at Rao' }],
  theme: null,
  version: 2,
  status: 'PUBLISHED',
  generatedByAi: true,
  publishedAt: new Date('2026-09-28T10:00:00Z'),
  createdByUserId: 'usr_adv',
  createdAt: new Date('2026-09-27T10:00:00Z'),
  updatedAt: new Date('2026-09-28T10:00:00Z'),
  campaign: CAMPAIGN,
});

/* ── The stand-in, shaping those rows by what each read asks for ─────── */

const options: ProjectionOptions = { globalOmit: true };
const shaped = (fixture: unknown) => (args?: unknown) => project(fixture, args as never, options);
const listOf = (fixture: unknown) => (args?: unknown) => [project(fixture, args as never, options)];

Object.assign(fake.prisma, {
  order: {
    findUnique: shaped(ORDER),
    findMany: listOf(ORDER),
    create: shaped(ORDER),
    count: () => 1,
    groupBy: () => [],
  },
  user: { findUnique: shaped(ADVERTISER), findMany: () => [] },
  orderMilestone: { findMany: listOf(MILESTONE), findUnique: shaped(MILESTONE), findFirst: shaped(MILESTONE), update: shaped(MILESTONE) },
  onboardingSubmission: { findMany: listOf(SUBMISSION), findUnique: shaped(SUBMISSION), count: () => 1, groupBy: () => [] },
  campaign: { findMany: listOf(CAMPAIGN), count: () => 1, groupBy: () => [] },
  campaignTrackingCode: { findMany: () => [{ id: 'code_1', campaignId: 'cmp_1', scans: 4 }] },
  trackingEvent: { groupBy: () => [{ codeId: 'code_1', type: 'VIEW', _count: { _all: 2 } }] },
  landingPage: { findMany: listOf(LANDING_PAGE), count: () => 1, groupBy: () => [] },
  $queryRaw: () => [],
});

/** Order fraud screening: the risk and hold columns — every one of them ADX's alone. */
const RISK_KEYS = [...ORDER_RISK_KEYS];

/** Private facts of a person or a party: never on another party's screen. */
const PRIVATE_KEYS = [
  'email',
  'dateOfBirth',
  'gender',
  'lastLoginAt',
  'emailVerifiedAt',
  'totpEnrolledAt',
  'gstin',
  'contactEmail',
  'currentAddress',
  'permanentAddress',
  'emergencyContactName',
  'emergencyContactPhone',
  'screeningNote',
] as const;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

type Caller = { name: string; sub: string; roles: string[]; agent: { id: string } | null };
const ADMIN: Caller = { name: 'ADMIN', sub: 'usr_admin', roles: ['ADMIN'], agent: null };
const PUBLISHER_CALLER: Caller = { name: 'PUBLISHER', sub: 'usr_pub', roles: ['PUBLISHER'], agent: null };
const AGENT_CALLER: Caller = { name: 'AGENT', sub: 'usr_agent', roles: ['AGENT_PUBLISHER'], agent: { id: 'agt_1' } };
const ADVERTISER_CALLER: Caller = { name: 'ADVERTISER', sub: 'usr_adv', roles: ['ADVERTISER'], agent: null };
const CALLERS = [ADMIN, PUBLISHER_CALLER, AGENT_CALLER, ADVERTISER_CALLER];

/** Reads one at a time: the agent lookup the read gate makes is a shared mock. */
async function readOrderAs(caller: Caller): Promise<Record<string, any>> {
  fake.agentProfile.current = caller.agent;
  const sent: { body?: { data: Record<string, unknown> } } = {};
  await getOrderByIdHandler(
    { user: { sub: caller.sub, roles: caller.roles }, params: { id: 'ord_1' }, query: {} } as never,
    { json: (body: { data: Record<string, unknown> }) => (sent.body = body) } as never,
  );
  return json(sent.body!.data) as Record<string, any>;
}

describe.each([
  { layer: 'with the global omit', globalOmit: true },
  { layer: 'with the selects alone (global omit off)', globalOmit: false },
])('GET /orders/:id — $layer', ({ globalOmit }) => {
  beforeEach(() => {
    options.globalOmit = globalOmit;
  });

  it.each(CALLERS)('answers $name with no secret anywhere in the tree', async (caller) => {
    const data = await readOrderAs(caller);
    // ADX alone reads the plain completion code back, at the top, by design.
    expect(pathsEndingIn(data, SECRET_KEYS)).toEqual(caller.name === 'ADMIN' ? ['completionOtpPlain'] : []);
    if (caller.name === 'ADMIN') expect(data.completionOtpPlain).toBe('482913');
  });

  it.each(CALLERS)('answers $name with no email, birth date or other private fact of anybody', async (caller) => {
    const data = await readOrderAs(caller);
    expect(pathsEndingIn(data, PRIVATE_KEYS)).toEqual([]);
  });

  it.each(CALLERS)('never hands $name the spot’s QR token or the RC answer', async (caller) => {
    const data = await readOrderAs(caller);
    expect(pathsEndingIn(data, LISTING_PRIVATE_KEYS)).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('Vikram Vehicle-Owner');
  });

  it('LD-1: keeps the publisher’s own statement about the spot from the advertiser and the installing agent', async () => {
    for (const caller of [ADVERTISER_CALLER, AGENT_CALLER]) {
      const data = await readOrderAs(caller);
      expect(pathsEndingIn(data, PUBLISHER_RECORD_KEYS)).toEqual([]);
      expect(JSON.stringify(data)).not.toContain('+919833333333');
    }
    for (const caller of [PUBLISHER_CALLER, ADMIN]) {
      const data = await readOrderAs(caller);
      expect(data.listing.extraAnswers).toEqual([{ key: 'society_contact', label: 'Society secretary’s number', value: '+919833333333' }]);
    }
  });

  it('still names the people each screen draws', async () => {
    const publisher = await readOrderAs(PUBLISHER_CALLER);
    expect(publisher.advertiser).toEqual({
      id: 'usr_adv',
      name: 'Asha Rao',
      firstName: 'Asha',
      lastName: 'Rao',
      displayId: 'ADX-usr_adv',
      avatarUrl: 'https://cdn.example/usr_adv.jpg',
    });
    expect(publisher.agent.user.name).toBe('Imran Shaikh');
    expect(publisher.agent.city).toBe('Pune');
    expect(publisher.listing.publisher.name).toBe('Kumar Hoardings');
  });

  it('gives the installer’s number to the publisher, who calls them, and to no other party', async () => {
    expect((await readOrderAs(PUBLISHER_CALLER)).agent.user.mobile).toBe('+919800000003');
    expect((await readOrderAs(ADMIN)).agent.user.mobile).toBe('+919800000003');
    expect((await readOrderAs(AGENT_CALLER)).agent.user).not.toHaveProperty('mobile');
    expect((await readOrderAs(ADVERTISER_CALLER)).agent.user).not.toHaveProperty('mobile');
  });

  it('gives the publisher’s number and address to the agent, who visits, and not to the advertiser', async () => {
    const agent = await readOrderAs(AGENT_CALLER);
    expect(agent.listing.publisher).toMatchObject({ mobile: '+919822222222', address: '7 Market Road', city: 'Pune', state: 'MH' });
    const advertiser = await readOrderAs(ADVERTISER_CALLER);
    expect(advertiser.listing.publisher).toEqual({ id: 'pub_1', userId: 'usr_pub', displayId: 'PUB-1', name: 'Kumar Hoardings', city: 'Pune', state: 'MH' });
  });

  it('keeps the offered agents’ numbers for ADX alone', async () => {
    const admin = await readOrderAs(ADMIN);
    expect(admin.agentAssignments.map((offer: any) => offer.agent.user.mobile)).toEqual(['+919800000003', '+919800000004']);
    for (const caller of [PUBLISHER_CALLER, AGENT_CALLER, ADVERTISER_CALLER]) {
      const data = await readOrderAs(caller);
      expect(keyPaths(data).filter((path) => path.startsWith('agentAssignments') && path.endsWith('mobile'))).toEqual([]);
      // The agent app reads the offer's agent ids; those stay.
      expect(data.agentAssignments[1].agent).toMatchObject({ id: 'agt_2', userId: 'usr_agent2', user: { id: 'usr_agent2' } });
    }
  });

  it('never joins the spot’s managing agent’s login', async () => {
    const admin = await readOrderAs(ADMIN);
    expect(admin.listing.agent).toEqual({ id: 'agt_spot', displayId: 'AGT-agt_spot' });
  });

  /* ── Order fraud screening (2 Oct 2026): the risk fields are ADX's alone ── */

  it.each([PUBLISHER_CALLER, AGENT_CALLER, ADVERTISER_CALLER])('answers $name with no risk or hold field anywhere, and the neutral line instead', async (caller) => {
    const data = await readOrderAs(caller);
    expect(pathsEndingIn(data, RISK_KEYS)).toEqual([]);
    expect(data.reviewNotice).toBe(ORDER_REVIEW_NOTICE);
    expect(data.reviewNotice).toBe("Your order is being reviewed — we'll update you shortly.");
    // Never "fraud", in any party-facing copy.
    expect(JSON.stringify(data)).not.toMatch(/fraud/i);
  });

  it('answers ADX with the whole screening: score, band, signals, review, hold, case', async () => {
    const admin = await readOrderAs(ADMIN);
    expect(admin).toMatchObject({
      riskScore: '0.870',
      riskBand: 'HOLD',
      riskReviewStatus: 'FLAGGED',
      holdReason: 'Suspected fraud: shared bank account',
      heldById: 'usr_admin',
      fraudCaseId: 'frd_1',
      reviewNotice: ORDER_REVIEW_NOTICE,
    });
    expect(admin.heldAt).toBe('2026-10-02T09:05:00.000Z');
    expect(admin.riskSignals[0]).toMatchObject({ key: 'LINKED_PARTIES', side: 'ORDER' });
    expect(admin.heldBy).toEqual({ id: 'usr_admin', name: null });
  });
});

/* ── The other reads this change narrowed ─────────────────────────────── */

describe.each([{ globalOmit: true }, { globalOmit: false }])('the other order and party reads (global omit: $globalOmit)', ({ globalOmit }) => {
  beforeEach(() => {
    options.globalOmit = globalOmit;
  });

  /** No User credential and no private fact, whichever layer is on; the order's own code is the global omit's. */
  const expectClean = (tree: unknown, allow: readonly string[] = []) => {
    expect(pathsEndingIn(tree, ['passwordHash', 'totpSecretEnc', 'codeHash', 'tokenHash'])).toEqual([]);
    expect(pathsEndingIn(tree, PRIVATE_KEYS.filter((key) => !allow.includes(key)))).toEqual([]);
    if (globalOmit) expect(pathsEndingIn(tree, ['completionOtp', 'completionOtpPlain'])).toEqual([]);
  };

  it('POST /orders answers the new order alone — no listing, no publisher login', async () => {
    const created = json(await prismaOrdersRepository.create({ advertiserId: 'usr_adv', listingId: 'lst_1' } as never));
    expectClean(created);
    expect(created).not.toHaveProperty('listing');
  });

  it('GET /orders (the console board) names the agent without their User row', async () => {
    const page = json(await getAllOrders({ page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] };
    expectClean(page);
    expect(page.items[0].agent.user).toMatchObject({ name: 'Imran Shaikh' });
    expect(page.items[0]).not.toHaveProperty('advertiser');
  });

  it('GET /orders/my (agent) carries the neutral line on a held order and no risk field', async () => {
    const page = json(await getOrdersForAgent('agt_1', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] };
    expect(pathsEndingIn(page, RISK_KEYS)).toEqual([]);
    expect(page.items[0].reviewNotice).toBe(ORDER_REVIEW_NOTICE);
    expect(JSON.stringify(page)).not.toMatch(/fraud/i);
  });

  it('GET /orders (the console board) carries the hold and the verdict beside the status, not the signals', async () => {
    const page = json(await getAllOrders({ page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] };
    expect(page.items[0]).toMatchObject({ heldAt: '2026-10-02T09:05:00.000Z', holdReason: 'Suspected fraud: shared bank account', riskBand: 'HOLD', riskReviewStatus: 'FLAGGED' });
    if (globalOmit) expect(page.items[0]).not.toHaveProperty('riskSignals');
  });

  it('POST /orders answers the new order with no risk field', async () => {
    const created = json(await prismaOrdersRepository.create({ advertiserId: 'usr_adv', listingId: 'lst_1' } as never));
    if (globalOmit) expect(pathsEndingIn(created, RISK_KEYS)).toEqual([]);
  });

  it('GET /orders/my (advertiser, publisher, agent) never carries the spot’s QR token or the RC answer', async () => {
    for (const page of [
      json(await getOrdersForAdvertiser('usr_adv', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] },
      json(await getOrdersForPublisher('usr_pub', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] },
      json(await getOrdersForAgent('agt_1', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] },
    ]) {
      expect(page.items[0].listing.title).toBe('Station Road hoarding');
      expect(pathsEndingIn(page, LISTING_PRIVATE_KEYS)).toEqual([]);
    }
  });

  it('LD-1: GET /orders/my (advertiser, agent) carries the spot without the publisher’s own statement to ADX', async () => {
    for (const page of [
      json(await getOrdersForAdvertiser('usr_adv', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] },
      json(await getOrdersForAgent('agt_1', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] },
    ]) {
      expect(page.items[0].listing.title).toBe('Station Road hoarding');
      expect(pathsEndingIn(page, PUBLISHER_RECORD_KEYS)).toEqual([]);
    }
  });

  it('GET /orders/my (agent) carries the publisher’s contact, not their business file', async () => {
    const page = json(await getOrdersForAgent('agt_1', { page: 1, pageSize: 20, sort: 'NEWEST' } as never)) as { items: any[] };
    expectClean(page);
    expect(page.items[0].listing.publisher).toEqual({
      id: 'pub_1',
      userId: 'usr_pub',
      displayId: 'PUB-1',
      name: 'Kumar Hoardings',
      mobile: '+919822222222',
      address: '7 Market Road',
      city: 'Pune',
      state: 'MH',
    });
  });

  it('the order milestones (console) name the assigned agent without their User row', async () => {
    const list = json(await prismaOrderMilestonesRepository.findForOrder('ord_1')) as any[];
    const patched = json(await prismaOrderMilestonesRepository.updateMilestone('ms_1', {} as never)) as any;
    expectClean(list);
    expectClean(patched);
    expect(list[0].assignedAgent.user.name).toBe('Imran Shaikh');
    expect(patched.assignedAgent.user.name).toBe('Imran Shaikh');
  });

  it('the agent’s own milestones carry the visit’s publisher contact, not the business file', async () => {
    const mine = json(await prismaOrderMilestonesRepository.findForAgent('agt_1'));
    const one = json(await prismaOrderMilestonesRepository.findDetail('ms_1')) as any;
    expectClean(mine);
    expectClean(one);
    expect(one.orderRecord.listing.publisher).toMatchObject({ name: 'Kumar Hoardings', mobile: '+919822222222' });
    expect(one.orderRecord.listing.publisher).not.toHaveProperty('user');
  });

  it('the onboarding desk (ADMIN) names the person without their credentials or birth date', async () => {
    const list = json(await prismaOnboardingRepository.listSubmissions({} as never)) as any[];
    // The desk is ADX's and provisions accounts: the person's email stays.
    expectClean(list, ['email']);
    expect(list[0].user).toMatchObject({ name: 'Asha Rao', mobile: '+919800000001', roles: [{ role: 'ADVERTISER' }] });
  });
});

/* ── The Campaigns lot (2 Oct 2026): the console's campaign reads ──────── */

describe.each([{ globalOmit: true }, { globalOmit: false }])('the campaign reads (global omit: $globalOmit)', ({ globalOmit }) => {
  beforeEach(() => {
    options.globalOmit = globalOmit;
  });

  const ADMIN_ACTOR = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };
  const ADVERTISER_ACTOR = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
  /** No credential, no private fact of a person or a party — the advertiser's number, email, GSTIN and billing address included. The KYC state is ADX's to read: the queue's "Request KYC" acts on it. */
  const expectClean = (tree: unknown) => {
    expect(pathsEndingIn(tree, SECRET_KEYS)).toEqual([]);
    expect(pathsEndingIn(tree, [...PRIVATE_KEYS, 'mobile', 'billingAddress', 'contactEmail', 'contactPhone', 'isActive', 'closedAt', 'suspensionScopes'])).toEqual([]);
    expect(pathsEndingIn(tree, RISK_KEYS)).toEqual([]);
  };
  const PLACED_BY = { userId: 'usr_adv', name: 'Asha Rao', displayId: 'ADX-usr_adv', business: { id: 'adv_1', name: 'Rao Foods', displayId: 'ADV-1909-2601' } };

  it('GET /campaigns (ADX) names the advertiser as placedBy and nothing private', async () => {
    const page = json(await listCampaignsPage(ADMIN_ACTOR, listCampaignsQuerySchema.parse({}))) as { items: any[] };
    expectClean(page);
    expect(page.items[0].advertiser).toEqual(PLACED_BY);
    expect(page.items[0].landingPage).toEqual({ id: 'lp_1', slug: 'rao-diwali', status: 'PUBLISHED', url: '/p/rao-diwali', publishedAt: '2026-09-28T10:00:00.000Z' });
    expect(page.items[0]).toMatchObject({ waitingOn: ['KYC', 'ARTWORK'], spotsTotal: 1, performance: { scans: 4, views: 2, ctaClicks: 0, enquiries: 0 }, paidAmount: '59000.00' });
  });

  it('GET /campaigns (the advertiser) stays the apps’ row — no console column, nothing private', async () => {
    const page = json(await listCampaignsPage(ADVERTISER_ACTOR, listCampaignsQuerySchema.parse({}))) as { items: any[] };
    expectClean(page);
    expect(page.items[0].advertiser).toEqual({ id: 'adv_1', displayId: 'ADV-1909-2601', name: 'Rao Foods' });
    expect(page.items[0]).not.toHaveProperty('waitingOn');
    expect(page.items[0]).not.toHaveProperty('performance');
  });

  it('GET /campaigns/launch-queue (ADX) carries the facts to act on and nothing private', async () => {
    const page = json(await launchQueue(launchQueueQuerySchema.parse({}), new Date('2026-10-02T10:00:00Z'))) as { items: any[] };
    expectClean(page);
    expect(page.items[0]).toMatchObject({ advertiser: PLACED_BY, waitingOn: ['KYC', 'ARTWORK'], waitingFacts: { KYC: { advertiserId: 'adv_1', accountState: 'ACTIVE' } } });
  });

  it('GET /campaigns/:id (ADX) adds placedBy and the banner, and nothing private', async () => {
    const extras = json(await consoleDetailExtras('cmp_1'));
    expect(pathsEndingIn(extras, SECRET_KEYS)).toEqual([]);
    expect(pathsEndingIn(extras, [...PRIVATE_KEYS, 'mobile', 'billingAddress', 'contactEmail', 'contactPhone', 'isActive', 'closedAt', 'suspensionScopes'])).toEqual([]);
    expect(extras).toMatchObject({ placedBy: PLACED_BY, waitingOn: ['KYC', 'ARTWORK'] });
  });

  it('GET /campaigns/landing-pages (ADX) names the advertiser without their private facts', async () => {
    const page = json(await listLandingPagesForConsole(landingPageListQuerySchema.parse({}))) as { items: any[] };
    expectClean(page);
    expect(page.items[0]).toMatchObject({ url: '/p/rao-diwali', heroTitle: 'Diwali at Rao', advertiser: PLACED_BY, views: 2 });
    expect(page.items[0].campaign.advertiser).toEqual({ id: 'adv_1', name: 'Rao Foods', companyName: 'Rao Foods Pvt Ltd' });
  });

  it('GET /campaigns/:id/performance (the owner) is numbers and days only', async () => {
    const data = json(await campaignPerformance(CAMPAIGN as never, new Date('2026-10-02T10:00:00Z'))) as Record<string, unknown>;
    expect(keyPaths(data).filter((path) => !/^(campaignId|reference|status|startDate|endDate|lifetime(\.(scans|views|ctaClicks|enquiries))?|series.*)$/.test(path))).toEqual([]);
    expect(data['lifetime']).toEqual({ scans: 4, views: 2, ctaClicks: 0, enquiries: 0 });
  });
});

describe('the order risk columns', () => {
  it('are the same list in the client’s omit and in the orders redaction', () => {
    expect([...ORDER_RISK_FIELDS].sort()).toEqual([...ORDER_RISK_KEYS].sort());
  });
});

/* ── The listing page (3 Oct 2026) ────────────────────────────────────── */

/**
 * The desk's listing read grew to the whole record — every column, every
 * row hanging off the listing. It stays ADX's: a publisher's or agent's
 * `PATCH /listings/:id` still answers the narrow view, and even the desk's
 * record joins every person by name alone. Whole fixture rows again, so a
 * careless include would show.
 */
const REVIEWER = person('usr_reviewer', 'Rhea Reviewer', '+919800000009');

const LISTING_RECORD = row('listing', {
  id: 'lst_1',
  displayId: 'LST-2509-2601',
  title: 'Station Road hoarding',
  subType: null,
  city: 'Pune',
  publisherId: 'pub_1',
  agentId: 'agt_spot',
  qrToken: 'qr-token-that-opens-a-check-in',
  suspendedById: null,
  publisher: PUBLISHER,
  agent: SPOT_AGENT,
  attempt: row('listingAttempt', { id: 'att_1', origin: 'AGENT', status: 'SUBMITTED', createdBy: REVIEWER }),
  photos: [row('listingPhoto', { id: 'ph_1', url: 'https://cdn.example/front.jpg', type: 'FRONT', createdAt: new Date('2026-09-01') })],
  mediaType: row('mediaType', { id: 'mt_1', name: 'Vinyl', formatGroup: 'Print', description: 'internal' }),
  venueType: null,
  sizeClass: null,
  material: null,
  plan: null,
  cityRef: null,
  documents: [row('listingDocument', { id: 'doc_1', kind: 'OWNER_NOC', url: '/api/v1/files/f_1', status: 'VERIFIED', reviewedBy: REVIEWER })],
  verifications: [
    row('listingVerification', { id: 'lv_1', type: 'AGENT_INITIAL', status: 'ACCEPTED', submittedBy: INSTALLER_LOGIN, reviewedBy: REVIEWER, photos: [] }),
  ],
  contentRules: [],
  pricingFactors: [],
  priceApprovals: [],
  priceLocks: [row('priceLock', { id: 'pl_1', ratePerDay: '900.00', advertiser: ADVERTISER_PARTY })],
  blockedDates: [],
  claims: [row('listingClaim', { id: 'clm_1', status: 'PENDING', evidenceNote: 'my wall', claimant: PUBLISHER, decidedBy: REVIEWER })],
  complianceCases: [row('complianceCase', { id: 'cc_1', reason: 'VERIFICATION_LAPSED', status: 'OPEN', assignedTo: REVIEWER })],
  earningsHolds: [],
  disputes: [],
  _count: { orders: 1 },
});

describe('the listing reads (3 Oct 2026)', () => {
  beforeEach(() => {
    options.globalOmit = true;
    Object.assign(fake.prisma, {
      listing: { findUnique: shaped(LISTING_RECORD) },
      uploadedFile: { findMany: () => [] },
      customFieldValue: { findMany: () => [] },
      listingBoost: { findMany: () => [], count: () => 0 },
    });
  });

  const OTHER_PARTY_KEYS = [...PRIVATE_KEYS, 'mobile', 'billingAddress', 'address', 'passwordHash', 'totpSecretEnc'];

  it('PATCH /listings/:id answers a publisher or agent the narrow view it always has — none of the desk’s rows', async () => {
    const view = json(await getListingForAdmin('lst_1')) as Record<string, unknown>;
    expect(pathsEndingIn(view, SECRET_KEYS)).toEqual([]);
    expect(pathsEndingIn(view, OTHER_PARTY_KEYS)).toEqual([]);
    // The fixture's empty lists read as plain columns to the stand-in, so only the filled relations are asked after.
    for (const key of ['documents', 'verifications', 'claims', 'complianceCases', 'priceLocks', 'attempt', 'customFields', 'counts']) {
      expect(view).not.toHaveProperty(key);
    }
    expect(view['publisher']).toEqual({ id: 'pub_1', name: 'Kumar Hoardings', displayId: 'PUB-1', city: 'Pune' });
  });

  it('GET /listings/:id (ADX) carries the whole record, every person by name alone, and never the site QR token', async () => {
    const record = json(await getListingRecordForAdmin('lst_1')) as Record<string, any>;
    expect(pathsEndingIn(record, SECRET_KEYS)).toEqual([]);
    expect(pathsEndingIn(record, OTHER_PARTY_KEYS)).toEqual([]);
    expect(record).not.toHaveProperty('qrToken');
    expect(JSON.stringify(record)).not.toContain('qr-token-that-opens-a-check-in');
    expect(record['hasSiteQr']).toBe(true);
    expect(record['documents'][0].reviewedBy).toEqual({ id: 'usr_reviewer', name: 'Rhea Reviewer' });
    expect(record['verifications'][0].submittedBy).toEqual({ id: 'usr_agent', name: 'Imran Shaikh' });
    expect(record['claims'][0].claimant).toEqual({ id: 'pub_1', name: 'Kumar Hoardings', displayId: 'PUB-1' });
    expect(record['priceLocks'][0].advertiser).toEqual({ id: 'adv_1', name: 'Rao Foods', companyName: 'Rao Foods Pvt Ltd' });
    expect(record['agent']).toEqual({ id: 'agt_spot', displayId: 'AGT-agt_spot', user: { name: 'Lata Iyer' } });
  });
});

/* ── The spot-page view count (LD-1, 3 Oct 2026) ──────────────────────── */

/**
 * `POST /listings/:displayIdOrId/view` is public. It answers `{ counted }`
 * and nothing else — no listing, no owner, no echo of the caller — and the
 * caller's address, browser and id reach the database only as a keyed hash.
 */
describe('the spot-page view count (LD-1)', () => {
  const queryRaw = vi.fn(async () => [{ counted: true, unique_visitor: true }]);
  const VIEWED = row('listing', { ...LISTING_RECORD, status: 'ACTIVE' });

  beforeEach(() => {
    options.globalOmit = true;
    queryRaw.mockClear();
    Object.assign(fake.prisma, { listing: { findFirst: shaped(VIEWED) }, $queryRaw: queryRaw });
  });

  async function view(user: { sub: string; roles: string[] } | null) {
    const sent: { body?: unknown } = {};
    await listingViewHandler(
      {
        body: { source: 'WEB' },
        params: { displayIdOrId: 'LST-2509-2601' },
        user: user ?? undefined,
        ip: '203.0.113.7',
        get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36' : undefined),
      } as never,
      { setHeader: () => undefined, json: (body: unknown) => (sent.body = body) } as never,
    );
    return json(sent.body) as { success: boolean; data: Record<string, unknown> };
  }

  it.each([
    ['a visitor with no session', null],
    ['a signed-in advertiser', { sub: 'usr_adv', roles: ['ADVERTISER'] }],
  ])('answers %s with whether it counted, and nothing else', async (_label, user) => {
    const body = await view(user);
    expect(body).toEqual({ success: true, data: { counted: true } });
    const text = JSON.stringify(body);
    for (const leak of ['203.0.113.7', 'Mozilla', 'usr_adv', 'lst_1', 'Kumar Hoardings', '+91', 'qr-token']) expect(text).not.toContain(leak);
  });

  it('stores the visitor as a keyed hash — never the address, the browser or the user id', async () => {
    await view({ sub: 'usr_adv', roles: ['ADVERTISER'] });
    await view(null);
    for (const call of queryRaw.mock.calls as unknown as unknown[][]) {
      const values = JSON.stringify(call.slice(1));
      expect(values).not.toContain('203.0.113.7');
      expect(values).not.toContain('Mozilla');
      expect(values).not.toContain('usr_adv');
    }
  });

  it('reads only the logins it needs off the spot — no party row, no secret', async () => {
    const findFirst = vi.fn(shaped(VIEWED));
    Object.assign(fake.prisma, { listing: { findFirst } });
    await view(null);
    const args = findFirst.mock.calls[0]![0] as { select: Record<string, unknown> };
    expect(args.select).toEqual({
      id: true,
      publisher: { select: { userId: true, agent: { select: { userId: true } } } },
      agent: { select: { userId: true } },
    });
  });
});
