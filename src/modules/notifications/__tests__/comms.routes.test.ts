import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The comms desk over HTTP — Lot E (Q87).
 *
 * The unsubscribe link answers without a token; everything else is ADMIN
 * with the comms tiers; a template edit bumps the version and leaves an
 * audit row naming the template; a sensitive delivery cannot be resent; a
 * Twilio report with a bad signature is a 401 and records nothing.
 */

const { service, audit, sms } = vi.hoisted(() => ({
  service: {
    listTemplates: vi.fn(),
    getTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    listDeliveries: vi.fn(),
    getDelivery: vi.fn(),
    resendDelivery: vi.fn(),
    sendTestTemplate: vi.fn(),
    unsubscribe: vi.fn(),
    recordDeliveryReports: vi.fn(),
    // E10-2
    templateStats: vi.fn(),
    statsFor: vi.fn((all: Record<string, unknown>, key: string) => all[key] ?? { sent30d: 0, delivered30d: 0, failed30d: 0, deliveryRate: null }),
    eventCatalogue: vi.fn(),
    iterateDeliveryRows: vi.fn(),
    deliveryCsvHeader: vi.fn(() => 'id,createdAt,templateKey,channel,status,recipientMasked\r\n'),
    deliveryCsvLine: vi.fn((row: Record<string, unknown>) => `${row['id']},${row['recipientMasked']}\r\n`),
    DELIVERY_EXPORT_ROW_CAP: 50_000,
  },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({ subject: { before: 'a', after: 'b' } })) },
  sms: { parseSmsDeliveryWebhook: vi.fn() },
}));

vi.mock('../dispatch.service', () => service);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../../shared/sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/sms')>();
  return { ...actual, ...sms };
});

import { ApiError, errorHandler } from '../../../shared/errors';
import { SMS_KINDS, SMS_RAIL_NAMES, WebhookRejected } from '../../../shared/sms';
import { tokenFor } from '../../../shared/testing';
import { commsRouter, commsWebhookRouter } from '../comms.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(express.urlencoded({ extended: true }));
  const api = Router();
  api.use('/comms', commsRouter);
  api.use('/webhooks', commsWebhookRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-1');

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  key: 'payout-paid',
  event: 'PAYOUT_PAID',
  channels: ['EMAIL'],
  subject: 'Paid {{amount}}',
  emailBody: '<p>{{amount}}</p>',
  smsKind: null,
  smsBody: null,
  isSensitive: false,
  status: 'ACTIVE',
  version: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  service.listTemplates.mockResolvedValue({ items: [template()], total: 1, counts: { DRAFT: 0, ACTIVE: 1, RETIRED: 0 } });
  service.getTemplate.mockResolvedValue(template());
  service.updateTemplate.mockResolvedValue({ before: template(), after: template({ subject: 'Sent {{amount}}', version: 2 }) });
  service.createTemplate.mockResolvedValue(template({ key: 'new-one', status: 'DRAFT' }));
  service.listDeliveries.mockResolvedValue({ items: [], total: 0, counts: {}, byChannel: { IN_APP: 0, PUSH: 0, EMAIL: 3, SMS: 1 } });
  service.templateStats.mockResolvedValue({ 'payout-paid': { sent30d: 40, delivered30d: 12, failed30d: 2, deliveryRate: 0.95 } });
  service.eventCatalogue.mockResolvedValue([{ event: 'PAYOUT_PAID', variables: ['amount'], raisedBy: ['payouts'], via: 'notify', templates: [] }]);
  service.iterateDeliveryRows.mockImplementation(async function* () {
    yield [{ id: 'dlv-1', recipientMasked: 'j***@x.com', variables: { code: '123456' } }];
    yield [{ id: 'dlv-2', recipientMasked: '+91 98450 •••23', variables: { code: '654321' } }];
  });
  service.unsubscribe.mockResolvedValue({ userId: 'usr-1', alreadyUnsubscribed: false });
  service.recordDeliveryReports.mockResolvedValue({ matched: 1 });
});

