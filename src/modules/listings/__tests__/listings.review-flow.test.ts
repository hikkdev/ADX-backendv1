import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The listing state machine, walked from the client.
 *
 * submit → (desk) send back → fix → submit again → (desk) publish, driven
 * through the real Express app so the route guards, the validation and the
 * error handler are all in the path. The repository is an in-memory row, so
 * the suite stays off Postgres like the rest of them; what it pins down is
 * that the transitions compose — a listing sent back can come back, a
 * listing rejected cannot, and the publisher's own phone can no longer skip
 * the desk.
 *
 * vi.hoisted is load-bearing: vi.mock factories are lifted above every import
 * below, so the doubles have to be created up there with them.
 */
const state = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string; status: string };
  const rows = new Map<string, Row>();
  const get = (id: string) => rows.get(id) ?? null;
  const set = (id: string, patch: Record<string, unknown>) => {
    const next = { ...rows.get(id)!, ...patch };
    rows.set(id, next);
    return next;
  };
  const joins = (row: Row) => ({
    ...row,
    publisher: { id: 'pub_1', name: 'Sharma Hoardings', displayId: 'PUB-1909-2601', city: 'Bengaluru', mobile: '+919876543210' },
    agent: null,
    photos: [],
    documents: [],
    mediaType: null,
    sizeClass: null,
    material: null,
    venueType: null,
    contentRules: [],
  });
  return {
    rows,
    repository: {
      findById: async (id: string) => get(id),
      findWithPublisher: async (id: string) => {
        const row = get(id);
        return row ? { ...row, publisher: { id: 'pub_1', userId: 'usr_publisher', agentId: null } } : null;
      },
      // QR-6: the submit gate reads the publisher's own row; this one has
      // accepted the publisher agreement, so the road is open.
      findPublisherByUserId: async (userId: string) =>
        userId === 'usr_publisher'
          ? { id: 'pub_1', name: 'Sharma Hoardings', mobile: '+919876543210', email: 'a@b.c', address: '1 Road', dateOfBirth: new Date('1990-01-01T00:00:00Z'), activatedAt: new Date('2026-09-01T00:00:00Z') }
          : null,
      countAll: async () => rows.size,
      displayIdExists: async () => false,
      submitForReview: async (id: string, displayId: string | null, at: Date) =>
        set(id, { status: 'PENDING_REVIEW', submittedAt: at, ...(displayId ? { displayId } : {}) }),
      sendBack: async (id: string, input: { status: string; reason: string }) =>
        set(id, {
          status: input.status,
          rejectionReason: input.reason,
          ...(input.status === 'DRAFT' ? { submittedAt: null } : {}),
        }),
      publish: async (id: string) =>
        set(id, { status: 'ACTIVE', publishedAt: new Date(), rejectionReason: null }),
      // A page now, not a bare array: the desk pays a rate-card gate check per
      // row, so the queue is bounded. This fake honours the bound so the flow
      // test exercises the same shape the real repository returns.
      findPendingReview: async (query: { page: number; pageSize: number }) => {
        const all = [...rows.values()].filter((row) => row.status === 'PENDING_REVIEW').map(joins);
        const start = (query.page - 1) * query.pageSize;
        return { items: all.slice(start, start + query.pageSize), total: all.length };
      },
      findReviewCase: async (id: string) => {
        const row = get(id);
        return row ? joins(row) : null;
      },
    },
    logActivity: vi.fn(),
  };
});

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: state.repository }));
// QR-8: the reference is minted off the LISTING series, not counted.
vi.mock('../../identifiers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../identifiers')>()), allocateIdentifier: async () => 'LST-0909-2602' }));
// QR-6: the submit gate asks `agreements` for the publisher's standing on the
// live agreement; this publisher has accepted it, so the road stays open —
// and the test never reaches the database for it.
vi.mock('../../agreements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agreements')>()),
  platformStanding: async () => ({ kind: 'PLATFORM', currentVersion: 1, requiresReacceptance: false, accepted: { templateVersion: 1 }, satisfied: true, outdated: false }),
}));
/* Partial: the app mounts `rateCardRouter` from the same module, so only the
   gate is replaced — no card covers anything in this suite. */
