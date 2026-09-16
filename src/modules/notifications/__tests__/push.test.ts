import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushRepository } from '../push/push.repository';
import type { DeviceToken } from '../../../shared/database';

/**
 * Push — G6 (Q103/133).
 *
 * What is pinned: a device token is upserted on the token and moves to the
 * caller; a refresh leaves no audit row, a new phone or a moved token does;
 * a sign-out removes only the caller's own row (404 otherwise); a send goes
 * to every device, deletes a row FCM calls UNREGISTERED, and answers
 * `skipped` rather than failing when Firebase is not configured; the flag
 * broadcast is a silent data push walked in batches; the dispatcher's PUSH
 * delivery is SENT on one device, SKIPPED with no devices or no Firebase,
 * retried on a rail outage and FAILED outright when every token is stale.
 */

const { pushRepo, fcm, audit, comms, notifRepo } = vi.hoisted(() => ({
  pushRepo: {
    register: vi.fn(),
    remove: vi.fn(),
    removeByToken: vi.fn(),
    listForUser: vi.fn(),
    listAll: vi.fn(),
    countAll: vi.fn(),
  } satisfies Record<keyof PushRepository, ReturnType<typeof vi.fn>>,
  fcm: { send: vi.fn(), isConfigured: vi.fn(), resetToken: vi.fn() },
  audit: { logActivity: vi.fn() },
  comms: {
    recordAttempt: vi.fn(),
    updateDelivery: vi.fn(),
    findDelivery: vi.fn(),
    findTemplateByKey: vi.fn(),
    findActiveTemplate: vi.fn(),
    findRecipient: vi.fn(),
    createDelivery: vi.fn(),
    nonTransactionalTemplateKeys: vi.fn(),
  },
  notifRepo: { findById: vi.fn(), create: vi.fn(), findPreferences: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../push/prisma-push.repository', () => ({ prismaPushRepository: pushRepo }));
vi.mock('../prisma-comms.repository', () => ({ prismaCommsRepository: comms }));
vi.mock('../prisma-notifications.repository', () => ({ prismaNotificationRepository: notifRepo }));
vi.mock('../../../shared/push', () => ({ fcm }));
vi.mock('../../feature-flags', () => passThroughFeatureGates());
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../../shared/cache', () => ({ redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() } }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { deviceRouter } from '../push/devices.routes';
import { broadcastFlagsChanged, registerDevice, removeDevice, sendToDevices, toDeviceView } from '../push/push.service';
import { attemptPushDelivery } from '../push/push-delivery';
import { notify } from '../dispatch.service';
import { maskDevices } from '../recipient';

const device = (over: Partial<DeviceToken> = {}): DeviceToken => ({
  id: 'dev-1',
  userId: 'usr-1',
  app: 'USER',
  platform: 'ANDROID',
  token: 'fcm-token-0123456789-abcdefghij-ABCDEF',
  appVersion: '1.4.0',
  lastSeenAt: new Date('2026-09-14T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  key: 'data-export-ready',
  event: 'DATA_EXPORT_READY',
  channels: ['EMAIL', 'PUSH'],
  subject: 'Your ADX data export is ready',
  emailBody: '<p>{{url}}</p>',
  smsKind: null,
  smsBody: 'Ready until {{expiresAt}}.',
  isSensitive: false,
  transactional: true,
  pushTitle: null,
  pushBody: null,
  status: 'ACTIVE',
  version: 1,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'dlv-push-1',
  userId: 'usr-1',
  notificationId: null,
  templateKey: 'data-export-ready',
  channel: 'PUSH',
  recipientMasked: '1 device',
  recipientHash: 'x'.repeat(64),
  variables: { expiresAt: '21 Sep 2026', url: 'adx://data-export/req-1' },
  status: 'QUEUED',
  attempts: 0,
  provider: null,
  providerMessageId: null,
  lastError: null,
  sentAt: null,
  deliveredAt: null,
  purgedAt: null,
  createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fcm.isConfigured.mockReturnValue(true);
  comms.updateDelivery.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...delivery({ id }), ...patch }));
  comms.recordAttempt.mockResolvedValue({});
  pushRepo.removeByToken.mockResolvedValue(true);
});

/* ── the registry ────────────────────────────────────────────────── */

describe('registerDevice', () => {
  it('writes a new row and audits DEVICE_REGISTERED', async () => {
    pushRepo.register.mockResolvedValue({ row: device(), created: true, movedFromUserId: null });
    const result = await registerDevice({ userId: 'usr-1', token: device().token, app: 'USER', platform: 'ANDROID', appVersion: '1.4.0' });
    expect(result.created).toBe(true);
    expect(result.device.tokenSuffix).toBe('ABCDEF');
    expect(result.device).not.toHaveProperty('token');
    expect(audit.logActivity).toHaveBeenCalledWith('usr-1', 'DEVICE_REGISTERED', expect.objectContaining({ targetType: 'DeviceToken', targetId: 'dev-1', module: 'notifications' }));
  });

  it('refreshes silently when the same login sends the same token again', async () => {
    pushRepo.register.mockResolvedValue({ row: device(), created: false, movedFromUserId: null });
    const result = await registerDevice({ userId: 'usr-1', token: device().token, app: 'USER', platform: 'ANDROID' });
    expect(result).toMatchObject({ created: false, moved: false });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('moves the token to the caller when a phone changes hands, and says so', async () => {
    pushRepo.register.mockResolvedValue({ row: device({ userId: 'usr-2' }), created: false, movedFromUserId: 'usr-1' });
    const result = await registerDevice({ userId: 'usr-2', token: device().token, app: 'AGENT', platform: 'IOS' });
    expect(result.moved).toBe(true);
    expect(audit.logActivity).toHaveBeenCalledWith('usr-2', 'DEVICE_MOVED', expect.objectContaining({ metadata: expect.objectContaining({ movedFromUserId: 'usr-1' }) }));
  });
});

describe('removeDevice', () => {
  it('removes the caller’s own row', async () => {
    pushRepo.remove.mockResolvedValue(true);
    await removeDevice('usr-1', device().token);
    expect(pushRepo.remove).toHaveBeenCalledWith('usr-1', device().token);
    expect(audit.logActivity).toHaveBeenCalledWith('usr-1', 'DEVICE_REMOVED', expect.objectContaining({ targetId: 'ABCDEF' }));
  });

  it('is a 404 for a token that is not the caller’s — never a hint that it exists', async () => {
    pushRepo.remove.mockResolvedValue(false);
    await expect(removeDevice('usr-9', device().token)).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ── sending ─────────────────────────────────────────────────────── */

describe('sendToDevices', () => {
  it('sends to every device, counts the successes and keeps only token suffixes', async () => {
    fcm.send.mockResolvedValueOnce({ ok: true, messageId: 'projects/p/messages/1' }).mockResolvedValueOnce({ ok: true, messageId: 'projects/p/messages/2' });
    const outcome = await sendToDevices([device(), device({ id: 'dev-2', token: 'second-token-0123456789-zzzzzz' })], { notification: { title: 'T', body: 'B' } });
    expect(outcome).toMatchObject({ devices: 2, sent: 2, unregistered: 0, retryable: 0, failed: 0, skipped: null, messageId: 'projects/p/messages/1' });
    expect(outcome.results.map((r) => r.tokenSuffix)).toEqual(['ABCDEF', 'zzzzzz']);
    expect(JSON.stringify(outcome)).not.toContain('fcm-token-0123456789');
  });

  it('deletes the row behind a token FCM calls UNREGISTERED', async () => {
    fcm.send.mockResolvedValueOnce({ ok: false, error: 'UNREGISTERED', status: 404, detail: 'Requested entity was not found.' });
    const outcome = await sendToDevices([device()], { data: { type: 'X' } });
    expect(outcome).toMatchObject({ sent: 0, unregistered: 1 });
    expect(pushRepo.removeByToken).toHaveBeenCalledWith(device().token);
  });

  it('answers skipped, not failed, when Firebase is not configured', async () => {
    fcm.send.mockResolvedValue({ skipped: true, reason: 'FCM_NOT_CONFIGURED' });
    const outcome = await sendToDevices([device(), device({ id: 'dev-2', token: 'second-token-0123456789-zzzzzz' })], { data: { type: 'X' } });
    expect(outcome).toMatchObject({ devices: 2, sent: 0, skipped: 'FCM_NOT_CONFIGURED' });
    // Said once: the second device is never tried.
    expect(fcm.send).toHaveBeenCalledTimes(1);
  });

  it('tells a retryable failure (the rail down) from a final one (a malformed token)', async () => {
    fcm.send
      .mockResolvedValueOnce({ ok: false, error: 'UNAVAILABLE', status: 503, detail: 'try later' })
      .mockResolvedValueOnce({ ok: false, error: 'INVALID_TOKEN', status: 400, detail: 'bad' })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const outcome = await sendToDevices(
      [device(), device({ id: 'dev-2', token: 'second-token-0123456789-zzzzzz' }), device({ id: 'dev-3', token: 'third-token-0123456789-yyyyyy' })],
      { data: { type: 'X' } },
    );
    expect(outcome).toMatchObject({ retryable: 2, failed: 1, sent: 0 });
    expect(pushRepo.removeByToken).not.toHaveBeenCalled();
  });

  it('is NO_DEVICE with nothing to send to', async () => {
    expect(await sendToDevices([], { data: { type: 'X' } })).toMatchObject({ devices: 0, skipped: 'NO_DEVICE' });
    expect(fcm.send).not.toHaveBeenCalled();
  });
});

describe('broadcastFlagsChanged', () => {
  it('walks every device in batches with a silent FLAGS_CHANGED data push', async () => {
    const many = Array.from({ length: 500 }, (_, i) => device({ id: `dev-${String(i).padStart(4, '0')}`, token: `token-${String(i).padStart(30, '0')}` }));
    pushRepo.listAll.mockResolvedValueOnce(many).mockResolvedValueOnce([device({ id: 'dev-9999', token: 'last-token-0123456789-qqqqqq' })]);
    fcm.send.mockResolvedValue({ ok: true, messageId: 'm' });

    const tally = await broadcastFlagsChanged({ key: 'marketplace.instant-booking', changeId: 'chg-1' });

    expect(tally).toMatchObject({ devices: 501, sent: 501, skipped: null });
    expect(pushRepo.listAll).toHaveBeenNthCalledWith(1, null, 500);
    expect(pushRepo.listAll).toHaveBeenNthCalledWith(2, 'dev-0499', 500);
    const [, message] = fcm.send.mock.calls[0]!;
    expect(message.notification).toBeUndefined();
    expect(message.contentAvailable).toBe(true);
    expect(message.data).toMatchObject({ type: 'FLAGS_CHANGED', key: 'marketplace.instant-booking', changeId: 'chg-1' });
  });

  it('counts the fleet and skips when Firebase is not configured', async () => {
    fcm.isConfigured.mockReturnValue(false);
    pushRepo.countAll.mockResolvedValue(42);
    const tally = await broadcastFlagsChanged({ key: 'x.y' });
    expect(tally).toMatchObject({ devices: 42, sent: 0, skipped: 'FCM_NOT_CONFIGURED' });
    expect(pushRepo.listAll).not.toHaveBeenCalled();
  });
});

/* ── the dispatcher's PUSH delivery ──────────────────────────────── */

describe('attemptPushDelivery', () => {
  it('renders the title from subject and the body from smsBody, sends, records the attempt and marks SENT', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: true, messageId: 'projects/p/messages/7' });

    const after = await attemptPushDelivery(delivery() as never, template() as never, 1, new Date('2026-09-14T10:00:00Z'));

    expect(after).toMatchObject({ status: 'SENT', attempts: 1, provider: 'fcm', providerMessageId: 'projects/p/messages/7' });
    const [token, message] = fcm.send.mock.calls[0]!;
    expect(token).toBe(device().token);
    expect(message.notification).toEqual({ title: 'Your ADX data export is ready', body: 'Ready until 21 Sep 2026.' });
    expect(message.data).toMatchObject({ type: 'DATA_EXPORT_READY', deliveryId: 'dlv-push-1' });
    expect(comms.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'dlv-push-1', attempt: 1, ok: true, provider: 'fcm', providerMessageId: 'projects/p/messages/7' }));
  });

  it('G10: renders pushTitle / pushBody when the template carries them, over subject / smsBody', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: true, messageId: 'm' });

    await attemptPushDelivery(
      delivery() as never,
      template({ pushTitle: 'Export ready', pushBody: 'Tap to download before {{expiresAt}}' }) as never,
      1,
      new Date(),
    );

    const [, message] = fcm.send.mock.calls[0]!;
    expect(message.notification).toEqual({ title: 'Export ready', body: 'Tap to download before 21 Sep 2026' });
  });

  it('G10: a blank pushTitle or pushBody falls back to subject / smsBody, then to the in-app row', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: true, messageId: 'm' });

    await attemptPushDelivery(delivery() as never, template({ pushTitle: '  ', pushBody: 'Only the body' }) as never, 1, new Date());
    expect(fcm.send.mock.calls[0]![1].notification).toEqual({ title: 'Your ADX data export is ready', body: 'Only the body' });
  });

  it('falls back to the in-app row’s copy and carries what it relates to', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: true, messageId: 'm' });
    notifRepo.findById.mockResolvedValue({ id: 'ntf-1', userId: 'usr-1', type: 'ORDER', title: 'Booking accepted', subtitle: null, message: 'Your spot was booked', relatedType: 'ORDER', relatedId: 'ord-1' });

    await attemptPushDelivery(delivery({ notificationId: 'ntf-1' }) as never, template({ subject: null, smsBody: null }) as never, 1, new Date());

    const [, message] = fcm.send.mock.calls[0]!;
    expect(message.notification).toEqual({ title: 'Booking accepted', body: 'Your spot was booked' });
    expect(message.data).toMatchObject({ notificationId: 'ntf-1', notificationType: 'ORDER', relatedType: 'ORDER', relatedId: 'ord-1' });
  });

  it('is SKIPPED with no device and SKIPPED when Firebase is off', async () => {
    pushRepo.listForUser.mockResolvedValueOnce([]);
    expect(await attemptPushDelivery(delivery() as never, template() as never, 1, new Date())).toMatchObject({ status: 'SKIPPED', lastError: 'NO_DEVICE' });

    pushRepo.listForUser.mockResolvedValueOnce([device()]);
    fcm.send.mockResolvedValue({ skipped: true, reason: 'FCM_NOT_CONFIGURED' });
    expect(await attemptPushDelivery(delivery() as never, template() as never, 1, new Date())).toMatchObject({ status: 'SKIPPED', lastError: 'FCM_NOT_CONFIGURED' });
  });

  it('retries a rail outage until the third attempt, then fails', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: false, error: 'UNAVAILABLE', status: 503, detail: 'later' });

    expect(await attemptPushDelivery(delivery() as never, template() as never, 1, new Date())).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(await attemptPushDelivery(delivery({ attempts: 2 }) as never, template() as never, 3, new Date())).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(comms.recordAttempt).toHaveBeenCalledTimes(2);
    expect(comms.recordAttempt.mock.calls[1]![0]).toMatchObject({ attempt: 3, ok: false, error: expect.stringContaining('FCM_UNAVAILABLE') });
  });

  it('fails at once when every token is stale — there is nothing to retry to', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    fcm.send.mockResolvedValue({ ok: false, error: 'UNREGISTERED', status: 404, detail: 'gone' });
    expect(await attemptPushDelivery(delivery() as never, template() as never, 1, new Date())).toMatchObject({ status: 'FAILED', lastError: 'NO_VALID_DEVICE' });
    expect(pushRepo.removeByToken).toHaveBeenCalledWith(device().token);
  });
});

