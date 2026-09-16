import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Quote requests — Lot H (Q147), the owner's 6 Sep mechanics.
 *
 * The print charge is the partner's quoted price, never predefined. Under
 * test: who an AUTO invite reaches (the city, or 50 km of the site, active
 * and accepting requests, rate-card partners first); one quote per partner,
 * edited until the deadline and withdrawn by DELETE; the award — the lowest
 * by default, ties on turnaround then the rate card, an override only with
 * a note — opening the job on the quote and telling both sides; a decline
 * reopening the request; and the nightly expiry that re-invites once.
 */

type Row = Record<string, any>;

const NOW = new Date('2026-09-14T09:00:00Z');
const HOUR = 60 * 60 * 1000;

const { fake, repository, orders, notifications, cache } = vi.hoisted(() => {
  const fake = { partners: new Map<string, Row>(), jobs: new Map<string, Row>(), requests: new Map<string, Row>(), quotes: new Map<string, Row>() };
  const withPartner = (job: Row) => ({ ...job, printPartner: fake.partners.get(job.printPartnerId) ?? null });
  const quoteWithPartner = (quote: Row) => {
    const partner = fake.partners.get(quote.printPartnerId) ?? {};
    return {
      ...quote,
      printPartner: {
        id: partner.id,
        displayId: partner.displayId ?? null,
        name: partner.name,
        city: partner.city ?? null,
        rateCardUpdatedAt: partner.rateCardUpdatedAt ?? null,
        rateCardFileId: partner.rateCardFileId ?? null,
        rateCardRows: partner.rateCardRows ?? null,
        turnaroundDays: partner.turnaroundDays ?? null,
        isActive: partner.isActive,
      },
    };
  };
  const requestWithQuotes = (request: Row) => ({
    ...request,
    quotes: [...fake.quotes.values()].filter((quote) => quote.requestId === request.id).map(quoteWithPartner),
  });
  const repository = {
    findPartner: vi.fn(async (id: string) => fake.partners.get(id) ?? null),
    findPartnersInReach: vi.fn(async (filter: Row) => {
      const all = [...fake.partners.values()];
      if (filter.partnerIds) return all.filter((partner) => filter.partnerIds.includes(partner.id));
      return all.filter((partner) => partner.isActive && partner.acceptsQuoteRequests);
    }),
    findOrderForPrint: vi.fn(async () => ({
      id: 'ord_1',
      status: 'PENDING_PRINT',
      listing: { id: 'lst_1', title: 'Mall wall', address: '1 MG Road', city: 'Bengaluru', latitude: 12.97, longitude: 77.59, size: '10x20' },
      agent: null,
      creative: null,
    })),
    findJobByOrder: vi.fn(async (orderId: string) => {
      const job = [...fake.jobs.values()].find((row) => row.orderId === orderId);
      return job ? withPartner(job) : null;
    }),
    findJob: vi.fn(async (id: string) => (fake.jobs.has(id) ? withPartner(fake.jobs.get(id)!) : null)),
    createJob: vi.fn(async (data: Row) => {
      const row = { id: `job_${fake.jobs.size + 1}`, status: 'REQUESTED', quotedCost: null, actualCost: null, specs: null, requestedAt: NOW, readyAt: null, collectedAt: null, costApprovedAt: null, ...data };
      fake.jobs.set(row.id, row);
      return withPartner(row);
    }),
    updateJob: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.jobs.get(id), ...patch };
      fake.jobs.set(id, next);
      return withPartner(next);
    }),
    createQuoteRequest: vi.fn(async (data: Row) => {
      const row = { id: `req_${fake.requests.size + 1}`, status: 'OPEN', awardedQuoteId: null, awardNote: null, createdAt: NOW, updatedAt: NOW, ...data };
      fake.requests.set(row.id, row);
      return requestWithQuotes(row);
    }),
    findQuoteRequest: vi.fn(async (id: string) => (fake.requests.has(id) ? requestWithQuotes(fake.requests.get(id)!) : null)),
    findLatestQuoteRequestForOrder: vi.fn(async (orderId: string) => {
      const rows = [...fake.requests.values()].filter((row) => row.orderId === orderId);
      const latest = rows[rows.length - 1];
      return latest ? requestWithQuotes(latest) : null;
    }),
    updateQuoteRequest: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.requests.get(id), ...patch };
      fake.requests.set(id, next);
      return requestWithQuotes(next);
    }),
    listQuoteRequestsForPartner: vi.fn(),
    findOpenRequestsPastDeadline: vi.fn(async (now: Date) =>
      [...fake.requests.values()].filter((row) => row.status === 'OPEN' && row.deadlineAt.getTime() < now.getTime()).map(requestWithQuotes),
    ),
    createQuote: vi.fn(async (data: Row) => {
      const row = { id: `quo_${fake.quotes.size + 1}`, status: 'SUBMITTED', submittedAt: NOW, updatedAt: NOW, ...data };
      fake.quotes.set(row.id, row);
      return quoteWithPartner(row);
    }),
    findQuote: vi.fn(async (id: string) => (fake.quotes.has(id) ? quoteWithPartner(fake.quotes.get(id)!) : null)),
    updateQuote: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.quotes.get(id), ...patch };
      fake.quotes.set(id, next);
      return quoteWithPartner(next);
    }),
    updateQuotesOnRequest: vi.fn(async (requestId: string, except: string[], fromStatus: string, patch: Row) => {
      let n = 0;
      for (const [id, quote] of fake.quotes) {
        if (quote.requestId === requestId && !except.includes(id) && quote.status === fromStatus) {
          fake.quotes.set(id, { ...quote, ...patch });
          n += 1;
        }
      }
      return n;
    }),
    listQuotesForPartner: vi.fn(async () => []),
    listQuoteRequests: vi.fn(async (filter: Row) => {
      const all = [...fake.requests.values()].filter((row) => !filter.status || filter.status.includes(row.status)).map(requestWithQuotes);
      return { items: all, total: all.length, counts: { OPEN: 0, AWARDED: 0, CANCELLED: 0, EXPIRED: 0 } };
    }),
    findOrdersForPrint: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        status: 'PENDING_PRINT',
        campaignName: 'Diwali',
        designUrl: null,
        startDate: null,
        endDate: null,
        listing: { id: 'lst_1', title: 'Mall wall', address: '1 MG Road', city: 'Bengaluru', latitude: 12.97, longitude: 77.59, size: '10x20' },
        agent: null,
        creative: null,
      })),
    ),
  };
  return {
    fake,
    repository,
    cache: { redis: { set: vi.fn(async (): Promise<string | null> => 'OK'), del: vi.fn(async () => 1) } },
    orders: {
      getOrderSummary: vi.fn(),
      registerPrintJobPort: vi.fn(),
      notifyAdmins: vi.fn(async () => []),
      shortId: (id: string) => id.slice(-6).toUpperCase(),
    },
    notifications: { notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) },
  };
});

