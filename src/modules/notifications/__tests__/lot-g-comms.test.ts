import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommsRepository } from '../comms.repository';

/**
 * Lot G — Q117 (quiet hours, the weekly cap, the test send, the
 * transactional flag) and Q121 (one DeliveryAttempt row per try).
 *
 * What is pinned: a non-transactional message raised inside the quiet hours
 * is a QUEUED row with `scheduledFor` at the window's end (G10: the column,
 * not a marker in `lastError`), which the sender's pick leaves alone until
 * the instant has passed; a row written before the column, still carrying
 * the `QUIET_HOURS until` marker, is folded onto the column once and then
 * treated the same; the sixth non-transactional row in a person's
 * Indian week is born SKIPPED with reason WEEKLY_CAP; a transactional
 * template ignores both; every attempt writes its own row with the rail's
 * answer masked; the test send goes to the operator's own addresses and
 * never to one the body names.
 */

const { comms, notifRepo, redis, email, sms, integrations, appConfig } = vi.hoisted(() => ({
  comms: {
    ensureTemplates: vi.fn(),
    findActiveTemplate: vi.fn(),
    findTemplateByKey: vi.fn(),
    listTemplates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    sensitiveTemplateKeys: vi.fn(),
    allTemplates: vi.fn(),
    templateStats: vi.fn(),
    findRecipient: vi.fn(),
    markEmailUnsubscribed: vi.fn(),
    createDelivery: vi.fn(),
    findDelivery: vi.fn(),
    listDeliveries: vi.fn(),
    findDeliveryRows: vi.fn(),
    findQueued: vi.fn(),
    updateDelivery: vi.fn(),
    findByProviderMessageId: vi.fn(),
    purgeVariables: vi.fn(),
    deleteCreatedBefore: vi.fn(),
    nonTransactionalTemplateKeys: vi.fn(),
    ensureTransactionalFlags: vi.fn(),
    findLegacyDeferred: vi.fn(),
    countDeliveriesInWindow: vi.fn(),
    recordAttempt: vi.fn(),
    findAttempts: vi.fn(),
  } satisfies Record<keyof CommsRepository, ReturnType<typeof vi.fn>>,
  notifRepo: {
    findManyForUser: vi.fn(),
    countUnread: vi.fn(),
    findById: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    create: vi.fn(),
    findPreferences: vi.fn(),
    upsertPreference: vi.fn(),
  },
  redis: { redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() } },
  email: { sendEmail: vi.fn() },
  sms: { sendSms: vi.fn() },
  integrations: { getEffectiveEmailConfig: vi.fn(), getEffectiveResendConfig: vi.fn() },
  appConfig: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-comms.repository', () => ({ prismaCommsRepository: comms }));
vi.mock('../prisma-notifications.repository', () => ({ prismaNotificationRepository: notifRepo }));
vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/email', () => email);
vi.mock('../../../shared/integrations', () => integrations);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../../shared/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/sms')>();
  return { ...actual, ...sms };
});

import type { NotificationDelivery } from '../../../shared/database';
import { ApiError } from '../../../shared/errors';
import { DEFERRAL_MARKER, quietHoursDeferral, readDeferral, sampleVariablesFor, weekWindowIST } from '../comms-rules';
import { attemptDelivery, ensureTemplates, foldLegacyDeferrals, getDelivery, notify, sendQueuedDeliveries, sendTestTemplate } from '../dispatch.service';
import { hashRecipient } from '../recipient';
import { DEFAULT_TEMPLATES } from '../templates';

