import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 3 Oct 2026 — the owner, of Listings › Verification: "If verifications
 * lapsed, what action can we take here?" Pinned here:
 *
 *   Remind publisher   `POST /supply/listings/:id/reverification/remind`
 *                      (supply.edit) — the in-app row names the listing so a
 *                      tap opens it, the push rides the seeded template;
 *                      once a day per listing with the audit trail as the
 *                      clock; refused with nobody to tell.
 *   Send an agent      `POST /supply/listings/:id/reverification/site-check`
 *                      (supply.edit) — an AUDIT field visit through
 *                      `visits.createVisit`, to an agent the dispatch pick
 *                      finds in the listing's city; never a second while
 *                      the first is open.
 *   Give more time     `POST /supply/listings/:id/reverification/extend`
 *                      (supply.approve) — moves the due date from the later
 *                      of now and the date on file, releases the lapse's
 *                      holds, closes its open case, audits; refused for a
 *                      suspended listing with the sentence that says what to do.
 *   Resolve a case     `PATCH /supply/compliance/cases/:id/resolve` now
 *                      takes `{ outcome, note }` onto the audit row.
 *   Log an attempt     the channel list has VISIT.
 */

const { repository, notifications, users, agents, visits, audit } = vi.hoisted(() => ({
  repository: {
    findListing: vi.fn(),
    publisherContact: vi.fn(),
    publisherUserId: vi.fn(),
    setVerificationExpiry: vi.fn(),
    releaseHolds: vi.fn(),
    findOpenCaseForListing: vi.fn(),
    setCaseStatus: vi.fn(),
    findCase: vi.fn(),
    addContactAttempt: vi.fn(),
  },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  agents: { dispatchAskFor: vi.fn(), findAssignableAgentInCity: vi.fn() },
  visits: { createVisit: vi.fn(), getVisit: vi.fn() },
  audit: { findActivityRows: vi.fn(), logActivity: vi.fn() },
}));

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../agents', () => agents);
vi.mock('../../visits', () => visits);
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), ...audit }));

import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { tokenFor } from '../../../shared/testing';
import { supplyRouter } from '../supply.routes';
import { contactAttemptSchema, extendReverificationSchema, resolveCaseSchema } from '../supply.schema';
import {
  COMPLIANCE_RESOLVED_ACTION,
  REVERIFICATION_EXTENDED_ACTION,
  REVERIFICATION_REMINDER_ACTION,
  SITE_CHECK_ACTION,
  SITE_CHECK_TAG,
  dispatchSiteCheck,
  extendReverification,
  remindReverification,
  resolveComplianceCase,
} from '../supply.service';

const NOW = new Date('2026-10-03T06:00:00.000Z');
const DAY = 86_400_000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0310-2601',
  title: 'Hebbal Flyover Billboard',
  address: 'Airport Road, Hebbal',
  city: 'Bengaluru',
  cityId: 'city_blr',
  latitude: 13.035,
  longitude: 77.597,
  publisherId: 'pub_1',
  status: 'ACTIVE',
  removability: 'PERMANENT',
  verifiedAt: inDays(-185),
  verificationExpiresAt: inDays(-5),
  suspensionScopes: [],
  ...over,
});

const visitCard = (over: Record<string, unknown> = {}) => ({
  id: 'vis_1',
  displayId: 'VIS-0310-2601',
  status: 'REQUESTED',
  pill: { label: 'New request', tone: 'warn' },
  expiresInSeconds: 1200,
  ...over,
});

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/supply', supplyRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
const editOnly = signAccessToken('usr_edit', ['ADMIN'], undefined, { perms: ['supply.view', 'supply.edit'] });
const viewOnly = signAccessToken('usr_view', ['ADMIN'], undefined, { perms: ['supply.view'] });
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

beforeEach(() => {
  vi.clearAllMocks();
  repository.findListing.mockResolvedValue(listing());
  repository.publisherContact.mockResolvedValue({ name: 'Hebbal Media', userId: 'usr_pub', working: true });
  repository.publisherUserId.mockResolvedValue('usr_pub');
  repository.setVerificationExpiry.mockImplementation(async (id: string, at: Date) => ({ ...listing(), id, verificationExpiresAt: at }));
  repository.releaseHolds.mockResolvedValue(1);
  repository.findOpenCaseForListing.mockResolvedValue(null);
  repository.setCaseStatus.mockImplementation(async (id: string, status: string) => ({ id, status }));
  notifications.notify.mockResolvedValue({ notificationId: 'ntf_1', templateKey: 'listing-reverification-reminder', deliveries: [] });
  notifications.createNotification.mockResolvedValue({});
  users.listAdminUserIds.mockResolvedValue([]);
  agents.dispatchAskFor.mockImplementation(async (_band: unknown, spot: unknown) => ({ requiredGrade: 'G1', enforce: true, spot }));
  agents.findAssignableAgentInCity.mockResolvedValue({ id: 'agt_1' });
  visits.createVisit.mockImplementation(async (input: Record<string, unknown>) => ({ ...visitCard(), ...input }));
  visits.getVisit.mockResolvedValue(visitCard());
  audit.findActivityRows.mockResolvedValue([]);
  audit.logActivity.mockResolvedValue(undefined);
});