vi.mock('../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: repository }));
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../orders', () => orders);
vi.mock('../../notifications', () => notifications);
vi.mock('../../payouts', () => ({ withholdingFor: vi.fn(), listWithdrawals: vi.fn(), listMethods: vi.fn(), addMethod: vi.fn(), requestWithdrawal: vi.fn(), withdrawalAllowance: vi.fn() }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn(), findWalletFor: vi.fn(), listEntries: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m, revokeSessions: vi.fn() }));
vi.mock('../../uploads', () => ({ findUploadedFile: vi.fn() }));
// Lot X-L: the city key beside the typed city — Bengaluru (and its old spelling) and Mysuru are catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) =>
    name && /^(bengaluru|bangalore)$/i.test(name.trim())
      ? { cityId: 'city_bengaluru', slug: 'bengaluru' }
      : name && /^(mysuru|mysore)$/i.test(name.trim())
        ? { cityId: 'city_mysuru', slug: 'mysuru' }
        : null,
  withCityKey: async (data: { city?: string | null }) => data,
  assertCityAllows: vi.fn(),
}));

import {
  AUTO_INVITE_RADIUS_KM,
  awardLockKey,
  awardQuoteRequest,
  cancelQuoteRequest,
  createQuoteRequest,
  getQuoteRequestForPartner,
  listQuoteRequests,
  distanceKm,
  envelopeOf,
  expireQuoteRequests,
  partnersInReach,
  rankQuotes,
  reopenRequestAfterDecline,
  submitQuote,
  withdrawQuote,
} from '../print-quotes.service';