/* IST is UTC+5:30. 22:30 IST on the 14th is 17:00Z; 10:00 IST is 04:30Z. */
const NIGHT = new Date('2026-09-14T17:00:00.000Z');
const DAY = new Date('2026-09-14T04:30:00.000Z');
const QUIET = { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' };

const settings = (over: Partial<{ quietHours: typeof QUIET; weeklyCapPerUser: number }> = {}) => ({
  comms: { quietHours: QUIET, weeklyCapPerUser: 5, ...over },
});

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  key: 'announcement',
  event: 'ANNOUNCEMENT',
  channels: ['EMAIL', 'SMS'],
  subject: '{{title}}',
  emailBody: '<h2>{{title}}</h2><p>{{body}}</p>',
  smsKind: 'ANNOUNCEMENT_CRITICAL',
  smsBody: 'ADX notice: {{title}}. {{body}}',
  isSensitive: false,
  transactional: false,
  status: 'ACTIVE',
  version: 1,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'usr-1',
  email: 'asha.rao@adx.co',
  mobile: '+919845012210',
  emailUnsubscribedAt: null,
  isActive: true,
  closedAt: null,
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'dlv-1',
  userId: 'usr-1',
  notificationId: null,
  templateKey: 'announcement',
  channel: 'EMAIL',
  recipientMasked: 'a***@adx.co',
  recipientHash: hashRecipient('EMAIL', 'asha.rao@adx.co'),
  variables: { title: 'Hello', body: 'World' },
  status: 'QUEUED',
  attempts: 0,
  provider: null,
  providerMessageId: null,
  lastError: null,
  sentAt: null,
  deliveredAt: null,
  purgedAt: null,
  scheduledFor: null,
  createdAt: new Date(),
  ...over,
});

let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  appConfig.getPlatformSettings.mockResolvedValue(settings());
  comms.findActiveTemplate.mockResolvedValue(template());
  comms.findTemplateByKey.mockResolvedValue(template());
  comms.findRecipient.mockResolvedValue(recipient());
  comms.nonTransactionalTemplateKeys.mockResolvedValue(['announcement', 'statement-ready']);
  comms.countDeliveriesInWindow.mockResolvedValue(0);
  comms.createDelivery.mockImplementation(async (data: Record<string, unknown>) => delivery({ ...data, id: `dlv-${++seq}` }));
  comms.updateDelivery.mockImplementation(async (id: string, patch: Record<string, unknown>) => delivery({ id, ...patch }));
  comms.findDelivery.mockResolvedValue(delivery());
  comms.findLegacyDeferred.mockResolvedValue([]);
  comms.findQueued.mockResolvedValue([]);
  comms.recordAttempt.mockResolvedValue({});
  comms.findAttempts.mockResolvedValue([]);
  comms.sensitiveTemplateKeys.mockResolvedValue([]);
  comms.ensureTemplates.mockResolvedValue(0);
  comms.ensureTransactionalFlags.mockResolvedValue(0);
  notifRepo.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'ntf-1', ...data }));
  notifRepo.findPreferences.mockResolvedValue([]);
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.get.mockResolvedValue(null);
  redis.redis.del.mockResolvedValue(1);
  integrations.getEffectiveEmailConfig.mockResolvedValue({ primary: 'SMTP', host: 'smtp.local' });
  integrations.getEffectiveResendConfig.mockResolvedValue({ apiKey: 'rs_key' });
  // AE-B: the one door's answer, as SMTP gives it.
  email.sendEmail.mockResolvedValue({ provider: 'SMTP', configured: true, messageId: '<abc@smtp.local>', response: '250 2.0.0 OK queued as ABC for <asha.rao@adx.co>', previewUrl: null });
  sms.sendSms.mockResolvedValue({ skipped: false, rail: 'msg91', providerMessageId: 'req-1', responseText: '{"type":"success","message":"req-1"}' });
});

/* ── the pure rules ──────────────────────────────────────────────── */

describe('quiet hours', () => {
  it('holds a message raised at night until the window ends, to the minute, in the zone', () => {
    // 22:30 IST → 08:00 IST next morning = 02:30Z on the 15th.
    expect(quietHoursDeferral(NIGHT, QUIET)?.toISOString()).toBe('2026-09-15T02:30:00.000Z');
    // 06:15:42 IST (00:45:42Z) → 08:00 IST the same morning, seconds dropped.
    expect(quietHoursDeferral(new Date('2026-09-15T00:45:42.000Z'), QUIET)?.toISOString()).toBe('2026-09-15T02:30:00.000Z');
  });

  it('lets a daytime message go, treats the edges as [from, to), and knows a window that does not cross midnight', () => {
    expect(quietHoursDeferral(DAY, QUIET)).toBeNull();
    // 21:00 IST exactly is inside; 08:00 IST exactly is outside.
    expect(quietHoursDeferral(new Date('2026-09-14T15:30:00.000Z'), QUIET)).not.toBeNull();
    expect(quietHoursDeferral(new Date('2026-09-15T02:30:00.000Z'), QUIET)).toBeNull();
    const afternoon = { from: '13:00', to: '15:00', tz: 'Asia/Kolkata' };
    expect(quietHoursDeferral(new Date('2026-09-14T08:30:00.000Z'), afternoon)?.toISOString()).toBe('2026-09-14T09:30:00.000Z'); // 14:00 IST → 15:00 IST
    expect(quietHoursDeferral(NIGHT, afternoon)).toBeNull();
    expect(quietHoursDeferral(NIGHT, { from: '21:00', to: '21:00', tz: 'Asia/Kolkata' })).toBeNull();
  });

  it('falls back to IST for a zone the runtime does not know', () => {
    expect(quietHoursDeferral(NIGHT, { ...QUIET, tz: 'Not/AZone' })?.toISOString()).toBe('2026-09-15T02:30:00.000Z');
  });
});