/* ── Remind publisher ─────────────────────────────────────────────────── */

describe('remind the publisher', () => {
  it('tells the publisher through notify, naming the listing so a tap opens it, and audits the reminder', async () => {
    const result = await remindReverification('lst_1', 'usr_admin', NOW);
    expect(result).toMatchObject({ listingId: 'lst_1', lapsed: true, remindedAt: NOW, nextAllowedAt: new Date(NOW.getTime() + DAY) });
    expect(notifications.notify).toHaveBeenCalledWith(
      'LISTING_REVERIFICATION_DUE',
      'usr_pub',
      expect.objectContaining({ listing: 'Hebbal Flyover Billboard', detail: expect.stringContaining('earnings are paused') }),
      { inApp: expect.objectContaining({ relatedType: 'LISTING', relatedId: 'lst_1', title: 'Is your spot still standing?' }) },
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', REVERIFICATION_REMINDER_ACTION, expect.objectContaining({ targetType: 'Listing', targetId: 'lst_1', module: 'supply' }));
  });

  it('says only "due" for a listing still inside its window', async () => {
    repository.findListing.mockResolvedValue(listing({ verificationExpiresAt: inDays(6) }));
    const result = await remindReverification('lst_1', 'usr_admin', NOW);
    expect(result.lapsed).toBe(false);
    expect(notifications.notify.mock.calls[0]![2].detail).toMatch(/needs a fresh photo from the spot by .*, or its earnings pause\./);
  });

  it('reads the audit trail as the clock: a second reminder inside the day is a 429 with when the next may go', async () => {
    audit.findActivityRows.mockResolvedValue([{ createdAt: new Date(NOW.getTime() - 3 * 3_600_000) }]);
    await expect(remindReverification('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 429, details: { nextAllowedAt: new Date(NOW.getTime() + 21 * 3_600_000) } });
    expect(audit.findActivityRows).toHaveBeenCalledWith(
      { action: REVERIFICATION_REMINDER_ACTION, targetType: 'Listing', targetId: 'lst_1', from: new Date(NOW.getTime() - DAY) },
      { skip: 0, take: 1, sort: 'newest' },
    );
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('refuses when there is nobody to tell, or nothing to remind about', async () => {
    repository.findListing.mockResolvedValue(listing({ publisherId: null }));
    await expect(remindReverification('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no publisher') });
    repository.findListing.mockResolvedValue(listing());
    repository.publisherContact.mockResolvedValue({ name: 'Hebbal Media', userId: null, working: true });
    await expect(remindReverification('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no login') });
    repository.publisherContact.mockResolvedValue({ name: 'Hebbal Media', userId: 'usr_pub', working: false });
    await expect(remindReverification('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.findListing.mockResolvedValue(listing({ verificationExpiresAt: null }));
    await expect(remindReverification('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.findListing.mockResolvedValue(null);
    await expect(remindReverification('lst_x', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

/* ── Give more time ───────────────────────────────────────────────────── */

describe('give more time', () => {
  it('moves a lapsed due date to now plus the days, releases the holds, closes the open case and audits the reason', async () => {
    repository.findOpenCaseForListing.mockResolvedValue({ id: 'cc_1', status: 'CONTACTED' });
    const result = await extendReverification('lst_1', { days: 7, reason: 'Publisher travelling, back next week' }, 'usr_admin', NOW);
    expect(repository.setVerificationExpiry).toHaveBeenCalledWith('lst_1', inDays(7));
    expect(repository.releaseHolds).toHaveBeenCalledWith('lst_1');
    expect(repository.setCaseStatus).toHaveBeenCalledWith('cc_1', 'RESOLVED');
    expect(result).toEqual({ listingId: 'lst_1', previousDueAt: inDays(-5), dueAt: inDays(7), days: 7, holdsReleased: 1, caseResolved: 'cc_1' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      REVERIFICATION_EXTENDED_ACTION,
      expect.objectContaining({
        targetType: 'Listing',
        targetId: 'lst_1',
        diff: { verificationExpiresAt: { before: inDays(-5).toISOString(), after: inDays(7).toISOString() } },
        metadata: expect.objectContaining({ days: 7, reason: 'Publisher travelling, back next week' }),
      }),
    );
    // The publisher hears the new date.
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', relatedType: 'LISTING', relatedId: 'lst_1' }));
  });

  it('adds the days to a date still ahead rather than to today', async () => {
    repository.findListing.mockResolvedValue(listing({ verificationExpiresAt: inDays(4) }));
    await extendReverification('lst_1', { days: 10, reason: 'Monsoon week' }, 'usr_admin', NOW);
    expect(repository.setVerificationExpiry).toHaveBeenCalledWith('lst_1', inDays(14));
  });

  it('refuses a suspended listing with the sentence that says what to do', async () => {
    repository.findListing.mockResolvedValue(listing({ status: 'SUSPENDED', suspensionScopes: ['BLOCK_NEW'] }));
    await expect(extendReverification('lst_1', { days: 7, reason: 'x y z' }, 'usr_admin', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This listing is suspended. Reinstate it first, then give it more time.',
    });
    // Suspended by the sweep for the lapse itself: an accepted check is the way back.
    repository.findListing.mockResolvedValue(listing({ status: 'SUSPENDED', suspensionScopes: [] }));
    await expect(extendReverification('lst_1', { days: 7, reason: 'x y z' }, 'usr_admin', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('remind the publisher or send an agent'),
    });
    expect(repository.setVerificationExpiry).not.toHaveBeenCalled();
  });

  it('refuses a listing never verified, and days outside 1–30', async () => {
    repository.findListing.mockResolvedValue(listing({ verificationExpiresAt: null }));
    await expect(extendReverification('lst_1', { days: 7, reason: 'x y z' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(extendReverification('lst_1', { days: 31, reason: 'x y z' }, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(extendReverificationSchema.safeParse({ days: 0, reason: 'Monsoon' }).success).toBe(false);
    expect(extendReverificationSchema.safeParse({ days: 30, reason: 'Monsoon' }).success).toBe(true);
    expect(extendReverificationSchema.safeParse({ days: 5 }).success).toBe(false);
  });
});

/* ── Send an agent ────────────────────────────────────────────────────── */

describe('send an agent for a site check', () => {
  it("books an AUDIT field visit through visits, to the agent the dispatch pick finds in the listing's city", async () => {
    const result = await dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW);
    expect(agents.findAssignableAgentInCity).toHaveBeenCalledWith(
      { cityId: 'city_blr', city: 'Bengaluru' },
      expect.objectContaining({ spot: { latitude: 13.035, longitude: 77.597 } }),
      NOW,
    );
    expect(visits.createVisit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'AUDIT',
        publisherId: 'pub_1',
        agentId: 'agt_1',
        businessName: 'Hebbal Flyover Billboard',
        city: 'Bengaluru',
        latitude: 13.035,
        longitude: 77.597,
        campaignTag: SITE_CHECK_TAG,
        notes: expect.stringContaining('Re-verification of LST-0310-2601'),
      }),
      { userId: 'usr_admin', isAdmin: true },
      NOW,
    );
    expect(result).toMatchObject({ listingId: 'lst_1', picked: true, visit: { id: 'vis_1' } });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', SITE_CHECK_ACTION, expect.objectContaining({ targetId: 'lst_1', metadata: expect.objectContaining({ visitId: 'vis_1', agentId: 'agt_1', picked: true }) }));
  });

  it('sends the named agent without picking', async () => {
    await dispatchSiteCheck('lst_1', { agentId: 'agt_9', note: 'Gate code 4411' }, 'usr_admin', NOW);
    expect(agents.findAssignableAgentInCity).not.toHaveBeenCalled();
    expect(visits.createVisit).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_9', notes: expect.stringContaining('Gate code 4411') }), expect.anything(), NOW);
  });

  it('refuses a second visit while the last one is still open, and allows one after it expired', async () => {
    audit.findActivityRows.mockResolvedValue([{ createdAt: NOW, metadata: { visitId: 'vis_1' } }]);
    await expect(dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('VIS-0310-2601') });
    expect(visits.createVisit).not.toHaveBeenCalled();
    visits.getVisit.mockResolvedValue(visitCard({ status: 'EXPIRED', expiresInSeconds: null }));
    await dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW);
    expect(visits.createVisit).toHaveBeenCalledTimes(1);
  });

  it('says so when nobody is free in the city, the listing has no city, or no publisher', async () => {
    agents.findAssignableAgentInCity.mockResolvedValue(null);
    await expect(dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('No agent is free in Bengaluru') });
    repository.findListing.mockResolvedValue(listing({ city: null, cityId: null }));
    await expect(dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no city') });
    repository.findListing.mockResolvedValue(listing({ publisherId: null }));
    await expect(dispatchSiteCheck('lst_1', {}, 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no publisher') });
    expect(visits.createVisit).not.toHaveBeenCalled();
  });
});

/* ── Compliance cases ─────────────────────────────────────────────────── */

describe('compliance cases', () => {
  it('resolves with the outcome and note on the audit row', async () => {
    repository.findCase.mockResolvedValue({ id: 'cc_1', listingId: 'lst_1', status: 'CONTACTED' });
    await resolveComplianceCase('cc_1', { outcome: 'Publisher re-verified', note: 'Photo came in this morning' }, 'usr_admin');
    expect(repository.setCaseStatus).toHaveBeenCalledWith('cc_1', 'RESOLVED');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      COMPLIANCE_RESOLVED_ACTION,
      expect.objectContaining({ targetType: 'ComplianceCase', targetId: 'cc_1', metadata: { listingId: 'lst_1', outcome: 'Publisher re-verified', note: 'Photo came in this morning' } }),
    );
  });

  it('takes a visit as a contact channel, and an empty resolve body still parses', () => {
    expect(contactAttemptSchema.safeParse({ channel: 'VISIT', outcome: 'Met the owner on site' }).success).toBe(true);
    expect(contactAttemptSchema.safeParse({ channel: 'FAX', outcome: 'x' }).success).toBe(false);
    expect(resolveCaseSchema.safeParse({}).success).toBe(true);
  });
});

/* ── The doors ────────────────────────────────────────────────────────── */

describe('the routes', () => {
  it('remind and site-check need supply.edit; extend needs supply.approve', async () => {
    const remind = await request(app()).post('/api/v1/supply/listings/lst_1/reverification/remind').set('Authorization', `Bearer ${editOnly}`);
    expect(remind.status).toBe(200);
    expect(remind.body.data).toMatchObject({ listingId: 'lst_1', lapsed: true });

    const check = await request(app()).post('/api/v1/supply/listings/lst_1/reverification/site-check').set('Authorization', `Bearer ${editOnly}`).send({});
    expect(check.status).toBe(201);
    expect(check.body.data.visit).toMatchObject({ id: 'vis_1' });

    const extendEdit = await request(app()).post('/api/v1/supply/listings/lst_1/reverification/extend').set('Authorization', `Bearer ${editOnly}`).send({ days: 7, reason: 'Monsoon week' });
    expect(extendEdit.status).toBe(403);

    const extend = await request(app()).post('/api/v1/supply/listings/lst_1/reverification/extend').set('Authorization', `Bearer ${admin}`).send({ days: 7, reason: 'Monsoon week' });
    expect(extend.status).toBe(200);
    expect(extend.body.data).toMatchObject({ listingId: 'lst_1', days: 7 });
  });

  it('refuses a viewer and a publisher, and a body out of range', async () => {
    for (const path of ['remind', 'site-check', 'extend']) {
      const asViewer = await request(app()).post(`/api/v1/supply/listings/lst_1/reverification/${path}`).set('Authorization', `Bearer ${viewOnly}`).send({ days: 7, reason: 'Monsoon week' });
      expect(asViewer.status, path).toBe(403);
      const asPublisher = await request(app()).post(`/api/v1/supply/listings/lst_1/reverification/${path}`).set('Authorization', `Bearer ${publisher}`).send({ days: 7, reason: 'Monsoon week' });
      expect(asPublisher.status, path).toBe(403);
    }
    const tooLong = await request(app()).post('/api/v1/supply/listings/lst_1/reverification/extend').set('Authorization', `Bearer ${admin}`).send({ days: 45, reason: 'Monsoon week' });
    expect(tooLong.status).toBe(400);
    expect(repository.setVerificationExpiry).not.toHaveBeenCalled();
  });

  it('resolve takes the outcome and note through the existing route', async () => {
    repository.findCase.mockResolvedValue({ id: 'cc_1', listingId: 'lst_1', status: 'OPEN' });
    const res = await request(app()).patch('/api/v1/supply/compliance/cases/cc_1/resolve').set('Authorization', `Bearer ${admin}`).send({ outcome: 'Spot confirmed by agent', note: 'Visit VIS-1' });
    expect(res.status).toBe(200);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', COMPLIANCE_RESOLVED_ACTION, expect.objectContaining({ metadata: { listingId: 'lst_1', outcome: 'Spot confirmed by agent', note: 'Visit VIS-1' } }));
  });
});