const partner = (over: Row = {}): Row => ({
  id: 'prt_1',
  displayId: 'PRT-1209-2601',
  userId: 'usr_prt_1',
  name: 'Rapid Prints',
  contactName: 'Meena',
  mobile: '+919876543210',
  address: '4 Industrial Estate',
  city: 'Bengaluru',
  cityId: 'city_bengaluru',
  latitude: 12.97,
  longitude: 77.59,
  isActive: true,
  acceptsQuoteRequests: true,
  rateCardFileId: null,
  rateCardRows: null,
  rateCardUpdatedAt: null,
  turnaroundDays: 3,
  ...over,
});

const events = () => (notifications.notify.mock.calls as unknown as [string, string][]).map((call) => [call[0], call[1]]);

beforeEach(() => {
  vi.clearAllMocks();
  cache.redis.set.mockResolvedValue('OK');
  fake.partners.clear();
  fake.jobs.clear();
  fake.requests.clear();
  fake.quotes.clear();
  fake.partners.set('prt_1', partner());
  fake.partners.set('prt_2', partner({ id: 'prt_2', userId: 'usr_prt_2', name: 'Bright Banners', rateCardUpdatedAt: NOW, rateCardRows: [{ material: 'Flex' }] }));
  fake.partners.set('prt_3', partner({ id: 'prt_3', userId: 'usr_prt_3', name: 'Far Prints', city: 'Mysuru', cityId: 'city_mysuru', latitude: 12.3, longitude: 76.65 }));
  orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'PENDING_PRINT', agentId: null, listingId: 'lst_1' });
});

describe('who an AUTO invite reaches', () => {
  const site = { city: 'Bengaluru', latitude: 12.97, longitude: 77.59 };

  it('takes the city or 50 km of the site, active and accepting requests, rate-card partners first', () => {
    const near = partner({ id: 'prt_near', name: 'Near Enough', city: 'Whitefield', cityId: null, latitude: 12.99, longitude: 77.75 });
    const off = partner({ id: 'prt_off', name: 'Off Roster', isActive: false });
    const quiet = partner({ id: 'prt_quiet', name: 'No Requests', acceptsQuoteRequests: false });
    const reach = partnersInReach([partner(), fake.partners.get('prt_2')!, fake.partners.get('prt_3')!, near, off, quiet] as never, site);
    expect(reach.map((p) => p.id)).toEqual(['prt_2', 'prt_near', 'prt_1']);
    expect(distanceKm(site, { latitude: 12.3, longitude: 76.65 })).toBeGreaterThan(AUTO_INVITE_RADIUS_KM);
  });

  it('without coordinates on the site, the city alone decides', () => {
    const reach = partnersInReach([partner(), fake.partners.get('prt_3')!] as never, { city: 'mysuru', latitude: null, longitude: null });
    expect(reach.map((p) => p.id)).toEqual(['prt_3']);
  });

  /* Lot X-L: the key is the identity. */
  it("two spellings are one pool: a site keyed to Bengaluru reaches the partner typed 'Bangalore' by key, and a null-keyed one by spelling", () => {
    const oldSpelling = partner({ id: 'prt_old', name: 'Old Spelling Press', city: 'Bangalore', cityId: 'city_bengaluru', latitude: null, longitude: null });
    const unkeyed = partner({ id: 'prt_unkeyed', name: 'Unkeyed Press', city: 'bengaluru', cityId: null, latitude: null, longitude: null });
    const elsewhere = partner({ id: 'prt_else', name: 'Elsewhere Press', city: 'Bengaluru', cityId: 'city_mysuru', latitude: null, longitude: null });
    const reach = partnersInReach([oldSpelling, unkeyed, elsewhere] as never, { city: 'Bengaluru', cityId: 'city_bengaluru', latitude: null, longitude: null });
    expect(reach.map((p) => p.id)).toEqual(['prt_old', 'prt_unkeyed']);
    // A site in a town nobody catalogued still matches by spelling alone.
    const typed = partner({ id: 'prt_typed', name: 'Typed Press', city: 'Rameswaram', cityId: null, latitude: null, longitude: null });
    expect(partnersInReach([typed, oldSpelling] as never, { city: 'rameswaram', cityId: null, latitude: null, longitude: null }).map((p) => p.id)).toEqual(['prt_typed']);
  });
});