describe('the Indian week', () => {
  it('runs Monday 00:00 IST to the next Monday, Sunday belonging to the week before it', () => {
    // 14 Sep 2026 is a Monday.
    expect(weekWindowIST(NIGHT)).toEqual({ start: new Date('2026-09-13T18:30:00.000Z'), end: new Date('2026-09-20T18:30:00.000Z') });
    // Sunday 20 Sep, 23:00 IST (17:30Z) is still that week.
    expect(weekWindowIST(new Date('2026-09-20T17:30:00.000Z')).start.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    // Monday 21 Sep, 00:30 IST (Sunday 19:00Z) is the next.
    expect(weekWindowIST(new Date('2026-09-20T19:00:00.000Z')).start.toISOString()).toBe('2026-09-20T18:30:00.000Z');
  });
});

describe('the legacy deferral marker (one release)', () => {
  it('still reads the instant off a row written before the column, and nothing else', () => {
    expect(readDeferral(`${DEFERRAL_MARKER}2026-09-15T02:30:00.000Z`)).toEqual(new Date('2026-09-15T02:30:00.000Z'));
    expect(readDeferral(`${DEFERRAL_MARKER}garbage`)).toBeNull();
    expect(readDeferral('SMTP down')).toBeNull();
    expect(readDeferral(null)).toBeNull();
  });
});

/* ── notify under the rules ──────────────────────────────────────── */

describe('notify under the comms rules (Q117)', () => {
  it('defers a non-transactional message inside the quiet hours: QUEUED with scheduledFor on the row, no marker', async () => {
    const result = await notify('ANNOUNCEMENT', 'usr-1', { title: 'Hello', body: 'World' }, { type: 'ANNOUNCEMENT' }, NIGHT);
    const until = new Date('2026-09-15T02:30:00.000Z');
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: 'dlv-1', scheduledFor: until },
      { channel: 'SMS', deliveryId: 'dlv-2', scheduledFor: until },
    ]);
    for (const call of comms.createDelivery.mock.calls) {
      expect(call[0]).toMatchObject({ scheduledFor: until });
      expect((call[0] as Record<string, unknown>)['status']).toBeUndefined();
      expect((call[0] as Record<string, unknown>)['lastError']).toBeUndefined();
    }
    // The address is still stashed for the sender's morning.
    expect(redis.redis.set).toHaveBeenCalledWith('comms:addr:dlv-1', 'asha.rao@adx.co', 'EX', 48 * 3600);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('lets a transactional template through at night and never reads the cap', async () => {
    comms.findActiveTemplate.mockResolvedValue(template({ key: 'payout-paid', event: 'PAYOUT_PAID', transactional: true }));
    notifRepo.findPreferences.mockResolvedValue([{ type: 'PAYOUT', channel: 'SMS', enabled: true }]);
    const result = await notify('PAYOUT_PAID', 'usr-1', { amount: '10' }, { type: 'PAYOUT' }, NIGHT);
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: 'dlv-1' },
      { channel: 'SMS', deliveryId: 'dlv-2' },
    ]);
    expect(comms.countDeliveriesInWindow).not.toHaveBeenCalled();
    expect(comms.nonTransactionalTemplateKeys).not.toHaveBeenCalled();
    expect(comms.createDelivery.mock.calls.every((c) => (c[0] as Record<string, unknown>)['scheduledFor'] === undefined)).toBe(true);
  });

  it('skips the row beyond the weekly cap as SKIPPED / WEEKLY_CAP, counted per person over the Indian week', async () => {
    comms.countDeliveriesInWindow.mockResolvedValue(5);
    const result = await notify('ANNOUNCEMENT', 'usr-1', { title: 'Hello', body: 'World' }, { type: 'ANNOUNCEMENT', channels: ['EMAIL'] }, DAY);
    expect(result.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-1', skipped: 'WEEKLY_CAP' }]);
    expect(comms.countDeliveriesInWindow).toHaveBeenCalledWith(
      { userId: 'usr-1' },
      new Date('2026-09-13T18:30:00.000Z'),
      new Date('2026-09-20T18:30:00.000Z'),
      ['announcement', 'statement-ready'],
    );
    expect(comms.createDelivery).toHaveBeenCalledWith(expect.objectContaining({ status: 'SKIPPED', lastError: 'WEEKLY_CAP' }));
    expect(redis.redis.set).not.toHaveBeenCalled();
  });

  it('spends the cap across the channels of one call: the fifth row goes, the sixth is withheld', async () => {
    comms.countDeliveriesInWindow.mockResolvedValue(4);
    const result = await notify('ANNOUNCEMENT', 'usr-1', { title: 'Hello', body: 'World' }, { type: 'ANNOUNCEMENT' }, DAY);
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: 'dlv-1' },
      { channel: 'SMS', deliveryId: 'dlv-2', skipped: 'WEEKLY_CAP' },
    ]);
    expect(comms.countDeliveriesInWindow).toHaveBeenCalledTimes(1);
  });

  it('counts a recipient with no login by the address hash, and honours a raised cap', async () => {
    appConfig.getPlatformSettings.mockResolvedValue(settings({ weeklyCapPerUser: 10 }));
    comms.countDeliveriesInWindow.mockResolvedValue(9);
    const result = await notify('ANNOUNCEMENT', null, { title: 'x', body: 'y' }, { recipient: { email: 'buyer@x.com' }, channels: ['EMAIL'] }, DAY);
    expect(result.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-1' }]);
    expect(comms.countDeliveriesInWindow).toHaveBeenCalledWith(
      { recipientHash: hashRecipient('EMAIL', 'buyer@x.com') },
      expect.any(Date),
      expect.any(Date),
      ['announcement', 'statement-ready'],
    );
  });

  it('applies the cap before the quiet hours: a capped row at night is SKIPPED, not deferred', async () => {
    comms.countDeliveriesInWindow.mockResolvedValue(5);
    const result = await notify('ANNOUNCEMENT', 'usr-1', {}, { type: 'ANNOUNCEMENT', channels: ['EMAIL'] }, NIGHT);
    expect(result.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-1', skipped: 'WEEKLY_CAP' }]);
  });
});