describe('notify() with a PUSH template', () => {
  beforeEach(() => {
    comms.findActiveTemplate.mockResolvedValue(template({ channels: ['PUSH'] }));
    comms.findRecipient.mockResolvedValue({ id: 'usr-1', email: null, mobile: '+919845012210', emailUnsubscribedAt: null, isActive: true, closedAt: null });
    notifRepo.findPreferences.mockResolvedValue([]);
    comms.createDelivery.mockImplementation(async (data: Record<string, unknown>) => delivery({ id: 'dlv-new', ...data }));
  });

  it('writes one delivery masked as the device count, hashed on the user, with no address stashed', async () => {
    pushRepo.listForUser.mockResolvedValue([device(), device({ id: 'dev-2', token: 'second-token-0123456789-zzzzzz' })]);
    const result = await notify('DATA_EXPORT_READY', 'usr-1', { url: 'adx://x', expiresAt: 'soon', name: 'Asha' });
    expect(result.deliveries).toEqual([{ channel: 'PUSH', deliveryId: 'dlv-new' }]);
    expect(comms.createDelivery).toHaveBeenCalledWith(expect.objectContaining({ channel: 'PUSH', recipientMasked: maskDevices(2), userId: 'usr-1' }));
    const row = comms.createDelivery.mock.calls[0]![0];
    expect(row.recipientHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('fcm-token');
  });

  it('is NO_DEVICE — no row — when the person has no phone registered', async () => {
    pushRepo.listForUser.mockResolvedValue([]);
    const result = await notify('DATA_EXPORT_READY', 'usr-1', { url: 'adx://x', expiresAt: 'soon', name: 'Asha' });
    expect(result.deliveries).toEqual([{ channel: 'PUSH', deliveryId: null, skipped: 'NO_DEVICE' }]);
    expect(comms.createDelivery).not.toHaveBeenCalled();
  });

  it('honours the PUSH preference row', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    notifRepo.findPreferences.mockResolvedValue([{ type: 'SYSTEM', channel: 'PUSH', enabled: false }]);
    const result = await notify('DATA_EXPORT_READY', 'usr-1', { url: 'adx://x', expiresAt: 'soon', name: 'Asha' });
    expect(result.deliveries).toEqual([{ channel: 'PUSH', deliveryId: null, skipped: 'PREFERENCE_OFF' }]);
  });
});