describe('guards', () => {
  it('lets the unsubscribe link through without a token and answers a page', async () => {
    const res = await request(app()).get('/api/v1/comms/unsubscribe/abcdefgh.ijklmnop');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('You are unsubscribed');
    expect(service.unsubscribe).toHaveBeenCalledWith('abcdefgh.ijklmnop');
  });

  it('refuses the desk to a party and to no token', async () => {
    expect((await request(app()).get('/api/v1/comms/templates')).status).toBe(401);
    expect((await request(app()).get('/api/v1/comms/templates').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });
});

describe('templates', () => {
  it('lists on the list contract with the variables each template names', async () => {
    const res = await request(app()).get('/api/v1/comms/templates?status=ACTIVE&sort=key').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 1, page: 1, pageSize: 20, counts: { ACTIVE: 1 } });
    expect(res.body.data.items[0].variables).toEqual(['amount']);
    expect(service.listTemplates).toHaveBeenCalledWith({ q: undefined, status: ['ACTIVE'], event: undefined }, expect.objectContaining({ sort: 'key', page: 1 }));
  });

  it('E10-2: every row carries its thirty-day figures from one grouped query, zeros where the log has nothing', async () => {
    service.listTemplates.mockResolvedValue({
      items: [template(), template({ id: 'tpl-2', key: 'visit-offer', event: 'VISIT_OFFER' })],
      total: 2,
      counts: { DRAFT: 0, ACTIVE: 2, RETIRED: 0 },
    });
    const res = await request(app()).get('/api/v1/comms/templates').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(service.templateStats).toHaveBeenCalledTimes(1);
    expect(res.body.data.items[0].stats).toEqual({ sent30d: 40, delivered30d: 12, failed30d: 2, deliveryRate: 0.95 });
    expect(res.body.data.items[1].stats).toEqual({ sent30d: 0, delivered30d: 0, failed30d: 0, deliveryRate: null });
  });
});

describe('E10-2: the vocabulary reads', () => {
  it('answers the events catalogue to comms.view and refuses a party', async () => {
    const res = await request(app()).get('/api/v1/comms/events').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ event: 'PAYOUT_PAID', variables: ['amount'], raisedBy: ['payouts'], via: 'notify', templates: [] }]);
    expect((await request(app()).get('/api/v1/comms/events').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });

  it('answers the SMS kinds and the rail names off shared/sms, so the console stops mirroring them', async () => {
    const res = await request(app()).get('/api/v1/comms/sms-kinds').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.kinds).toEqual([...SMS_KINDS]);
    expect(res.body.data.rails).toEqual([...SMS_RAIL_NAMES]);
  });

  it('creates a draft and audits it against the template key', async () => {
    const res = await request(app())
      .post('/api/v1/comms/templates')
      .set('Authorization', `Bearer ${admin}`)
      .send({ key: 'new-one', event: 'NEW_ONE', channels: ['EMAIL'], subject: 'x', emailBody: '<p>x</p>' });
    expect(res.status).toBe(201);
    expect(service.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ key: 'new-one', event: 'NEW_ONE' }), 'adm-1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'NOTIFICATION_TEMPLATE_CREATED',
      expect.objectContaining({ targetType: 'NotificationTemplate', targetId: 'new-one', module: 'notifications' }),
    );
  });

  it('rejects a key that is not a slug and an event that is not UPPER_SNAKE', async () => {
    const res = await request(app())
      .post('/api/v1/comms/templates')
      .set('Authorization', `Bearer ${admin}`)
      .send({ key: 'Bad Key', event: 'bad', channels: ['EMAIL'] });
    expect(res.status).toBe(400);
    expect(service.createTemplate).not.toHaveBeenCalled();
  });

  it('patches a template, bumping the version, with the diff in the audit row', async () => {
    const res = await request(app()).patch('/api/v1/comms/templates/payout-paid').set('Authorization', `Bearer ${admin}`).send({ subject: 'Sent {{amount}}' });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(service.updateTemplate).toHaveBeenCalledWith('payout-paid', { subject: 'Sent {{amount}}' }, 'adm-1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'NOTIFICATION_TEMPLATE_UPDATED',
      expect.objectContaining({ targetType: 'NotificationTemplate', targetId: 'payout-paid', diff: expect.any(Object) }),
    );
  });

  it('G10: carries pushTitle and pushBody on create and patch', async () => {
    const created = await request(app())
      .post('/api/v1/comms/templates')
      .set('Authorization', `Bearer ${admin}`)
      .send({ key: 'new-one', event: 'NEW_ONE', channels: ['PUSH'], pushTitle: 'Hello {{name}}', pushBody: 'Tap to open' });
    expect(created.status).toBe(201);
    expect(service.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ pushTitle: 'Hello {{name}}', pushBody: 'Tap to open' }), 'adm-1');

    const patched = await request(app()).patch('/api/v1/comms/templates/payout-paid').set('Authorization', `Bearer ${admin}`).send({ pushBody: null });
    expect(patched.status).toBe(200);
    expect(service.updateTemplate).toHaveBeenCalledWith('payout-paid', { pushBody: null }, 'adm-1');
  });

  it('refuses an empty patch', async () => {
    const res = await request(app()).patch('/api/v1/comms/templates/payout-paid').set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(400);
  });

  /* Lot G (Q117): the test send — the operator's own addresses, never one the body names. */
  it('sends a test of the template to the signed-in operator and audits it', async () => {
    service.sendTestTemplate.mockResolvedValue({
      templateKey: 'payout-paid',
      variables: { amount: '1,250.00' },
      deliveries: [{ channel: 'EMAIL', deliveryId: 'dlv-9', status: 'SENT' }],
    });
    const res = await request(app()).post('/api/v1/comms/templates/payout-paid/send-test').set('Authorization', `Bearer ${admin}`).send({ channels: ['EMAIL'] });
    expect(res.status).toBe(201);
    expect(res.body.data.deliveries).toEqual([{ channel: 'EMAIL', deliveryId: 'dlv-9', status: 'SENT' }]);
    expect(service.sendTestTemplate).toHaveBeenCalledWith('payout-paid', 'adm-1', ['EMAIL']);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'NOTIFICATION_TEMPLATE_TEST_SENT',
      expect.objectContaining({ module: 'notifications', targetType: 'NotificationTemplate', targetId: 'payout-paid' }),
    );
  });

  it('refuses a test send that names an address, and one from a party', async () => {
    const stranger = await request(app()).post('/api/v1/comms/templates/payout-paid/send-test').set('Authorization', `Bearer ${admin}`).send({ to: 'x@y.com' });
    expect(stranger.status).toBe(400);
    expect(service.sendTestTemplate).not.toHaveBeenCalled();
    const party = await request(app()).post('/api/v1/comms/templates/payout-paid/send-test').set('Authorization', `Bearer ${publisher}`).send({});
    expect(party.status).toBe(403);
  });

  it('accepts the transactional flag on create', async () => {
    const res = await request(app())
      .post('/api/v1/comms/templates')
      .set('Authorization', `Bearer ${admin}`)
      .send({ key: 'promo-week', event: 'PROMO_WEEK', channels: ['EMAIL'], emailBody: '<p>{{title}}</p>', transactional: false });
    expect(res.status).toBe(201);
    expect(service.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ key: 'promo-week', transactional: false }), 'adm-1');
  });
});