/* ── the sender's pick and the legacy fold ───────────────────────── */

describe('the sender under the deferral', () => {
  it('asks the repository for the rows due at the tick — the column decides, there is no release step', async () => {
    const now = new Date('2026-09-15T02:31:00.000Z');
    const tally = await sendQueuedDeliveries(10, now);
    expect(tally).toEqual({ picked: 0, sent: 0, failed: 0, skipped: 0, retry: 0, folded: 0 });
    expect(comms.findQueued).toHaveBeenCalledWith(10, now);
  });

  it('folds a row written before the column — the marker becomes scheduledFor, once — ahead of the pick', async () => {
    const morning = new Date('2026-09-15T02:30:00.000Z');
    comms.findLegacyDeferred.mockResolvedValue([
      delivery({ id: 'dlv-a', lastError: `${DEFERRAL_MARKER}${morning.toISOString()}` }),
      delivery({ id: 'dlv-c', lastError: `${DEFERRAL_MARKER}garbage` }),
    ]);
    const now = new Date('2026-09-15T02:31:00.000Z');
    await expect(foldLegacyDeferrals(now)).resolves.toBe(2);
    expect(comms.updateDelivery).toHaveBeenCalledWith('dlv-a', { scheduledFor: morning, lastError: null });
    // A marker that does not parse is released now rather than stuck forever.
    expect(comms.updateDelivery).toHaveBeenCalledWith('dlv-c', { scheduledFor: now, lastError: null });

    comms.updateDelivery.mockClear();
    const tally = await sendQueuedDeliveries(10, now);
    expect(tally.folded).toBe(2);
    const last = (order: number[]) => order[order.length - 1]!;
    expect(last(comms.findLegacyDeferred.mock.invocationCallOrder)).toBeLessThan(last(comms.findQueued.mock.invocationCallOrder));
  });
});