describe('raising a request', () => {
  it('needs a printable order with no live job and no open request', async () => {
    orders.getOrderSummary.mockResolvedValueOnce(null);
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
    orders.getOrderSummary.mockResolvedValueOnce({ id: 'ord_1', status: 'DRAFT' });
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });

    fake.jobs.set('job_x', { id: 'job_x', orderId: 'ord_1', printPartnerId: 'prt_1', status: 'PRINTING' });
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, details: { printJobId: 'job_x' } });
    fake.jobs.clear();

    await createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, details: { quoteRequestId: 'req_1' } });
  });

  it('AUTO invites the partners in reach, rate-card first, with the 48-hour default deadline, and tells each one', async () => {
    const { request, invited } = await createQuoteRequest('ord_1', { specs: { size: '10x20', material: 'Flex' }, invite: 'AUTO' }, 'usr_admin', NOW);
    expect(invited.map((p) => p.id)).toEqual(['prt_2', 'prt_1']);
    // Lot X-L: the reach is asked by the key the site's city resolved to; the typed city stays for display.
    expect(repository.findPartnersInReach).toHaveBeenCalledWith({ city: 'Bengaluru', cityId: 'city_bengaluru' });
    expect(request.deadlineAt).toEqual(new Date(NOW.getTime() + 48 * HOUR));
    expect(request.city).toBe('Bengaluru');
    expect(envelopeOf(request)).toEqual({ specs: { size: '10x20', material: 'Flex' }, invitedPartnerIds: ['prt_2', 'prt_1'], inviteMode: 'AUTO', reinvitedAt: null, cancelReason: null, cancelledAt: null });
    expect(events()).toEqual([
      ['PRINT_QUOTE_REQUESTED', 'usr_prt_2'],
      ['PRINT_QUOTE_REQUESTED', 'usr_prt_1'],
    ]);
  });

  it('refuses an AUTO invite that reaches nobody, and a deadline in the past', async () => {
    for (const row of fake.partners.values()) row.acceptsQuoteRequests = false;
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'NO_PARTNERS_IN_REACH' });
    await expect(
      createQuoteRequest('ord_1', { specs: {}, invite: ['prt_1'], deadlineAt: new Date(NOW.getTime() - HOUR).toISOString() }, 'usr_admin', NOW),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a hand-picked list is invited as named — whatever the city or the switch — but never a partner off the roster', async () => {
    fake.partners.get('prt_3')!.acceptsQuoteRequests = false;
    const { invited } = await createQuoteRequest('ord_1', { specs: {}, invite: ['prt_3', 'prt_1'] }, 'usr_admin', NOW);
    expect(invited.map((p) => p.id).sort()).toEqual(['prt_1', 'prt_3']);
    fake.requests.clear();
    fake.partners.get('prt_1')!.isActive = false;
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: ['prt_1'] }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(createQuoteRequest('ord_1', { specs: {}, invite: ['prt_missing'] }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('quoting', () => {
  let requestId: string;
  beforeEach(async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: { size: '10x20' }, invite: 'AUTO' }, 'usr_admin', NOW);
    requestId = request.id;
    notifications.notify.mockClear();
  });

  it('one quote per partner, edited until the deadline, withdrawn by DELETE and re-submittable', async () => {
    const p1 = fake.partners.get('prt_1')! as never;
    const first = await submitQuote(p1, requestId, { amount: '1500.00', turnaroundDays: 3 }, NOW);
    expect(first.status).toBe('SUBMITTED');
    const later = new Date(NOW.getTime() + HOUR);
    const edited = await submitQuote(p1, requestId, { amount: '1400.00', turnaroundDays: 2, note: 'Sharpened' }, later);
    expect(edited.id).toBe(first.id);
    expect(new Decimal(edited.amount).toFixed(2)).toBe('1400.00');
    expect(edited.submittedAt).toEqual(later);
    expect(fake.quotes.size).toBe(1);

    const gone = await withdrawQuote(p1, requestId, later);
    expect(gone.status).toBe('WITHDRAWN');
    await expect(withdrawQuote(p1, requestId, later)).rejects.toMatchObject({ statusCode: 404 });
    const back = await submitQuote(p1, requestId, { amount: '1450.00', turnaroundDays: 3 }, later);
    expect(back.id).toBe(first.id);
    expect(back.status).toBe('SUBMITTED');
  });

  it('refuses a partner who was not invited (as not found — sealed bids), after the deadline, and off the roster', async () => {
    const p3 = fake.partners.get('prt_3')! as never;
    await expect(submitQuote(p3, requestId, { amount: '1000.00', turnaroundDays: 1 }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    const p1 = fake.partners.get('prt_1')!;
    await expect(submitQuote(p1 as never, requestId, { amount: '1000.00', turnaroundDays: 1 }, new Date(NOW.getTime() + 49 * HOUR))).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_PASSED',
    });
    await expect(submitQuote({ ...p1, isActive: false } as never, requestId, { amount: '1000.00', turnaroundDays: 1 }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('ranks the lowest first, then the shorter turnaround, then the rate-card partner, then who quoted first', () => {
    const q = (over: Row) => ({ id: 'q', status: 'SUBMITTED', amount: new Decimal('1000'), turnaroundDays: 3, submittedAt: NOW, printPartner: { rateCardUpdatedAt: null, rateCardFileId: null, rateCardRows: null }, ...over });
    const ranked = rankQuotes([
      q({ id: 'late', submittedAt: new Date(NOW.getTime() + HOUR) }),
      q({ id: 'dearer', amount: new Decimal('1200') }),
      q({ id: 'withdrawn', amount: new Decimal('1'), status: 'WITHDRAWN' }),
      q({ id: 'faster', turnaroundDays: 2 }),
      // G13-B: "carded" is `hasRateCard` — a file or rows — the same rule the reach sorts by; a bare timestamp is not a card.
      q({ id: 'carded', printPartner: { rateCardUpdatedAt: NOW, rateCardFileId: 'file_rc', rateCardRows: null } }),
      q({ id: 'stamped', submittedAt: new Date(NOW.getTime() + 2 * HOUR), printPartner: { rateCardUpdatedAt: NOW, rateCardFileId: null, rateCardRows: [] } }),
      q({ id: 'early' }),
    ] as never);
    expect(ranked.map((row) => row.id)).toEqual(['faster', 'carded', 'early', 'late', 'stamped', 'dearer']);
  });
});

describe('the award', () => {
  let requestId: string;
  beforeEach(async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: { size: '10x20' }, invite: 'AUTO' }, 'usr_admin', NOW);
    requestId = request.id;
    await submitQuote(fake.partners.get('prt_1')! as never, requestId, { amount: '1500.00', turnaroundDays: 3 }, NOW);
    await submitQuote(fake.partners.get('prt_2')! as never, requestId, { amount: '1700.00', turnaroundDays: 1 }, NOW);
    notifications.notify.mockClear();
  });

  it('takes the lowest by default: the job opens on the quote, the others are rejected, both sides are told', async () => {
    const result = await awardQuoteRequest('ord_1', {}, NOW);
    expect(result.overridden).toBe(false);
    expect(result.quote.printPartnerId).toBe('prt_1');
    expect(result.job).toMatchObject({ printPartnerId: 'prt_1', status: 'REQUESTED', awardedQuoteId: result.quote.id, specs: { size: '10x20' } });
    expect(new Decimal(result.job.quotedCost as never).toFixed(2)).toBe('1500.00');
    expect(result.request).toMatchObject({ status: 'AWARDED', awardedQuoteId: result.quote.id });
    expect(fake.quotes.get('quo_1')?.status).toBe('ACCEPTED');
    expect(fake.quotes.get('quo_2')?.status).toBe('REJECTED');
    expect(events()).toEqual([
      ['PRINT_JOB_ASSIGNED', 'usr_prt_1'],
      ['PRINT_QUOTE_REJECTED', 'usr_prt_2'],
    ]);
    expect(notifications.notify).toHaveBeenCalledWith('PRINT_JOB_ASSIGNED', 'usr_prt_1', expect.objectContaining({ amount: '1500.00' }), expect.anything());
  });

  it('awards another quote only with a note, and records that it was an override', async () => {
    await expect(awardQuoteRequest('ord_1', { quoteId: 'quo_2' }, NOW)).rejects.toMatchObject({ statusCode: 400, code: 'NOTE_REQUIRED', details: { lowestQuoteId: 'quo_1' } });
    const result = await awardQuoteRequest('ord_1', { quoteId: 'quo_2', note: 'Needs it tomorrow; Bright Banners turns it in a day' }, NOW);
    expect(result.overridden).toBe(true);
    expect(result.lowest.id).toBe('quo_1');
    expect(result.job.printPartnerId).toBe('prt_2');
    expect(result.request.awardNote).toContain('tomorrow');
  });

  it('can still be awarded after the deadline, but not twice, and not with no quotes', async () => {
    const late = new Date(NOW.getTime() + 60 * HOUR);
    await awardQuoteRequest('ord_1', {}, late);
    await expect(awardQuoteRequest('ord_1', {}, late)).rejects.toMatchObject({ statusCode: 409 });

    fake.requests.clear();
    fake.quotes.clear();
    fake.jobs.clear();
    await createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    await expect(awardQuoteRequest('ord_1', {}, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'NO_QUOTES' });
  });

  it('G13-B: runs under a per-request lock — a second concurrent award answers 409, and the lock is released after', async () => {
    cache.redis.set.mockResolvedValueOnce(null);
    await expect(awardQuoteRequest('ord_1', {}, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', details: { quoteRequestId: requestId } });
    expect(fake.requests.get(requestId)?.status).toBe('OPEN');
    expect(fake.jobs.size).toBe(0);

    await awardQuoteRequest('ord_1', {}, NOW);
    expect(cache.redis.set).toHaveBeenLastCalledWith(awardLockKey(requestId), '1', 'PX', expect.any(Number), 'NX');
    expect(cache.redis.del).toHaveBeenCalledWith(awardLockKey(requestId));
  });

  it('G13-B: releases the lock when the award fails', async () => {
    await expect(awardQuoteRequest('ord_1', { quoteId: 'quo_2' }, NOW)).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    expect(cache.redis.del).toHaveBeenCalledWith(awardLockKey(requestId));
  });

  it('refuses a quote that is not standing', async () => {
    await withdrawQuote(fake.partners.get('prt_2')! as never, requestId, NOW);
    await expect(awardQuoteRequest('ord_1', { quoteId: 'quo_2', note: 'why' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(awardQuoteRequest('ord_1', { quoteId: 'quo_missing', note: 'why' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a decline reopens the request: the decliner withdrawn, the others back in, the deadline pushed out, the others told', async () => {
    const awarded = await awardQuoteRequest('ord_1', {}, NOW);
    notifications.notify.mockClear();
    const later = new Date(NOW.getTime() + 60 * HOUR);
    const reopened = await reopenRequestAfterDecline({ orderId: 'ord_1', awardedQuoteId: awarded.quote.id, printPartnerId: 'prt_1' }, later);
    expect(reopened).toMatchObject({ status: 'OPEN', awardedQuoteId: null, awardNote: null });
    expect(reopened!.deadlineAt).toEqual(new Date(later.getTime() + 48 * HOUR));
    expect(fake.quotes.get('quo_1')?.status).toBe('WITHDRAWN');
    expect(fake.quotes.get('quo_2')?.status).toBe('SUBMITTED');
    expect(events()).toEqual([['PRINT_QUOTE_REQUEST_REOPENED', 'usr_prt_2']]);
    // A hand-opened job has no request to reopen.
    await expect(reopenRequestAfterDecline({ orderId: 'ord_9', awardedQuoteId: null, printPartnerId: 'prt_1' }, later)).resolves.toBeNull();
  });
});

describe('the nightly expiry', () => {
  it('re-invites once past the deadline with no quote, expires the second time, and leaves a quoted request for ops', async () => {
    await createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_2', status: 'PENDING_PRINT' });
    const { request: quoted } = await createQuoteRequest('ord_2', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    await submitQuote(fake.partners.get('prt_1')! as never, quoted.id, { amount: '900.00', turnaroundDays: 2 }, NOW);
    notifications.notify.mockClear();

    const night1 = new Date(NOW.getTime() + 50 * HOUR);
    const first = await expireQuoteRequests(night1);
    expect(first).toEqual({ checked: 2, reinvited: ['req_1'], expired: [], awaitingAward: ['req_2'] });
    expect(fake.requests.get('req_1')).toMatchObject({ status: 'OPEN', deadlineAt: new Date(night1.getTime() + 48 * HOUR) });
    expect(envelopeOf(fake.requests.get('req_1') as never).reinvitedAt).toBe(night1.toISOString());
    expect(events()).toEqual([
      ['PRINT_QUOTE_REQUEST_REOPENED', 'usr_prt_2'],
      ['PRINT_QUOTE_REQUEST_REOPENED', 'usr_prt_1'],
    ]);
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Print quotes await award', expect.stringContaining('waiting for an award'), 'ord_2');

    const night2 = new Date(night1.getTime() + 50 * HOUR);
    const second = await expireQuoteRequests(night2);
    expect(second.expired).toEqual(['req_1']);
    expect(fake.requests.get('req_1')?.status).toBe('EXPIRED');
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Print quote request expired', expect.any(String), 'ord_1');
  });
});

/* ── G13-B: the desk's list, the cancel, the partner's one request ────────── */

describe('G13-B: the desk list across orders', () => {
  it('answers every request with its order, the invited count, the standing quotes and the lowest', async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: { size: '10x20' }, invite: 'AUTO' }, 'usr_admin', NOW);
    await submitQuote(fake.partners.get('prt_1')! as never, request.id, { amount: '1500.00', turnaroundDays: 3 }, NOW);
    await submitQuote(fake.partners.get('prt_2')! as never, request.id, { amount: '1400.00', turnaroundDays: 1 }, NOW);
    await withdrawQuote(fake.partners.get('prt_1')! as never, request.id, NOW);

    const page = await listQuoteRequests({ page: 1, pageSize: 20, status: ['OPEN'] });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ invitedCount: 2, standingQuotes: 1 });
    expect(page.items[0]!.lowest?.printPartnerId).toBe('prt_2');
    expect(page.items[0]!.order?.listing.city).toBe('Bengaluru');
    expect(repository.findOrdersForPrint).toHaveBeenCalledWith(['ord_1']);
    expect(repository.listQuoteRequests).toHaveBeenCalledWith(expect.objectContaining({ status: ['OPEN'], page: 1, pageSize: 20 }));
  });
});

describe('G13-B: cancelling a request', () => {
  it('closes an OPEN request with the reason on it, leaves the quotes as the record, and tells every invited partner', async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    await submitQuote(fake.partners.get('prt_1')! as never, request.id, { amount: '1500.00', turnaroundDays: 3 }, NOW);
    notifications.notify.mockClear();

    const cancelled = await cancelQuoteRequest('ord_1', 'Client pulled the campaign', NOW);
    expect(cancelled.status).toBe('CANCELLED');
    expect(envelopeOf(cancelled)).toMatchObject({ cancelReason: 'Client pulled the campaign', cancelledAt: NOW.toISOString(), invitedPartnerIds: ['prt_2', 'prt_1'] });
    expect(fake.quotes.get('quo_1')?.status).toBe('SUBMITTED');
    expect(events()).toEqual([
      ['PRINT_QUOTE_REQUEST_CANCELLED', 'usr_prt_2'],
      ['PRINT_QUOTE_REQUEST_CANCELLED', 'usr_prt_1'],
    ]);
    expect(notifications.notify).toHaveBeenCalledWith('PRINT_QUOTE_REQUEST_CANCELLED', 'usr_prt_1', expect.objectContaining({ reason: 'Client pulled the campaign' }), expect.anything());

    // Closed: no more quotes, no second cancel, no award.
    await expect(submitQuote(fake.partners.get('prt_2')! as never, request.id, { amount: '1.00', turnaroundDays: 1 }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(cancelQuoteRequest('ord_1', 'again', NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(awardQuoteRequest('ord_1', {}, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to cancel an awarded request — that is undone through the job\'s decline', async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: {}, invite: 'AUTO' }, 'usr_admin', NOW);
    await submitQuote(fake.partners.get('prt_1')! as never, request.id, { amount: '1500.00', turnaroundDays: 3 }, NOW);
    await awardQuoteRequest('ord_1', {}, NOW);
    await expect(cancelQuoteRequest('ord_1', 'too late', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('G13-B: the partner reads one request', () => {
  it('answers a request the partner was invited to, whatever its status, and 404 for any other', async () => {
    const { request } = await createQuoteRequest('ord_1', { specs: { size: '10x20' }, invite: ['prt_1'] }, 'usr_admin', NOW);
    expect((await getQuoteRequestForPartner(fake.partners.get('prt_1')! as never, request.id)).id).toBe(request.id);
    await cancelQuoteRequest('ord_1', 'gone', NOW);
    expect((await getQuoteRequestForPartner(fake.partners.get('prt_1')! as never, request.id)).status).toBe('CANCELLED');
    await expect(getQuoteRequestForPartner(fake.partners.get('prt_2')! as never, request.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getQuoteRequestForPartner(fake.partners.get('prt_1')! as never, 'req_nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
