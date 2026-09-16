import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnouncementsRepository } from '../announcements.repository';

/**
 * Announcements — Lot E (Q64/Q130).
 *
 * What is pinned: SMS is refused on a NORMAL announcement and never sent by
 * one; the preview counts in-app as the audience, email as those with an
 * address who have not unsubscribed, SMS only when CRITICAL and the kind is
 * registered; send now moves to SENDING and send later to SCHEDULED, both
 * audited; the fan-out walks the audience in batches through the dispatcher,
 * marks every (person, channel) once so a rerun sends nothing twice, stops
 * when cancelled, and audits ANNOUNCEMENT_SENT when it finishes.
 */

const { repository, notifications, sms, audit } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    transition: vi.fn(),
    findDue: vi.fn(),
    findSending: vi.fn(),
    audienceCounts: vi.fn(),
    audiencePage: vi.fn(),
    existingMarks: vi.fn(),
    writeMarks: vi.fn(),
    markCounts: vi.fn(),
  } satisfies Record<keyof AnnouncementsRepository, ReturnType<typeof vi.fn>>,
  notifications: { notify: vi.fn(), unsubscribeUrlFor: vi.fn((id: string) => `https://adx.local/api/v1/comms/unsubscribe/${id}.sig`) },
  sms: { isSmsKindRegistered: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-announcements.repository', () => ({ prismaAnnouncementsRepository: repository }));
vi.mock('../../notifications', () => notifications);
vi.mock('../../feature-flags', () => passThroughFeatureGates());
vi.mock('../../../shared/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/sms')>();
  return { ...actual, ...sms };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { announcementRouter } from '../announcements.routes';
import { createAnnouncement, isSmsQuietHour, previewCount, runAnnouncement, sendDueAnnouncements, smsAllowed } from '../announcements.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/announcements', announcementRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm-1');
const agent = tokenFor(['AGENT_PUBLISHER'], 'agt-1');

const announcement = (over: Record<string, unknown> = {}) => ({
  id: 'ann-1',
  title: 'Planned maintenance',
  body: 'ADX is down 02:00–03:00 IST on Sunday.',
  audience: 'ALL',
  city: null,
  channels: ['IN_APP', 'EMAIL', 'SMS'],
  importance: 'CRITICAL',
  scheduledAt: null,
  status: 'DRAFT',
  recipientCount: 0,
  deliveredByChannel: null,
  createdById: 'adm-1',
  sentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const member = (id: string, over: Record<string, unknown> = {}) => ({ id, email: `${id}@x.com`, mobile: '+919845000001', emailUnsubscribedAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  repository.create.mockImplementation(async (data: Record<string, unknown>) => announcement({ ...data }));
  repository.findById.mockResolvedValue(announcement());
  repository.list.mockResolvedValue({ items: [announcement()], total: 1, counts: { DRAFT: 1, SCHEDULED: 0, SENDING: 0, SENT: 0, CANCELLED: 0 } });
  repository.update.mockResolvedValue(announcement());
  repository.transition.mockResolvedValue(true);
  repository.findDue.mockResolvedValue([]);
  repository.findSending.mockResolvedValue([]);
  repository.audienceCounts.mockResolvedValue({ total: 3, withEmail: 2, withMobile: 3, devices: 5 });
  repository.audiencePage.mockResolvedValue([]);
  repository.existingMarks.mockResolvedValue([]);
  repository.writeMarks.mockImplementation(async (_id: string, marks: unknown[]) => marks.length);
  repository.markCounts.mockResolvedValue({ IN_APP: { DELIVERED: 3 }, EMAIL: { QUEUED: 2 }, SMS: { QUEUED: 3 } });
  sms.isSmsKindRegistered.mockResolvedValue(true);
  notifications.notify.mockImplementation(async (_event: string, userId: string, _vars: unknown, opts: { channels: string[]; inApp?: unknown }) => ({
    notificationId: opts.inApp ? `ntf-${userId}` : null,
    templateKey: 'announcement',
    deliveries: opts.channels.map((channel) => ({ channel, deliveryId: `dlv-${userId}-${channel}` })),
  }));
});

describe('the SMS rule (Q130)', () => {
  it('knows the quiet hours in IST', () => {
    expect(isSmsQuietHour(new Date('2026-09-12T16:30:00.000Z'))).toBe(true); // 22:00 IST
    expect(isSmsQuietHour(new Date('2026-09-12T03:00:00.000Z'))).toBe(true); // 08:30 IST
    expect(isSmsQuietHour(new Date('2026-09-12T04:00:00.000Z'))).toBe(false); // 09:30 IST
  });

  it('allows SMS for CRITICAL at any hour and never for NORMAL', () => {
    const night = new Date('2026-09-12T16:30:00.000Z');
    expect(smsAllowed({ importance: 'CRITICAL', channels: ['SMS'] }, night)).toBe(true);
    expect(smsAllowed({ importance: 'NORMAL', channels: ['SMS'] }, new Date('2026-09-12T04:00:00.000Z'))).toBe(false);
    expect(smsAllowed({ importance: 'CRITICAL', channels: ['EMAIL'] }, night)).toBe(false);
  });

  it('refuses SMS on a NORMAL announcement at creation, and always adds in-app', async () => {
    await expect(
      createAnnouncement({ title: 'Sale', body: 'Buy now', audience: 'ALL', channels: ['EMAIL', 'SMS'], importance: 'NORMAL' }, 'adm-1'),
    ).rejects.toMatchObject({ statusCode: 400 });

    const created = await createAnnouncement({ title: 'Sale', body: 'Buy now', audience: 'ADVERTISERS', channels: ['EMAIL'], importance: 'NORMAL', city: ' Bengaluru ' }, 'adm-1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ channels: ['IN_APP', 'EMAIL'], city: 'Bengaluru', createdById: 'adm-1' }));
    expect(created.status).toBe('DRAFT');
  });

  it('G10: accepts PUSH as a channel — the dispatcher has a push rail now', async () => {
    const created = await createAnnouncement({ title: 'Sale', body: 'Buy now', audience: 'ALL', channels: ['PUSH'], importance: 'NORMAL' }, 'adm-1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ channels: ['IN_APP', 'PUSH'] }));
    expect(created.status).toBe('DRAFT');
  });
});

describe('preview count', () => {
  it('counts in-app as the audience, email as the subscribed with an address, SMS only when CRITICAL and registered', async () => {
    await expect(previewCount('ann-1')).resolves.toEqual({ audience: 3, inApp: 3, email: 2, sms: 3, push: 0, smsNote: null });

    sms.isSmsKindRegistered.mockResolvedValue(false);
    await expect(previewCount('ann-1')).resolves.toMatchObject({ sms: 0, smsNote: expect.stringContaining('not registered') });

    repository.findById.mockResolvedValue(announcement({ importance: 'NORMAL', channels: ['IN_APP', 'EMAIL'] }));
    await expect(previewCount('ann-1')).resolves.toEqual({ audience: 3, inApp: 3, email: 2, sms: 0, push: 0, smsNote: null });
  });

  it('G11-2: push is the devices on file in the audience, and only when PUSH is a channel', async () => {
    repository.findById.mockResolvedValue(announcement({ importance: 'NORMAL', channels: ['IN_APP', 'PUSH'] }));
    await expect(previewCount('ann-1')).resolves.toEqual({ audience: 3, inApp: 3, email: 0, sms: 0, push: 5, smsNote: null });

    const res = await request(app())
      .post('/api/v1/announcements/preview-count')
      .set('Authorization', `Bearer ${admin}`)
      .send({ audience: 'AGENTS', channels: ['IN_APP', 'PUSH'], importance: 'NORMAL' });
    expect(res.status).toBe(200);
    expect(res.body.data.push).toBe(5);
    expect(repository.audienceCounts).toHaveBeenCalledWith('AGENTS', null);
  });

  it('E10-2: answers the same shape over a draft body at POST /preview-count, persisting nothing', async () => {
    const res = await request(app())
      .post('/api/v1/announcements/preview-count')
      .set('Authorization', `Bearer ${admin}`)
      .send({ audience: 'PUBLISHERS', city: 'Bengaluru', channels: ['IN_APP', 'EMAIL', 'SMS'], importance: 'CRITICAL' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ audience: 3, inApp: 3, email: 2, sms: 3, push: 0, smsNote: null });
    expect(repository.audienceCounts).toHaveBeenCalledWith('PUBLISHERS', 'Bengaluru');
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.findById).not.toHaveBeenCalled();

    // A NORMAL draft naming SMS is not refused the way a create is: zero, with the reason to print.
    const normal = await request(app())
      .post('/api/v1/announcements/preview-count')
      .set('Authorization', `Bearer ${admin}`)
      .send({ audience: 'ALL', channels: ['EMAIL', 'SMS'], importance: 'NORMAL' });
    expect(normal.status).toBe(200);
    expect(normal.body.data).toMatchObject({ sms: 0, smsNote: expect.stringContaining('CRITICAL') });

    expect((await request(app()).post('/api/v1/announcements/preview-count').set('Authorization', `Bearer ${admin}`).send({ audience: 'EVERYONE', channels: [] })).status).toBe(400);
    expect((await request(app()).post('/api/v1/announcements/preview-count').set('Authorization', `Bearer ${agent}`).send({ channels: ['IN_APP'] })).status).toBe(403);
  });
});

describe('the desk over HTTP', () => {
  it('is ADMIN only', async () => {
    expect((await request(app()).get('/api/v1/announcements')).status).toBe(401);
    expect((await request(app()).get('/api/v1/announcements').set('Authorization', `Bearer ${agent}`)).status).toBe(403);
  });

  it('lists on the list contract', async () => {
    const res = await request(app()).get('/api/v1/announcements?status=DRAFT&q=maint').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 1, page: 1, pageSize: 20, counts: { DRAFT: 1 } });
    expect(repository.list).toHaveBeenCalledWith({ q: 'maint', status: ['DRAFT'], audience: undefined }, expect.objectContaining({ sort: 'newest' }));
  });

  it('creates a draft and audits it', async () => {
    const res = await request(app())
      .post('/api/v1/announcements')
      .set('Authorization', `Bearer ${admin}`)
      .send({ title: 'Planned maintenance', body: 'Sunday 02:00', audience: 'ALL', channels: ['EMAIL', 'SMS'], importance: 'CRITICAL' });
    expect(res.status).toBe(201);
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'ANNOUNCEMENT_CREATED', expect.objectContaining({ targetType: 'Announcement', targetId: 'ann-1' }));
  });

  it('sends now as SENDING and later as SCHEDULED, each audited', async () => {
    repository.findById.mockResolvedValueOnce(announcement()).mockResolvedValueOnce(announcement({ status: 'SENDING' }));
    const now = await request(app()).post('/api/v1/announcements/ann-1/send').set('Authorization', `Bearer ${admin}`).send({});
    expect(now.status).toBe(200);
    expect(repository.transition).toHaveBeenCalledWith('ann-1', ['DRAFT', 'SCHEDULED'], 'SENDING', { scheduledAt: expect.any(Date) });
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'ANNOUNCEMENT_SEND_REQUESTED', expect.objectContaining({ targetId: 'ann-1' }));

    const future = new Date(Date.now() + 3_600_000).toISOString();
    repository.findById.mockResolvedValueOnce(announcement()).mockResolvedValueOnce(announcement({ status: 'SCHEDULED' }));
    const later = await request(app()).post('/api/v1/announcements/ann-1/send').set('Authorization', `Bearer ${admin}`).send({ scheduledAt: future });
    expect(later.status).toBe(200);
    expect(repository.transition).toHaveBeenLastCalledWith('ann-1', ['DRAFT', 'SCHEDULED'], 'SCHEDULED', { scheduledAt: new Date(future) });
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'ANNOUNCEMENT_SCHEDULED', expect.objectContaining({ targetId: 'ann-1' }));
  });

  it('refuses to send one already sent, and cancels a scheduled one with an audit row', async () => {
    repository.findById.mockResolvedValue(announcement({ status: 'SENT' }));
    expect((await request(app()).post('/api/v1/announcements/ann-1/send').set('Authorization', `Bearer ${admin}`).send({})).status).toBe(409);
    expect((await request(app()).post('/api/v1/announcements/ann-1/cancel').set('Authorization', `Bearer ${admin}`)).status).toBe(409);

    repository.findById.mockResolvedValueOnce(announcement({ status: 'SCHEDULED' })).mockResolvedValueOnce(announcement({ status: 'CANCELLED' }));
    const res = await request(app()).post('/api/v1/announcements/ann-1/cancel').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'ANNOUNCEMENT_CANCELLED', expect.objectContaining({ targetId: 'ann-1', metadata: { from: 'SCHEDULED' } }));
  });
});