/* ── attempt rows (Q121) ─────────────────────────────────────────── */

describe('attempt rows (Q121)', () => {
  it('writes one row per successful email try with the provider, its message id and the response, addresses masked', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    const after = await attemptDelivery('dlv-1');
    expect(after).toMatchObject({ status: 'SENT', provider: 'smtp', providerMessageId: '<abc@smtp.local>', attempts: 1 });
    expect(comms.recordAttempt).toHaveBeenCalledTimes(1);
    expect(comms.recordAttempt).toHaveBeenCalledWith({
      deliveryId: 'dlv-1',
      attempt: 1,
      provider: 'smtp',
      providerMessageId: '<abc@smtp.local>',
      ok: true,
      responseText: '250 2.0.0 OK queued as ABC for <a***@adx.co>',
      error: null,
    });
  });

  it('AE-B: an Ethereal send carries the preview URL in the response text so the Delivery log shows it', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    email.sendEmail.mockResolvedValue({
      provider: 'ETHEREAL',
      configured: true,
      messageId: '<eth@adx>',
      response: '250 Accepted [STATUS=new MSGID=abc]',
      previewUrl: 'https://ethereal.email/message/abc',
    });
    const after = await attemptDelivery('dlv-1');
    expect(after).toMatchObject({ status: 'SENT', provider: 'ethereal', providerMessageId: '<eth@adx>' });
    expect(comms.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ethereal', ok: true, responseText: '250 Accepted [STATUS=new MSGID=abc] | preview: https://ethereal.email/message/abc' }),
    );
  });

  it('writes the SMS rail answer and, on a throw, the error with the number masked', async () => {
    comms.findDelivery.mockResolvedValue(delivery({ channel: 'SMS', recipientHash: hashRecipient('SMS', '+919845012210'), attempts: 1 }));
    redis.redis.get.mockResolvedValue('+919845012210');
    await attemptDelivery('dlv-1');
    expect(comms.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, provider: 'msg91', providerMessageId: 'req-1', ok: true, responseText: '{"type":"success","message":"req-1"}' }),
    );

    sms.sendSms.mockRejectedValue(new Error('MSG91 rejected +919845012210: DND'));
    const after = await attemptDelivery('dlv-1');
    expect(after).toMatchObject({ status: 'QUEUED', attempts: 2 });
    expect(comms.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, ok: false, provider: null, error: 'MSG91 rejected +91 98450 •••10: DND' }),
    );
  });

  it('records a try that never reached a rail — a missing template, a lost address, an unconfigured door', async () => {
    comms.findTemplateByKey.mockResolvedValueOnce(null);
    await attemptDelivery('dlv-1');
    expect(comms.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1, ok: false, error: 'TEMPLATE_MISSING' }));

    comms.findRecipient.mockResolvedValueOnce(recipient({ email: 'someone.else@adx.co' }));
    await attemptDelivery('dlv-1');
    expect(comms.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: 'RECIPIENT_UNAVAILABLE' }));

    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    email.sendEmail.mockResolvedValue({ provider: 'SMTP', configured: false, messageId: null, response: null, previewUrl: null });
    const after = await attemptDelivery('dlv-1');
    expect(after).toMatchObject({ status: 'SKIPPED', lastError: 'EMAIL_UNCONFIGURED' });
    expect(comms.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, provider: 'smtp', error: 'EMAIL_UNCONFIGURED' }));
  });

  it('never lets a failed attempt row change the delivery outcome', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    comms.recordAttempt.mockRejectedValue(new Error('unique violation'));
    const after = await attemptDelivery('dlv-1');
    expect(after).toMatchObject({ status: 'SENT' });
  });

  it('answers the desk read with attemptRows oldest first and scheduledFor as the row carries it', async () => {
    const until = new Date('2026-09-15T02:30:00.000Z');
    comms.findDelivery.mockResolvedValue(delivery({ scheduledFor: until }));
    comms.findAttempts.mockResolvedValue([{ id: 'att-1', deliveryId: 'dlv-1', attempt: 1, ok: false, error: 'SMTP down' }]);
    const row = await getDelivery('dlv-1');
    expect(row.scheduledFor).toEqual(until);
    expect(row.attemptRows).toEqual([{ id: 'att-1', deliveryId: 'dlv-1', attempt: 1, ok: false, error: 'SMTP down' }]);
    expect(comms.findAttempts).toHaveBeenCalledWith('dlv-1');
  });
});

