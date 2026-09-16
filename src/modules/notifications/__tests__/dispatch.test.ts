import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommsRepository } from '../comms.repository';

/**
 * The dispatcher — Lot E (Q87/Q147).
 *
 * What is pinned: `notify` writes the in-app row and one delivery per
 * outbound channel the ACTIVE template names, masked and hashed, holding the
 * variables and never the rendered text; a preference off, no address, an
 * unsubscribed announcement or an unregistered SMS kind is a skip, not a
 * row; the sender renders and sends, retries to three and then fails; a
 * sensitive template is never resent from the log; the purge nulls
 * variables at 90 days (7 for sensitive) and drops rows at 180.
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
    // Lot G (Q117/Q121)
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
  appConfig: {
    getPlatformSettings: vi.fn(async () => ({
      comms: { quietHours: { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' }, weeklyCapPerUser: 5 },
    })),
  },
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

import {
  attemptDelivery,
  DELIVERY_CSV_COLUMNS,
  deliveryCsvHeader,
  deliveryCsvLine,
  deliveryFilterFrom,
  eventCatalogue,
  getDelivery,
  iterateDeliveryRows,
  listDeliveries,
  notify,
  purgeDeliveries,
  readUnsubscribeToken,
  recordDeliveryReports,
  resendDelivery,
  sendQueuedDeliveries,
  templateStats,
  templateStatsSince,
  unsubscribe,
  unsubscribeToken,
  updateTemplate,
} from '../dispatch.service';
import { createHash, createHmac } from 'crypto';
import { env } from '../../../config/env';
import { hashRecipient, maskAddressesIn, maskEmail, maskMobile } from '../recipient';
import { DEFAULT_TEMPLATES, renderHtml, variablesOf } from '../templates';

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  key: 'package-link',
  event: 'PACKAGE_LINK',
  channels: ['EMAIL', 'SMS'],
  subject: 'Your ADX {{packageName}} plan',
  emailBody: '<p>Hello {{name}}, <a href="{{url}}">pay</a></p>',
  smsKind: 'PACKAGE_LINK',
  smsBody: 'ADX: {{packageName}} — {{url}}',
  isSensitive: false,
  transactional: true,
  status: 'ACTIVE',
  version: 1,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'usr-1',
  email: 'Asha.Rao@adx.co',
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
  templateKey: 'package-link',
  channel: 'EMAIL',
  recipientMasked: 'a***@adx.co',
  recipientHash: hashRecipient('EMAIL', 'asha.rao@adx.co'),
  variables: { name: 'Asha', packageName: 'Growth', url: 'https://adx.local/p/t?x=1&y=2' },
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

let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  comms.findActiveTemplate.mockResolvedValue(template());
  comms.findTemplateByKey.mockResolvedValue(template());
  comms.findRecipient.mockResolvedValue(recipient());
  comms.createDelivery.mockImplementation(async (data: Record<string, unknown>) => delivery({ ...data, id: `dlv-${++seq}` }));
  comms.updateDelivery.mockImplementation(async (id: string, patch: Record<string, unknown>) => delivery({ id, ...patch }));
  comms.findDelivery.mockResolvedValue(delivery());
  notifRepo.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'ntf-1', ...data }));
  notifRepo.findPreferences.mockResolvedValue([]);
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.get.mockResolvedValue(null);
  redis.redis.del.mockResolvedValue(1);
  comms.nonTransactionalTemplateKeys.mockResolvedValue(['announcement', 'statement-ready']);
  comms.countDeliveriesInWindow.mockResolvedValue(0);
  comms.findLegacyDeferred.mockResolvedValue([]);
  comms.recordAttempt.mockResolvedValue({});
  comms.findAttempts.mockResolvedValue([]);
  comms.ensureTransactionalFlags.mockResolvedValue(0);
  integrations.getEffectiveEmailConfig.mockResolvedValue({ primary: 'SMTP', host: 'smtp.local' });
  integrations.getEffectiveResendConfig.mockResolvedValue({ apiKey: 'rs_key' });
  // AE-B: the one door answers the provider it sent by; the dispatcher maps it.
  email.sendEmail.mockResolvedValue({ provider: 'SMTP', configured: true, messageId: null, response: null, previewUrl: null });
  sms.sendSms.mockResolvedValue({ skipped: false, rail: 'msg91', providerMessageId: 'req-1' });
});

describe('masking', () => {
  it('masks a mobile to the country code, the first five and the last two', () => {
    expect(maskMobile('9845012223')).toBe('+91 98450 •••23');
    expect(maskMobile('+919845012223')).toBe('+91 98450 •••23');
  });

  it('masks an email to its first letter and domain, and hashes case-insensitively', () => {
    expect(maskEmail('John.Doe@X.com')).toBe('j***@x.com');
    expect(hashRecipient('EMAIL', 'John.Doe@X.com')).toBe(hashRecipient('EMAIL', 'john.doe@x.com'));
    expect(hashRecipient('SMS', '9845012223')).toBe(hashRecipient('SMS', '+91 98450 12223'));
  });

  /* Lot F: the digest is keyed. A leaked table of plain SHA-256 hashes of
     ten-digit mobiles is a directory one afternoon of hashing away; under
     the HMAC there is nothing to compare a guess against without the key. */
  it('hashes under a keyed HMAC, never the plain SHA-256 of the address', () => {
    const plain = createHash('sha256').update('SMS:+919845012223').digest('hex');
    const keyed = createHmac('sha256', env.JWT_ACCESS_SECRET).update('SMS:+919845012223').digest('hex');
    expect(hashRecipient('SMS', '9845012223')).not.toBe(plain);
    expect(hashRecipient('SMS', '9845012223')).toBe(keyed);
    expect(hashRecipient('SMS', '9845012223')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders email variables escaped and lists a template variables', () => {
    expect(renderHtml('<p>{{name}}</p>', { name: '<b>x</b>' })).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    expect(variablesOf('Hi {{name}}', '{{ url }} {{name}}')).toEqual(['name', 'url']);
  });

  /* Lot F: an announcement typed as paragraphs reads as paragraphs. The
     break is added after escaping, so a value still cannot carry markup. */
  it('renders a newline inside a value as <br>, after escaping', () => {
    expect(renderHtml('<p>{{body}}</p>', { body: 'Line one\nLine two\r\n<i>three</i>' })).toBe('<p>Line one<br>Line two<br>&lt;i&gt;three&lt;/i&gt;</p>');
  });

  /* Lot F (E7-1): the monthly payment advice has a template beside the others. */
  it('seeds STATEMENT_READY as an email template with the month, the net figure and a link', () => {
    const seed = DEFAULT_TEMPLATES.find((t) => t.event === 'STATEMENT_READY');
    expect(seed).toMatchObject({ key: 'statement-ready', channels: ['EMAIL'] });
    expect(variablesOf(seed!.subject, seed!.emailBody)).toEqual(expect.arrayContaining(['month', 'net', 'url', 'partyName', 'reference']));
    expect(seed!.isSensitive).toBeFalsy();
  });
});