describe('the fan-out', () => {
  it('G10: fans a PUSH announcement out through the dispatcher and marks the channel', async () => {
    repository.findById.mockResolvedValue(announcement({ status: 'SENDING', channels: ['IN_APP', 'PUSH'] }));
    repository.audiencePage.mockResolvedValueOnce([member('u1')]).mockResolvedValueOnce([]);
    repository.existingMarks.mockResolvedValue([]);

    await runAnnouncement('ann-1', new Date('2026-09-12T16:30:00.000Z'));

    expect(notifications.notify.mock.calls[0]![3]).toMatchObject({ channels: ['PUSH'] });
    expect(repository.writeMarks).toHaveBeenCalledWith('ann-1', [
      { userId: 'u1', channel: 'IN_APP', status: 'DELIVERED' },
      { userId: 'u1', channel: 'PUSH', status: 'QUEUED' },
    ]);
  });

  it('walks the audience in pages through the dispatcher, marks each (person, channel) once, and audits ANNOUNCEMENT_SENT', async () => {
    repository.findById.mockResolvedValue(announcement({ status: 'SENDING' }));
    repository.audiencePage
      .mockResolvedValueOnce([member('u1'), member('u2', { emailUnsubscribedAt: new Date() })])
      .mockResolvedValueOnce([member('u3')])
      .mockResolvedValueOnce([]);
    // u1 already has its in-app row and email from an earlier, interrupted run.
    repository.existingMarks.mockResolvedValueOnce([{ userId: 'u1', channel: 'IN_APP' }, { userId: 'u1', channel: 'EMAIL' }]).mockResolvedValue([]);

    const result = await runAnnouncement('ann-1', new Date('2026-09-12T16:30:00.000Z'));
    expect(result).toEqual({ recipients: 3, batches: 2, cancelled: false });

    // u1: only the SMS is left; u2 and u3: everything.
    expect(notifications.notify).toHaveBeenCalledTimes(3);
    const u1 = notifications.notify.mock.calls.find((c) => c[1] === 'u1')!;
    expect(u1[3]).toMatchObject({ type: 'ANNOUNCEMENT', channels: ['SMS'] });
    expect(u1[3]).not.toHaveProperty('inApp');
    const u3 = notifications.notify.mock.calls.find((c) => c[1] === 'u3')!;
    expect(u3[0]).toBe('ANNOUNCEMENT');
    expect(u3[2]).toEqual({ title: 'Planned maintenance', body: 'ADX is down 02:00–03:00 IST on Sunday.', unsubscribeUrl: 'https://adx.local/api/v1/comms/unsubscribe/u3.sig' });
    expect(u3[3]).toMatchObject({ channels: ['EMAIL', 'SMS'], inApp: { type: 'ANNOUNCEMENT', title: 'Planned maintenance', subtitle: 'Service notice', relatedId: 'ann-1' } });

    expect(repository.writeMarks).toHaveBeenNthCalledWith(1, 'ann-1', [
      { userId: 'u1', channel: 'SMS', status: 'QUEUED' },
      { userId: 'u2', channel: 'IN_APP', status: 'DELIVERED' },
      { userId: 'u2', channel: 'EMAIL', status: 'QUEUED' },
      { userId: 'u2', channel: 'SMS', status: 'QUEUED' },
    ]);
    expect(repository.audiencePage).toHaveBeenNthCalledWith(2, 'ALL', null, 'u2', 500);
    expect(repository.transition).toHaveBeenCalledWith('ann-1', ['SENDING'], 'SENT', expect.objectContaining({ recipientCount: 3, deliveredByChannel: expect.any(Object) }));
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'ANNOUNCEMENT_SENT', expect.objectContaining({ targetType: 'Announcement', targetId: 'ann-1', metadata: expect.objectContaining({ recipientCount: 3 }) }));
  });

  /* Lot F: a body typed as paragraphs reads as paragraphs in the email. The
     announcement hands the dispatcher the raw text; the renderer breaks the
     lines after escaping, so the desk still cannot type markup into a mail. */
  it('passes the body verbatim, newlines included, and the email renders them as <br>', async () => {
    const body = 'ADX is down 02:00-03:00 IST on Sunday.' + String.fromCharCode(10) + 'Payouts resume Monday.';
    repository.findById.mockResolvedValue(announcement({ status: 'SENDING', importance: 'NORMAL', body }));
    repository.audiencePage.mockResolvedValueOnce([member('u1')]).mockResolvedValueOnce([]);
    await runAnnouncement('ann-1');
    const vars = notifications.notify.mock.calls[0]![2] as { body: string };
    // Verbatim: no <br> typed here; the renderer (notifications' renderHtml,
    // pinned in its own suite) breaks the lines after escaping.
    expect(vars.body).toBe(body);
    expect(vars.body).not.toContain('<br>');
    const inApp = (notifications.notify.mock.calls[0]![3] as { inApp: { message: string } }).inApp;
    expect(inApp.message).toBe(body);
  });

  it('never sends SMS for a NORMAL announcement even when the desk somehow chose it', async () => {
    repository.findById.mockResolvedValue(announcement({ status: 'SENDING', importance: 'NORMAL' }));
    repository.audiencePage.mockResolvedValueOnce([member('u1')]).mockResolvedValueOnce([]);
    await runAnnouncement('ann-1');
    expect(notifications.notify.mock.calls[0]![3]).toMatchObject({ channels: ['EMAIL'] });
  });

  it('records a skipped channel as SKIPPED and stops between batches when cancelled', async () => {
    repository.findById.mockResolvedValueOnce(announcement({ status: 'SENDING' })).mockResolvedValueOnce(announcement({ status: 'SENDING' })).mockResolvedValue(announcement({ status: 'CANCELLED' }));
    repository.audiencePage.mockResolvedValueOnce([member('u1')]).mockResolvedValueOnce([member('u2')]);
    notifications.notify.mockResolvedValue({ notificationId: 'ntf', templateKey: 'announcement', deliveries: [{ channel: 'EMAIL', deliveryId: null, skipped: 'UNSUBSCRIBED' }, { channel: 'SMS', deliveryId: 'd' }] });

    const result = await runAnnouncement('ann-1');
    expect(result).toEqual({ recipients: 3, batches: 1, cancelled: true });
    expect(repository.writeMarks).toHaveBeenCalledWith('ann-1', expect.arrayContaining([{ userId: 'u1', channel: 'EMAIL', status: 'SKIPPED' }]));
    expect(repository.transition).not.toHaveBeenCalledWith('ann-1', ['SENDING'], 'SENT', expect.anything());
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('promotes what is due and runs what is sending on a tick', async () => {
    repository.findDue.mockResolvedValue([announcement({ id: 'due-1', status: 'SCHEDULED' })]);
    repository.findSending.mockResolvedValue([announcement({ id: 'due-1', status: 'SENDING' })]);
    repository.findById.mockResolvedValue(announcement({ id: 'due-1', status: 'SENDING' }));
    await expect(sendDueAnnouncements()).resolves.toEqual({ promoted: 1, ran: 1 });
    expect(repository.transition).toHaveBeenCalledWith('due-1', ['SCHEDULED'], 'SENDING');
  });
});