vi.mock('../../rate-cards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rate-cards')>()),
  checkGate: async () => ({ state: 'NOT_COVERED' }),
  assertPublishable: async () => undefined,
}));
/* Partial: the app mounts the audit module from the same barrel, so only the
   two writes are replaced — everything the reader needs stays real. */
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: state.logActivity,
  listActivity: vi.fn(),
}));

import { app } from '../../../app';
import { tokenFor } from '../../../shared/testing/tokens';

const PUBLISHER = `Bearer ${tokenFor(['PUBLISHER'], 'usr_publisher')}`;
const ADMIN = `Bearer ${tokenFor(['ADMIN'], 'usr_ops')}`;

const fresh = (id: string) => ({
  id,
  title: 'MG Road billboard',
  category: 'OUTDOOR',
  subType: null,
  status: 'DRAFT',
  city: 'Bengaluru',
  address: 'MG Road',
  placement: null,
  widthFt: null,
  heightFt: null,
  areaSqFt: null,
  ratePerDay: { toString: () => '1500.00' },
  basePrice: null,
  pricingUnit: 'PER_DAY',
  rateGrade: null,
  displayId: null,
  submittedAt: null,
  publishedAt: null,
  rejectionReason: null,
  description: null,
  latitude: null,
  longitude: null,
  targetAudience: null,
  uniqueSellingPoint: null,
  footfallNote: null,
  estimatedDailyFootfall: null,
  illumination: null,
  facing: null,
  elevation: null,
  visibility: null,
  trafficGrade: null,
  minBookingDays: null,
  availableNow: true,
  availableFrom: null,
  availableHoursFrom: null,
  availableHoursTo: null,
  peakPeriodNote: null,
  rateCardUrl: null,
  createdAt: new Date('2026-09-08T10:00:00Z'),
});

const submit = (id: string) =>
  request(app).post(`/api/v1/listings/${id}/submit`).set('Authorization', PUBLISHER);