describe('notify', () => {
  it('writes the in-app row and one masked, hashed delivery per outbound channel, holding variables not text', async () => {
    notifRepo.findPreferences.mockResolvedValue([
      { type: 'BOOKING', channel: 'EMAIL', enabled: true },
      { type: 'BOOKING', channel: 'SMS', enabled: true },
    ]);
    const result = await notify(
      'PACKAGE_LINK',
      'usr-1',
      { name: 'Asha', packageName: 'Growth', url: 'https://adx.local/p/t' },
      { inApp: { type: 'BOOKING', title: 'Plan ready', message: 'Pay here' }, type: 'BOOKING' },
    );

    expect(notifRepo.create).toHaveBeenCalledWith({ userId: 'usr-1', type: 'BOOKING', title: 'Plan ready', message: 'Pay here' });
    expect(result.notificationId).toBe('ntf-1');
    expect(result.templateKey).toBe('package-link');
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: 'dlv-1' },
      { channel: 'SMS', deliveryId: 'dlv-2' },
    ]);

    const [emailRow, smsRow] = comms.createDelivery.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(emailRow).toMatchObject({
      userId: 'usr-1',
      notificationId: 'ntf-1',
      templateKey: 'package-link',
      channel: 'EMAIL',
      recipientMasked: 'a***@adx.co',
      recipientHash: hashRecipient('EMAIL', 'asha.rao@adx.co'),
      variables: { name: 'Asha', packageName: 'Growth', url: 'https://adx.local/p/t' },
    });
    expect(smsRow).toMatchObject({ channel: 'SMS', recipientMasked: '+91 98450 •••10' });
    expect(JSON.stringify(emailRow)).not.toContain('Hello Asha');
    // The address itself is stashed for the sender, not written to the table.
    expect(redis.redis.set).toHaveBeenCalledWith('comms:addr:dlv-1', 'Asha.Rao@adx.co', 'EX', 48 * 3600);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('writes nothing outbound when no ACTIVE template exists for the event', async () => {
    comms.findActiveTemplate.mockResolvedValue(null);
    const result = await notify('NO_SUCH_EVENT', 'usr-1', {}, { inApp: { type: 'SYSTEM', title: 't', message: 'm' } });
    // E9: the in-app row carries relatedType and payload exactly as the caller gave them.
    notifRepo.create.mockResolvedValueOnce({ id: 'ntf-2' });
    await notify(
      'NO_SUCH_EVENT',
      'usr-1',
      {},
      { inApp: { type: 'PAYOUT', title: 'Advice', message: 'm', relatedId: 'stm_1', relatedType: 'STATEMENT', payload: { statementId: 'stm_1', month: 'Aug 2026', net: '1200.00' } } },
    );
    expect(notifRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'usr-1', relatedId: 'stm_1', relatedType: 'STATEMENT', payload: { statementId: 'stm_1', month: 'Aug 2026', net: '1200.00' } }),
    );
    expect(result).toEqual({ notificationId: 'ntf-1', templateKey: null, deliveries: [] });
    expect(comms.createDelivery).not.toHaveBeenCalled();
  });

  it('skips a channel the person switched off, and a channel with no address', async () => {
    notifRepo.findPreferences.mockResolvedValue([{ type: 'BOOKING', channel: 'SMS', enabled: false }]);
    comms.findRecipient.mockResolvedValue(recipient({ email: null }));
    const result = await notify('PACKAGE_LINK', 'usr-1', {}, { type: 'BOOKING' });
    expect(result.deliveries).toEqual([
      { channel: 'EMAIL', deliveryId: null, skipped: 'NO_ADDRESS' },
      { channel: 'SMS', deliveryId: null, skipped: 'PREFERENCE_OFF' },
    ]);
    expect(comms.createDelivery).not.toHaveBeenCalled();
  });

  it('skips an announcement email to someone who unsubscribed, but not a transactional one', async () => {
    comms.findRecipient.mockResolvedValue(recipient({ emailUnsubscribedAt: new Date() }));
    const announcement = await notify('ANNOUNCEMENT', 'usr-1', {}, { type: 'ANNOUNCEMENT', channels: ['EMAIL'] });
    expect(announcement.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: null, skipped: 'UNSUBSCRIBED' }]);

    const transactional = await notify('PACKAGE_LINK', 'usr-1', {}, { type: 'PAYOUT', channels: ['EMAIL'] });
    expect(transactional.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-1' }]);
  });

  it('sends to an explicit recipient with no user behind it, and never touches the preference table', async () => {
    const result = await notify('PACKAGE_LINK', null, { url: 'x' }, { recipient: { email: 'buyer@x.com', mobile: '9845000000' } });
    expect(result.deliveries.map((d) => d.deliveryId)).toEqual(['dlv-1', 'dlv-2']);
    expect(comms.findRecipient).not.toHaveBeenCalled();
    expect(notifRepo.findPreferences).not.toHaveBeenCalled();
    expect((comms.createDelivery.mock.calls[0]![0] as Record<string, unknown>)['userId']).toBeNull();
  });

  it('skips SMS when the template names no registered kind', async () => {
    comms.findActiveTemplate.mockResolvedValue(template({ smsKind: null }));
    const result = await notify('PACKAGE_LINK', 'usr-1', {}, { channels: ['SMS'] });
    expect(result.deliveries).toEqual([{ channel: 'SMS', deliveryId: null, skipped: 'NO_SMS_KIND' }]);
  });

  it('attempts the send in the request when asked, leaving a failure for the job', async () => {
    comms.findDelivery.mockImplementation(async (id: string) => delivery({ id, channel: id === 'dlv-2' ? 'SMS' : 'EMAIL' }));
    redis.redis.get.mockImplementation(async (key: string) => (key.endsWith('dlv-2') ? '+919845012210' : 'asha.rao@adx.co'));
    email.sendEmail.mockRejectedValue(new Error('SMTP down'));
    const result = await notify('PACKAGE_LINK', 'usr-1', { url: 'x' }, { immediate: true });
    expect(result.deliveries).toHaveLength(2);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    expect(comms.updateDelivery).toHaveBeenCalledWith('dlv-1', expect.objectContaining({ status: 'QUEUED', attempts: 1, lastError: 'SMTP down' }));
    expect(comms.updateDelivery).toHaveBeenCalledWith('dlv-2', expect.objectContaining({ status: 'SENT', provider: 'msg91', providerMessageId: 'req-1' }));
  });
});