/* ── the routes ──────────────────────────────────────────────────── */

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/users', deviceRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

describe('/users/me/devices', () => {
  const me = tokenFor(['PUBLISHER'], 'usr-1');
  const body = { token: device().token, app: 'USER', platform: 'ANDROID', appVersion: '1.4.0' };

  it('PUT answers 201 for a new device and 200 for a refresh, never echoing the token', async () => {
    pushRepo.register.mockResolvedValueOnce({ row: device(), created: true, movedFromUserId: null });
    const created = await request(app()).put('/api/v1/users/me/devices').set('Authorization', `Bearer ${me}`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: 'dev-1', tokenSuffix: 'ABCDEF', moved: false });
    expect(JSON.stringify(created.body)).not.toContain(device().token);

    pushRepo.register.mockResolvedValueOnce({ row: device(), created: false, movedFromUserId: null });
    const refreshed = await request(app()).put('/api/v1/users/me/devices').set('Authorization', `Bearer ${me}`).send(body);
    expect(refreshed.status).toBe(200);
    expect(pushRepo.register).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'usr-1', token: body.token, app: 'USER', platform: 'ANDROID' }), expect.any(Date));
  });

  it('PUT validates the body', async () => {
    const res = await request(app()).put('/api/v1/users/me/devices').set('Authorization', `Bearer ${me}`).send({ token: 'short', app: 'WEB', platform: 'ANDROID' });
    expect(res.status).toBe(400);
    expect(pushRepo.register).not.toHaveBeenCalled();
  });

  it('GET lists the caller’s devices with suffixes only', async () => {
    pushRepo.listForUser.mockResolvedValue([device()]);
    const res = await request(app()).get('/api/v1/users/me/devices').set('Authorization', `Bearer ${me}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: 'dev-1', tokenSuffix: 'ABCDEF', platform: 'ANDROID' })]);
    expect(JSON.stringify(res.body)).not.toContain(device().token);
    expect(toDeviceView(device())).not.toHaveProperty('token');
  });

  it('DELETE removes the caller’s own token and 404s another’s', async () => {
    pushRepo.remove.mockResolvedValueOnce(true);
    const ok = await request(app()).delete(`/api/v1/users/me/devices/${device().token}`).set('Authorization', `Bearer ${me}`);
    expect(ok.status).toBe(200);
    pushRepo.remove.mockResolvedValueOnce(false);
    const gone = await request(app()).delete(`/api/v1/users/me/devices/${device().token}`).set('Authorization', `Bearer ${me}`);
    expect(gone.status).toBe(404);
  });

  it('refuses without a token', async () => {
    const res = await request(app()).get('/api/v1/users/me/devices');
    expect(res.status).toBe(401);
  });
});
