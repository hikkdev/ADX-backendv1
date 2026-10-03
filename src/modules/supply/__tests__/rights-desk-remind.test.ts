import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 3 Oct 2026 — the renewals desk (Listings › Renewals) gets the other
 * queues' row menu and bulk bar. Its "Remind publisher to renew" is
 * `POST /supply/listings/:id/rights/remind` (ADMIN, supply.edit). Pinned:
 * the publisher gets the sweep's in-app notice naming the listing, worded
 * for an ending or an expired term; `rightsRemindedAt` is stamped so the
 * sweep counts it; the reminder is audited and goes at most once a day
 * with the audit trail as the clock; it is refused for an owned spot and
 * when there is nobody to tell; a viewer and a publisher may not send it.
 */

const { repository, notifications, users, audit } = vi.hoisted(() => ({
  repository: {
    findListing: vi.fn(),
    publisherContact: vi.fn(),
    setRights: vi.fn(),
  },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  audit: { findActivityRows: vi.fn(), logActivity: vi.fn() },
}));

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), ...audit }));

import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { tokenFor } from '../../../shared/testing';
import { supplyRouter } from '../supply.routes';
import { RIGHTS_REMINDER_ACTION, remindRightsRenewal } from '../supply.service';

const NOW = new Date('2026-10-03T06:00:00.000Z');
const DAY = 86_400_000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-2009-2601',
  title: 'Hebbal Flyover Billboard',
  publisherId: 'pub_1',
  status: 'ACTIVE',
  availableNow: true,
  rightsBasis: 'PERMIT',
  rightsValidUntil: inDays(12),
  rightsLapsedAt: null,
  rightsRemindedAt: null,
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
  repository.setRights.mockResolvedValue({});
  notifications.createNotification.mockResolvedValue({});
  audit.findActivityRows.mockResolvedValue([]);
  audit.logActivity.mockResolvedValue(undefined);
});

describe('remind the publisher to renew', () => {
  it('tells the publisher the term is ending, naming the listing, stamps the reminder and audits it', async () => {
    const result = await remindRightsRenewal('lst_1', 'usr_admin', NOW);
    expect(result).toEqual({ listingId: 'lst_1', expired: false, validUntil: inDays(12), remindedAt: NOW, nextAllowedAt: inDays(1) });
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', relatedType: 'LISTING', relatedId: 'lst_1', title: 'Your permit on Hebbal Flyover Billboard ends in 12 days' }),
    );
    expect(repository.setRights).toHaveBeenCalledWith('lst_1', { rightsRemindedAt: NOW });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      RIGHTS_REMINDER_ACTION,
      expect.objectContaining({ module: 'supply', targetType: 'Listing', targetId: 'lst_1', metadata: expect.objectContaining({ expired: false, rightsBasis: 'PERMIT' }) }),
    );
  });

  it('says the term has run out for an expired one', async () => {
    repository.findListing.mockResolvedValue(listing({ rightsBasis: 'LEASED', rightsValidUntil: inDays(-4), rightsLapsedAt: inDays(-4), availableNow: false }));
    const result = await remindRightsRenewal('lst_1', 'usr_admin', NOW);
    expect(result.expired).toBe(true);
    const note = notifications.createNotification.mock.calls[0]![0];
    expect(note.title).toBe('Your lease on Hebbal Flyover Billboard has run out');
    expect(note.message).toMatch(/takes no new booking until you upload the renewed document/);
  });

  it('reads the audit trail as the clock: a second reminder inside the day is a 429 with when the next may go', async () => {
    audit.findActivityRows.mockResolvedValue([{ createdAt: new Date(NOW.getTime() - 5 * 3_600_000) }]);
    await expect(remindRightsRenewal('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 429, details: { nextAllowedAt: new Date(NOW.getTime() + 19 * 3_600_000) } });
    expect(audit.findActivityRows).toHaveBeenCalledWith(
      { action: RIGHTS_REMINDER_ACTION, targetType: 'Listing', targetId: 'lst_1', from: new Date(NOW.getTime() - DAY) },
      { skip: 0, take: 1, sort: 'newest' },
    );
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(repository.setRights).not.toHaveBeenCalled();
  });

  it('refuses an owned spot, and when there is nobody to tell', async () => {
    repository.findListing.mockResolvedValue(listing({ rightsBasis: 'OWNED', rightsValidUntil: null }));
    await expect(remindRightsRenewal('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('nothing to renew') });
    repository.findListing.mockResolvedValue(listing({ publisherId: null }));
    await expect(remindRightsRenewal('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no publisher') });
    repository.findListing.mockResolvedValue(listing());
    repository.publisherContact.mockResolvedValue({ name: 'Hebbal Media', userId: null, working: true });
    await expect(remindRightsRenewal('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no login') });
    repository.publisherContact.mockResolvedValue({ name: 'Hebbal Media', userId: 'usr_pub', working: false });
    await expect(remindRightsRenewal('lst_1', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.findListing.mockResolvedValue(null);
    await expect(remindRightsRenewal('lst_x', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});

describe('the route', () => {
  it('takes supply.edit, and refuses a viewer and a publisher', async () => {
    const ok = await request(app()).post('/api/v1/supply/listings/lst_1/rights/remind').set('Authorization', `Bearer ${editOnly}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ listingId: 'lst_1', expired: false });
    const asAdmin = await request(app()).post('/api/v1/supply/listings/lst_1/rights/remind').set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    const asViewer = await request(app()).post('/api/v1/supply/listings/lst_1/rights/remind').set('Authorization', `Bearer ${viewOnly}`);
    expect(asViewer.status).toBe(403);
    const asPublisher = await request(app()).post('/api/v1/supply/listings/lst_1/rights/remind').set('Authorization', `Bearer ${publisher}`);
    expect(asPublisher.status).toBe(403);
  });
});