describe('the sender', () => {
  it('renders the email from the template and sends by the one door, then records the provider it answered', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    email.sendEmail.mockResolvedValue({ provider: 'RESEND', configured: true, messageId: 're_1', response: '{"id":"re_1"}', previewUrl: null });
    const after = await attemptDelivery('dlv-1');
    expect(email.sendEmail).toHaveBeenCalledWith(
      'asha.rao@adx.co',
      'Your ADX Growth plan',
      '<p>Hello Asha, <a href="https://adx.local/p/t?x=1&amp;y=2">pay</a></p>',
    );
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(after).toMatchObject({ status: 'SENT', provider: 'resend', providerMessageId: 're_1', attempts: 1 });
    expect(redis.redis.del).toHaveBeenCalledWith('comms:addr:dlv-1');
  });

  it('sends an SMS by the template kind with the rendered registered text', async () => {
    comms.findDelivery.mockResolvedValue(delivery({ channel: 'SMS', recipientHash: hashRecipient('SMS', '+919845012210') }));
    const after = await attemptDelivery('dlv-1');
    expect(sms.sendSms).toHaveBeenCalledWith({
      to: '+919845012210',
      kind: 'PACKAGE_LINK',
      vars: { name: 'Asha', packageName: 'Growth', url: 'https://adx.local/p/t?x=1&y=2' },
      body: 'ADX: Growth — https://adx.local/p/t?x=1&y=2',
    });
    expect(after).toMatchObject({ status: 'SENT', provider: 'msg91', providerMessageId: 'req-1' });
  });

  it('falls back to the person current address when the stash is gone, only if it still hashes the same', async () => {
    comms.findRecipient.mockResolvedValue(recipient({ email: 'moved@elsewhere.com' }));
    const after = await attemptDelivery('dlv-1');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: 'FAILED', lastError: 'RECIPIENT_UNAVAILABLE' });
  });

  it('marks a skipped rail SKIPPED and an exhausted retry FAILED', async () => {
    comms.findDelivery.mockResolvedValue(delivery({ channel: 'SMS', recipientHash: hashRecipient('SMS', '+919845012210') }));
    sms.sendSms.mockResolvedValue({ skipped: true, reason: 'UNREGISTERED_KIND' });
    expect(await attemptDelivery('dlv-1')).toMatchObject({ status: 'SKIPPED', lastError: 'UNREGISTERED_KIND' });

    comms.findDelivery.mockResolvedValue(delivery({ attempts: 2 }));
    email.sendEmail.mockRejectedValue(new Error('SMTP down'));
    expect(await attemptDelivery('dlv-1')).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'SMTP down' });
  });

  it('marks an email SKIPPED, not SENT, when no door is configured', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    email.sendEmail.mockResolvedValue({ provider: 'SMTP', configured: false, messageId: null, response: null, previewUrl: null });
    expect(await attemptDelivery('dlv-1')).toMatchObject({ status: 'SKIPPED', provider: 'smtp', lastError: 'EMAIL_UNCONFIGURED' });
    // The door still ran, which is where a developer reads the message locally.
    expect(email.sendEmail).toHaveBeenCalled();
  });

  it('leaves a row that is no longer QUEUED alone', async () => {
    comms.findDelivery.mockResolvedValue(delivery({ status: 'SENT' }));
    await attemptDelivery('dlv-1');
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(comms.updateDelivery).not.toHaveBeenCalled();
  });

  it('walks the queue and tallies the outcomes', async () => {
    comms.findQueued.mockResolvedValue([delivery({ id: 'a' }), delivery({ id: 'b' })]);
    comms.findDelivery.mockImplementation(async (id: string) => delivery({ id }));
    email.sendEmail.mockResolvedValueOnce({ provider: 'SMTP', configured: true, messageId: null, response: null, previewUrl: null }).mockRejectedValueOnce(new Error('later'));
    await expect(sendQueuedDeliveries(10)).resolves.toEqual({ picked: 2, sent: 1, failed: 0, skipped: 0, retry: 1, folded: 0 });
  });
});