/* ── the test send ───────────────────────────────────────────────── */

describe('the test send (Q117)', () => {
  it('renders sample variables and sends to the operator’s own email and mobile, attempted in the request', async () => {
    comms.findRecipient.mockResolvedValue(recipient({ id: 'adm-1', email: 'ops@adx.co', mobile: '+919900011122' }));
    comms.findDelivery.mockImplementation(async (id: string) =>
      delivery({
        id,
        userId: 'adm-1',
        channel: id === 'dlv-2' ? 'SMS' : 'EMAIL',
        recipientHash: id === 'dlv-2' ? hashRecipient('SMS', '+919900011122') : hashRecipient('EMAIL', 'ops@adx.co'),
        variables: sampleVariablesFor(['title', 'body']),
      }),
    );
    redis.redis.get.mockImplementation(async (key: string) => (key.endsWith('dlv-2') ? '+919900011122' : 'ops@adx.co'));

    const result = await sendTestTemplate('announcement', 'adm-1');
    expect(result.templateKey).toBe('announcement');
    expect(result.variables).toEqual({ title: 'Test announcement', body: 'This is a test of the announcement template.' });
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: 'dlv-1', status: 'SENT' },
      { channel: 'SMS', deliveryId: 'dlv-2', status: 'SENT' },
    ]);
    expect(comms.findRecipient).toHaveBeenCalledWith('adm-1');
    expect(email.sendEmail).toHaveBeenCalledWith('ops@adx.co', 'Test announcement', '<h2>Test announcement</h2><p>This is a test of the announcement template.</p>');
    expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: '+919900011122', kind: 'ANNOUNCEMENT_CRITICAL' }));
    // Not governed by the cap or the quiet hours, whatever the template says.
    expect(comms.countDeliveriesInWindow).not.toHaveBeenCalled();
    expect(comms.createDelivery.mock.calls.every((c) => (c[0] as Record<string, unknown>)['userId'] === 'adm-1')).toBe(true);
  });

  it('narrows to the channels asked for, tests a DRAFT, and refuses when the operator has no address', async () => {
    comms.findTemplateByKey.mockResolvedValue(template({ status: 'DRAFT' }));
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    const result = await sendTestTemplate('announcement', 'usr-1', ['EMAIL']);
    expect(result.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-1', status: 'SENT' }]);
    expect(sms.sendSms).not.toHaveBeenCalled();

    comms.findRecipient.mockResolvedValue(recipient({ email: null, mobile: '' }));
    await expect(sendTestTemplate('announcement', 'usr-1')).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<ApiError>);
    comms.findTemplateByKey.mockResolvedValue(null);
    await expect(sendTestTemplate('missing', 'usr-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('fills an unknown placeholder with its own name in brackets', () => {
    expect(sampleVariablesFor(['code', 'whatever'])).toEqual({ code: '482913', whatever: '[whatever]' });
  });
});

/* ── the transactional flag ──────────────────────────────────────── */

describe('the transactional flag', () => {
  it('seeds the announcement and the statement as non-transactional and everything else as transactional', () => {
    const nonTransactional = DEFAULT_TEMPLATES.filter((seed) => seed.transactional === false).map((seed) => seed.key);
    expect(nonTransactional.sort()).toEqual(['announcement', 'statement-ready']);
    for (const key of ['login-otp', 'two-factor-sms', 'two-factor-email', 'package-link', 'kyc-decision', 'payout-paid']) {
      expect(DEFAULT_TEMPLATES.find((seed) => seed.key === key)?.transactional).not.toBe(false);
    }
  });

  it('marks the unedited seeded rows at boot, never overwriting the rest', async () => {
    await ensureTemplates();
    expect(comms.ensureTransactionalFlags).toHaveBeenCalledWith([
      { key: 'statement-ready', transactional: false },
      { key: 'announcement', transactional: false },
    ]);
  });
});