const sendBack = (id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/listings/${id}/send-back`).set('Authorization', ADMIN).send(body);
const publish = (id: string, as = ADMIN) =>
  request(app).post(`/api/v1/listings/${id}/publish`).set('Authorization', as);
const queue = () => request(app).get('/api/v1/listings/review').set('Authorization', ADMIN);
const theCase = (id: string) =>
  request(app).get(`/api/v1/listings/${id}/review`).set('Authorization', ADMIN);

beforeEach(() => {
  state.rows.clear();
  state.rows.set('lst_1', fresh('lst_1'));
  state.logActivity.mockClear();
});

describe('submit → send back → resubmit → publish', () => {
  it('walks the whole way round', async () => {
    // The publisher says they are done.
    const submitted = await submit('lst_1');
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toMatchObject({ status: 'PENDING_REVIEW', displayId: 'LST-0909-2602' });

    // It is now on the desk, with nothing held against it yet.
    const waiting = await queue();
    expect(waiting.status).toBe(200);
    expect(waiting.body.data.items).toHaveLength(1);
    expect(waiting.body.data.total).toBe(1);
    expect(waiting.body.data.items[0]).toMatchObject({
      id: 'lst_1',
      publisher: { name: 'Sharma Hoardings' },
      gate: { state: 'NOT_COVERED' },
      priorReason: null,
      asking: { ratePerDay: '1500.00' },
    });

    // The desk sends it back. The reason travels with the row and the SLA
    // clock is reset.
    const returned = await sendBack('lst_1', { reason: 'Photos are blurry' });
    expect(returned.status).toBe(200);
    expect(returned.body.data).toMatchObject({
      status: 'DRAFT',
      rejectionReason: 'Photos are blurry',
      submittedAt: null,
    });
    expect(state.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'LISTING_SENT_BACK',
      expect.anything(),
      expect.objectContaining({ listingId: 'lst_1', outcome: 'CHANGES_REQUESTED' })
    );

    // Off the desk, and cannot be sent back twice.
    expect((await queue()).body.data.items).toHaveLength(0);
    expect((await sendBack('lst_1', { reason: 'Photos are blurry' })).status).toBe(409);

    // The publisher fixes it and resubmits. The reference is kept; the reason
    // stays on the row so the reviewer sees what was asked.
    const again = await submit('lst_1');
    expect(again.body.data).toMatchObject({ status: 'PENDING_REVIEW', displayId: 'LST-0909-2602' });
    const back = await queue();
    expect(back.body.data.items[0]).toMatchObject({ priorReason: 'Photos are blurry' });
    expect(back.body.data.items[0].submittedAt).not.toBeNull();

    // The case reads the same row with everything on it.
    const opened = await theCase('lst_1');
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({ id: 'lst_1', documents: [], photos: [], gate: { state: 'NOT_COVERED' } });

    // Approved. The old reason does not follow it onto the marketplace.
    const live = await publish('lst_1');
    expect(live.status).toBe(200);
    expect(live.body.data).toMatchObject({ status: 'ACTIVE', rejectionReason: null });
    expect(live.body.data.publishedAt).toBeTruthy();
    expect(state.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'LISTING_PUBLISHED',
      expect.anything(),
      { listingId: 'lst_1' }
    );

    // And past the desk, it can neither be sent back nor re-submitted.
    expect((await sendBack('lst_1', { reason: 'Photos are blurry' })).status).toBe(409);
    expect((await submit('lst_1')).status).toBe(409);
  });

  it('ends the road when the desk rejects outright', async () => {
    await submit('lst_1');
    const rejected = await sendBack('lst_1', { reason: 'Not an advertising surface', outcome: 'REJECTED' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Not an advertising surface' });

    // A rejected listing is not a draft: it cannot be resubmitted, and it is
    // not on the desk.
    expect((await submit('lst_1')).status).toBe(409);
    expect((await queue()).body.data.items).toHaveLength(0);
    expect((await publish('lst_1')).status).toBe(400);
  });
});

describe('who may do what at the desk', () => {
  /* This is the hole the queue closes. Submitting and publishing from the same
     phone in the same minute made "review within 24 hours" a promise ADX never
     got to keep. */
  it('no longer lets the publisher publish their own listing', async () => {
    await submit('lst_1');
    expect((await publish('lst_1', PUBLISHER)).status).toBe(403);
    expect(state.rows.get('lst_1')!.status).toBe('PENDING_REVIEW');
  });

  it('keeps the queue, the case and the send-back to ADX', async () => {
    await submit('lst_1');
    for (const call of [
      request(app).get('/api/v1/listings/review').set('Authorization', PUBLISHER),
      request(app).get('/api/v1/listings/lst_1/review').set('Authorization', PUBLISHER),
      request(app).post('/api/v1/listings/lst_1/send-back').set('Authorization', PUBLISHER).send({ reason: 'Photos are blurry' }),
    ]) {
      expect((await call).status).toBe(403);
    }
  });

  it('will not send a listing back without a reason the publisher can act on', async () => {
    await submit('lst_1');
    expect((await sendBack('lst_1', {})).status).toBe(400);
    expect((await sendBack('lst_1', { reason: 'no' })).status).toBe(400);
    expect(state.rows.get('lst_1')!.status).toBe('PENDING_REVIEW');
  });

  it('answers 404 for a case that does not exist', async () => {
    expect((await theCase('lst_missing')).status).toBe(404);
    expect((await sendBack('lst_missing', { reason: 'Photos are blurry' })).status).toBe(404);
  });
});