describe('the delivery log', () => {
  it('passes the filter through on the list contract', async () => {
    const res = await request(app())
      .get('/api/v1/comms/deliveries?channel=SMS&status=SENT,FAILED&templateKey=login-otp&q=9845012210&from=2026-09-01&to=2026-09-12')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(service.listDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'SMS', status: ['SENT', 'FAILED'], templateKey: 'login-otp', q: '9845012210', from: new Date('2026-09-01'), to: new Date('2026-09-12') }),
      expect.objectContaining({ page: 1, pageSize: 20, sort: 'newest' }),
    );
  });

  it('refuses from after to', async () => {
    const res = await request(app()).get('/api/v1/comms/deliveries?from=2026-09-12&to=2026-09-01').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
  });

  it('E10-2: the page carries the channel histogram beside the status one', async () => {
    const res = await request(app()).get('/api/v1/comms/deliveries').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20, counts: {}, byChannel: { EMAIL: 3, SMS: 1, IN_APP: 0, PUSH: 0 } });
  });

  it('E10-2: exports the log under the current filters as a streamed CSV of masked recipients, audited before the first byte', async () => {
    const res = await request(app())
      .get('/api/v1/comms/deliveries/export.csv?channel=EMAIL&status=FAILED&templateKey=payout-paid&sort=oldest&from=2026-09-01')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="deliveries-.*\.csv"/);
    expect(res.text).toBe('id,createdAt,templateKey,channel,status,recipientMasked\r\ndlv-1,j***@x.com\r\ndlv-2,+91 98450 •••23\r\n');
    expect(res.text).not.toContain('123456');
    expect(service.iterateDeliveryRows).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'EMAIL', status: ['FAILED'], templateKey: 'payout-paid', from: new Date('2026-09-01') }),
      'oldest',
    );
    expect(service.getDelivery).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'COMMS_DELIVERIES_EXPORTED',
      expect.objectContaining({ module: 'notifications', metadata: expect.objectContaining({ sort: 'oldest', cap: 50_000 }) }),
    );
  });

  it('E10-2: the export is comms.view — a party is refused, and a bad window is a 400 before anything is written', async () => {
    expect((await request(app()).get('/api/v1/comms/deliveries/export.csv').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const res = await request(app()).get('/api/v1/comms/deliveries/export.csv?from=2026-09-12&to=2026-09-01').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('resends and audits, and surfaces the sensitive refusal as a 409', async () => {
    service.resendDelivery.mockResolvedValue({ id: 'dlv-2', templateKey: 'payout-paid', channel: 'EMAIL', status: 'SENT' });
    const ok = await request(app()).post('/api/v1/comms/deliveries/dlv-1/resend').set('Authorization', `Bearer ${admin}`);
    expect(ok.status).toBe(201);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'NOTIFICATION_RESENT',
      expect.objectContaining({ targetType: 'NotificationDelivery', targetId: 'dlv-2', metadata: expect.objectContaining({ originalDeliveryId: 'dlv-1' }) }),
    );

    service.resendDelivery.mockRejectedValue(new ApiError(409, 'CONFLICT', 'A sensitive message is never resent from the log'));
    const refused = await request(app()).post('/api/v1/comms/deliveries/dlv-1/resend').set('Authorization', `Bearer ${admin}`);
    expect(refused.status).toBe(409);
  });
});

describe('delivery-report webhooks', () => {
  it('reads an MSG91 report without a token and records it', async () => {
    sms.parseSmsDeliveryWebhook.mockResolvedValue([{ providerMessageId: 'req-1', status: 'DELIVERED' }]);
    const res = await request(app()).post('/api/v1/webhooks/msg91').send([{ requestId: 'req-1', report: [{ status: '1' }] }]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: 1, matched: 1 });
    expect(sms.parseSmsDeliveryWebhook).toHaveBeenCalledWith('msg91', expect.objectContaining({ url: expect.stringContaining('/api/v1/webhooks/msg91') }));
    expect(service.recordDeliveryReports).toHaveBeenCalledWith('msg91', [{ providerMessageId: 'req-1', status: 'DELIVERED' }]);
  });

  it('answers 401 to a Twilio report the adapter rejects and records nothing', async () => {
    sms.parseSmsDeliveryWebhook.mockRejectedValue(new WebhookRejected('Twilio signature mismatch'));
    const res = await request(app()).post('/api/v1/webhooks/twilio').type('form').send({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(res.status).toBe(401);
    expect(service.recordDeliveryReports).not.toHaveBeenCalled();
  });
});

/* T-B — a write answers the same view its read answers. */
describe('T-B: the template writes answer the list row', () => {
  it('POST /comms/templates carries variables[] and stats beside the row', async () => {
    service.createTemplate.mockResolvedValue(template({ key: 'payout-paid', status: 'DRAFT', subject: 'Paid {{amount}} to {{name}}' }));
    const res = await request(app())
      .post('/api/v1/comms/templates')
      .set('Authorization', `Bearer ${admin}`)
      .send({ key: 'payout-paid', event: 'PAYOUT_PAID', channels: ['EMAIL'], subject: 'Paid {{amount}} to {{name}}', emailBody: '<p>x</p>' });
    expect(res.status).toBe(201);
    expect(service.templateStats).toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      key: 'payout-paid',
      variables: ['amount', 'name'],
      stats: { sent30d: 40, delivered30d: 12, failed30d: 2, deliveryRate: 0.95 },
    });
  });

  it('GET /comms/templates/:key and PATCH /comms/templates/:key carry the same two fields', async () => {
    const got = await request(app()).get('/api/v1/comms/templates/payout-paid').set('Authorization', `Bearer ${admin}`);
    expect(got.body.data).toMatchObject({ variables: ['amount'], stats: expect.objectContaining({ sent30d: 40 }) });
    const patched = await request(app()).patch('/api/v1/comms/templates/payout-paid').set('Authorization', `Bearer ${admin}`).send({ subject: 'Sent {{amount}}' });
    expect(patched.body.data).toMatchObject({ version: 2, variables: ['amount'], stats: expect.objectContaining({ sent30d: 40 }) });
  });
});