describe('delivery reports', () => {
  it('moves the matching row on the provider message id and ignores strangers', async () => {
    comms.findByProviderMessageId.mockImplementation(async (_rail: string, id: string) => (id === 'req-1' ? delivery({ status: 'SENT' }) : null));
    const result = await recordDeliveryReports('msg91', [
      { providerMessageId: 'req-1', status: 'DELIVERED' },
      { providerMessageId: 'req-9', status: 'FAILED', error: 'DND' },
    ]);
    expect(result).toEqual({ matched: 1 });
    expect(comms.updateDelivery).toHaveBeenCalledWith('dlv-1', expect.objectContaining({ status: 'DELIVERED' }));
  });
});

describe('the log', () => {
  it('hashes an exact address in q and otherwise matches the mask', () => {
    expect(deliveryFilterFrom({ q: 'Asha.Rao@adx.co' })).toEqual({ recipientHash: hashRecipient('EMAIL', 'asha.rao@adx.co') });
    expect(deliveryFilterFrom({ q: '98450 12210' })).toEqual({ recipientHash: hashRecipient('SMS', '9845012210') });
    expect(deliveryFilterFrom({ q: '•••10', channel: 'SMS' })).toEqual({ channel: 'SMS', maskedContains: '•••10' });
  });

  it('resends a plain template as a fresh row, and refuses a sensitive one', async () => {
    redis.redis.get.mockResolvedValue('asha.rao@adx.co');
    const row = await resendDelivery('dlv-1');
    expect(comms.createDelivery).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'package-link', recipientMasked: 'a***@adx.co' }));
    expect(email.sendEmail).toHaveBeenCalled();
    expect(row.status).toBe('SENT');

    comms.findTemplateByKey.mockResolvedValue(template({ key: 'login-otp', isSensitive: true }));
    await expect(resendDelivery('dlv-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('masks the variable values of a sensitive template on every read of the log', async () => {
    comms.sensitiveTemplateKeys.mockResolvedValue(['two-factor-sms']);
    const sensitive = delivery({ id: 'dlv-9', templateKey: 'two-factor-sms', channel: 'SMS', variables: { code: '482913', minutes: '10' } });
    comms.findDelivery.mockResolvedValue(sensitive);
    const one = await getDelivery('dlv-9');
    expect(one.variables).toEqual({ code: '•••', minutes: '•••' });
    expect(JSON.stringify(one)).not.toContain('482913');

    comms.listDeliveries.mockResolvedValue({ items: [sensitive, delivery()], total: 2, counts: {} });
    const page = await listDeliveries({}, { page: 1, pageSize: 20 });
    expect(page.items[0]!.variables).toEqual({ code: '•••', minutes: '•••' });
    expect(page.items[1]!.variables).toEqual({ name: 'Asha', packageName: 'Growth', url: 'https://adx.local/p/t?x=1&y=2' });
  });

  it('refuses a resend once the variables are purged', async () => {
    comms.findDelivery.mockResolvedValue(delivery({ variables: null, purgedAt: new Date() }));
    await expect(resendDelivery('dlv-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('templates', () => {
  it('bumps the version on edit and refuses SMS without a registered kind', async () => {
    comms.updateTemplate.mockImplementation(async (key: string, data: Record<string, unknown>) => template({ key, ...data, version: 2 }));
    const { before, after } = await updateTemplate('package-link', { subject: 'New' }, 'adm-1');
    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
    expect(comms.updateTemplate).toHaveBeenCalledWith('package-link', { subject: 'New', updatedById: 'adm-1' });

    await expect(updateTemplate('package-link', { smsKind: null }, 'adm-1')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('E10-2: template figures', () => {
  it('folds one grouped query into sent / delivered / failed and the share that got out, over thirty Indian days', async () => {
    comms.templateStats.mockResolvedValue([
      { templateKey: 'payout-paid', status: 'SENT', count: 30 },
      { templateKey: 'payout-paid', status: 'DELIVERED', count: 10 },
      { templateKey: 'payout-paid', status: 'FAILED', count: 2 },
      { templateKey: 'payout-paid', status: 'QUEUED', count: 5 },
      { templateKey: 'payout-paid', status: 'SKIPPED', count: 7 },
      { templateKey: 'login-otp', status: 'SKIPPED', count: 3 },
    ]);
    const now = new Date('2026-09-13T10:00:00.000Z');
    const stats = await templateStats(now);
    expect(comms.templateStats).toHaveBeenCalledTimes(1);
    // 30 IST days ending today: the IST midnight of 15 Aug (18:30Z on the 14th).
    expect(comms.templateStats).toHaveBeenCalledWith(new Date('2026-08-14T18:30:00.000Z'));
    expect(templateStatsSince(now)).toEqual(new Date('2026-08-14T18:30:00.000Z'));
    expect(stats['payout-paid']).toEqual({ sent30d: 40, delivered30d: 10, failed30d: 2, deliveryRate: 0.95 });
    // Skipped rows never tried, so the rate is undecided rather than zero.
    expect(stats['login-otp']).toEqual({ sent30d: 0, delivered30d: 0, failed30d: 0, deliveryRate: null });
  });
});

describe('E10-2: the events catalogue', () => {
  it('lists every registered event with its variables and the templates on file, and a stray template under its own event', async () => {
    comms.allTemplates.mockResolvedValue([
      { key: 'payout-paid', event: 'PAYOUT_PAID', status: 'ACTIVE', channels: ['EMAIL', 'SMS'] },
      { key: 'payout-paid-v2', event: 'PAYOUT_PAID', status: 'DRAFT', channels: ['EMAIL'] },
      { key: 'welcome', event: 'WELCOME', status: 'DRAFT', channels: ['EMAIL'] },
    ]);
    const catalogue = await eventCatalogue();
    const payout = catalogue.find((entry) => entry.event === 'PAYOUT_PAID')!;
    expect(payout).toMatchObject({ variables: ['amount', 'method', 'reference', 'utr'], raisedBy: ['payouts'], via: 'notify' });
    expect(payout.templates).toEqual([
      { key: 'payout-paid', status: 'ACTIVE', channels: ['EMAIL', 'SMS'] },
      { key: 'payout-paid-v2', status: 'DRAFT', channels: ['EMAIL'] },
    ]);
    expect(catalogue.find((entry) => entry.event === 'LOGIN_OTP')).toMatchObject({ via: 'sendSms', sensitive: true, templates: [] });
    expect(catalogue[catalogue.length - 1]).toMatchObject({ event: 'WELCOME', variables: [], raisedBy: [], templates: [{ key: 'welcome' }] });
  });
});

describe('E10-2: the export', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'dlv-1',
    userId: 'usr-1',
    notificationId: null,
    templateKey: 'login-otp',
    channel: 'SMS',
    status: 'SENT',
    recipientMasked: '+91 98450 •••23',
    recipientHash: 'a'.repeat(64),
    variables: { code: '123456', minutes: '5' },
    attempts: 1,
    provider: 'msg91',
    providerMessageId: 'req-1',
    lastError: 'Rejected, "by" operator',
    sentAt: new Date('2026-09-13T04:00:00.000Z'),
    deliveredAt: null,
    purgedAt: null,
    createdAt: new Date('2026-09-13T03:59:00.000Z'),
    updatedAt: new Date('2026-09-13T04:00:00.000Z'),
    ...over,
  });

  it('writes the masked recipient and never the variables or the hash, quoting RFC 4180 style', () => {
    expect(deliveryCsvHeader()).toBe(`${DELIVERY_CSV_COLUMNS.join(',')}\r\n`);
    expect(DELIVERY_CSV_COLUMNS).not.toContain('variables');
    expect(DELIVERY_CSV_COLUMNS).not.toContain('recipientHash');
    const line = deliveryCsvLine(row() as never);
    expect(line).toBe('dlv-1,2026-09-13T03:59:00.000Z,login-otp,SMS,SENT,+91 98450 •••23,usr-1,,1,msg91,req-1,"Rejected, ""by"" operator",2026-09-13T04:00:00.000Z,\r\n');
    expect(line).not.toContain('123456');
    expect(line).not.toContain('a'.repeat(64));
  });

  /* E12-B: a provider's message can quote the address it failed to reach —
     "550 mailbox jane@x.com unavailable", "number +919845012210 rejected" —
     and the file must not carry a directory the log itself refuses to. */
  it('E12-B: masks any address the provider quoted in lastError, the way the recipient column is masked', () => {
    const line = deliveryCsvLine(
      row({
        lastError: 'Mailbox Jane.Doe@Example.com unavailable; +919845012210 and 9845012210 rejected; 98450 12210 too',
      }) as never,
    );
    expect(line).not.toContain('Jane.Doe@Example.com');
    expect(line).not.toContain('9845012210');
    expect(line).not.toContain('98450 12210');
    expect(line).toContain('Mailbox j***@example.com unavailable; +91 98450 •••10 and +91 98450 •••10 rejected; +91 98450 •••10 too');
    expect(maskAddressesIn('no address here, only 12345 and code 4321')).toBe('no address here, only 12345 and code 4321');
    expect(maskAddressesIn('Rejected, "by" operator')).toBe('Rejected, "by" operator');
    expect(deliveryCsvLine(row({ lastError: null }) as never)).toBe(
      'dlv-1,2026-09-13T03:59:00.000Z,login-otp,SMS,SENT,+91 98450 •••23,usr-1,,1,msg91,req-1,,2026-09-13T04:00:00.000Z,\r\n',
    );
  });

  /* E12-B: the walk is by keyset — (createdAt, id) under a fixed order —
     never skip/take, so a row landing mid-stream can neither push a row
     into the next batch twice nor out of it altogether. The fake below is
     an honest keyset repository over an array, so the mid-stream insert
     below is a real test of the cursor and not of the mock. */
  const keysetRepo = (store: ReturnType<typeof row>[]) => async (_filter: unknown, slice: { take: number; sort: 'newest' | 'oldest'; after?: { createdAt: Date; id: string } }) => {
    const dir = slice.sort === 'oldest' ? 1 : -1;
    const sorted = [...store].sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)));
    const after = slice.after;
    const rest = after
      ? sorted.filter((r) => {
          const dt = r.createdAt.getTime() - after.createdAt.getTime();
          return dir * dt > 0 || (dt === 0 && dir * r.id.localeCompare(after.id) > 0);
        })
      : sorted;
    return rest.slice(0, slice.take);
  };

  it('E12-B: walks the same filter by keyset a slice at a time, oldest or newest first, and stops at the cap', async () => {
    const store = Array.from({ length: 2600 }, (_, i) => row({ id: `dlv-${String(i).padStart(4, '0')}`, createdAt: new Date(2026, 8, 1, 0, Math.floor(i / 60), i % 60) }));
    comms.findDeliveryRows.mockImplementation(keysetRepo(store));
    const batches: ReturnType<typeof row>[][] = [];
    for await (const rows of iterateDeliveryRows({ channel: 'SMS', q: '9845012210' }, 'oldest', 2500)) batches.push(rows as never);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat().map((r) => r.id)).toEqual(store.slice(0, 2500).map((r) => r.id));
    expect(comms.findDeliveryRows).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: 'SMS', recipientHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      { take: 1000, sort: 'oldest' },
    );
    expect(comms.findDeliveryRows).toHaveBeenNthCalledWith(2, expect.anything(), {
      take: 1000,
      sort: 'oldest',
      after: { createdAt: store[999]!.createdAt, id: 'dlv-0999' },
    });
    expect(comms.findDeliveryRows).toHaveBeenNthCalledWith(3, expect.anything(), {
      take: 500,
      sort: 'oldest',
      after: { createdAt: store[1999]!.createdAt, id: 'dlv-1999' },
    });
    for (const call of comms.findDeliveryRows.mock.calls) expect(call[1]).not.toHaveProperty('skip');

    comms.findDeliveryRows.mockReset();
    comms.findDeliveryRows.mockImplementation(keysetRepo([row()]));
    const short: unknown[][] = [];
    for await (const rows of iterateDeliveryRows({}, 'newest')) short.push(rows);
    expect(short).toHaveLength(1);
    expect(comms.findDeliveryRows).toHaveBeenCalledTimes(1);
  });

  it('E12-B: a row inserted mid-stream is neither duplicated nor skipped, newest or oldest first', async () => {
    const at = (i: number) => new Date(2026, 8, 1, 0, 0, i);
    for (const sort of ['newest', 'oldest'] as const) {
      // Three rows share one second, so the id tie-break is exercised too.
      const store = Array.from({ length: 2500 }, (_, i) => row({ id: `dlv-${String(i).padStart(4, '0')}`, createdAt: at(i < 3 ? 0 : i) }));
      const before = store.map((r) => r.id);
      let calls = 0;
      comms.findDeliveryRows.mockReset();
      comms.findDeliveryRows.mockImplementation(async (filter, slice) => {
        const page = await keysetRepo(store)(filter, slice as never);
        // Between the first and the second batch, one row lands at the head (newest) and one at the tail (oldest) of the walk.
        if (++calls === 1) {
          store.push(row({ id: 'dlv-new-head', createdAt: at(9999) }), row({ id: 'dlv-0000-tie', createdAt: at(0) }));
        }
        return page;
      });
      const seen: string[] = [];
      for await (const rows of iterateDeliveryRows({}, sort, 10_000)) seen.push(...(rows as unknown as ReturnType<typeof row>[]).map((r) => r.id));
      expect(new Set(seen).size).toBe(seen.length);
      if (sort === 'newest') {
        // The head insert is behind the cursor and rightly missed; the tail one, ahead of it, is picked up.
        expect(seen).toEqual(expect.arrayContaining(before));
        expect(seen).toContain('dlv-0000-tie');
        expect(seen).not.toContain('dlv-new-head');
        expect(seen.slice(0, 1000)).toEqual([...before].reverse().slice(0, 1000));
      } else {
        expect(seen).toEqual(expect.arrayContaining(before));
        expect(seen).toContain('dlv-new-head');
        expect(seen).not.toContain('dlv-0000-tie');
        expect(seen.slice(0, 1000)).toEqual(before.slice(0, 1000));
      }
      expect(seen).toHaveLength(2501);
    }
  });
});

describe('retention', () => {
  it('purges sensitive variables at 7 days, the rest at 90, and deletes rows at 180', async () => {
    comms.sensitiveTemplateKeys.mockResolvedValue(['login-otp']);
    comms.purgeVariables.mockResolvedValueOnce(3).mockResolvedValueOnce(7);
    comms.deleteCreatedBefore.mockResolvedValue(2);
    const now = new Date('2026-09-12T00:00:00.000Z');
    await expect(purgeDeliveries(now)).resolves.toEqual({ sensitive: 3, standard: 7, deleted: 2 });
    expect(comms.purgeVariables).toHaveBeenNthCalledWith(1, new Date('2026-09-05T00:00:00.000Z'), now, ['login-otp']);
    expect(comms.purgeVariables).toHaveBeenNthCalledWith(2, new Date('2026-06-14T00:00:00.000Z'), now);
    expect(comms.deleteCreatedBefore).toHaveBeenCalledWith(new Date('2026-03-16T00:00:00.000Z'));
  });
});

describe('unsubscribe', () => {
  it('round-trips a signed token and refuses a tampered one', async () => {
    const token = unsubscribeToken('usr-1');
    expect(readUnsubscribeToken(token)).toBe('usr-1');
    expect(readUnsubscribeToken(`${token}x`)).toBeNull();
    expect(readUnsubscribeToken('nope')).toBeNull();

    comms.markEmailUnsubscribed.mockResolvedValue(true);
    await expect(unsubscribe(token)).resolves.toEqual({ userId: 'usr-1', alreadyUnsubscribed: false });
    await expect(unsubscribe('bad.token')).rejects.toMatchObject({ statusCode: 404 });
  });
});
