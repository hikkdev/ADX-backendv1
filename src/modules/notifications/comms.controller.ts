import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { toListPage } from '../../shared/pagination';
import { logger } from '../../shared/logging';
import { parseSmsDeliveryWebhook, SMS_KINDS, SMS_RAIL_NAMES, WebhookRejected, type SmsRailName } from '../../shared/sms';
import {
  createTemplateSchema,
  deliveryIdParamSchema,
  exportDeliveriesQuerySchema,
  listDeliveriesQuerySchema,
  listTemplatesQuerySchema,
  sendTestSchema,
  templateKeyParamSchema,
  unsubscribeParamSchema,
  updateTemplateSchema,
} from './comms.schema';
import {
  createTemplate,
  DELIVERY_EXPORT_ROW_CAP,
  deliveryCsvHeader,
  deliveryCsvLine,
  eventCatalogue,
  getDelivery,
  getTemplate,
  iterateDeliveryRows,
  listDeliveries,
  listTemplates,
  recordDeliveryReports,
  resendDelivery,
  sendTestTemplate,
  statsFor,
  templateStats,
  unsubscribe,
  updateTemplate,
} from './dispatch.service';
import { variablesOf } from './templates';

const MODULE = 'notifications';

function invalid(error: { flatten(): unknown }, what = 'request'): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}`, error.flatten());
}

/* ── templates ───────────────────────────────────────────────────── */

type TemplateLike = {
  key: string;
  subject: string | null;
  emailBody: string | null;
  smsBody: string | null;
  pushTitle: string | null;
  pushBody: string | null;
};

/**
 * The template row every read and write answers: the stored row, the
 * `{{names}}` its bodies use, and (E10-2) its 30-day delivery figures. T-B:
 * the get, the create and the patch answer it too — one grouped stats query
 * beside the write — so the desk updates the row from the answer.
 */
function templateView<T extends TemplateLike>(template: T, stats: Awaited<ReturnType<typeof templateStats>>) {
  return {
    ...template,
    variables: variablesOf(template.subject, template.emailBody, template.smsBody, template.pushTitle, template.pushBody),
    stats: statsFor(stats, template.key),
  };
}

export async function listTemplatesHandler(req: Request, res: Response): Promise<void> {
  const parsed = listTemplatesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, event, ...page } = parsed.data;
  // E10-2: the figures ride on every row from one grouped query for the page.
  const [{ items, total, counts }, stats] = await Promise.all([listTemplates({ q, status, event }, page), templateStats()]);
  res.json({
    success: true,
    data: toListPage(
      items.map((t) => templateView(t, stats)),
      total,
      counts,
      page,
    ),
  });
}

/* ── the catalogue and the vocabulary (E10-2) ───────────────────── */

/** GET /comms/events — every event the code raises, the variables it supplies, the copy on file. */
export async function listEventsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await eventCatalogue() });
}

/** GET /comms/sms-kinds — the DLT kinds and the rail names, so the console stops mirroring `shared/sms`. */
export async function smsKindsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: { kinds: SMS_KINDS, rails: SMS_RAIL_NAMES } });
}

export async function getTemplateHandler(req: Request, res: Response): Promise<void> {
  const params = templateKeyParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'key');
  const [template, stats] = await Promise.all([getTemplate(params.data.key), templateStats()]);
  res.json({ success: true, data: templateView(template, stats) });
}

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const template = await createTemplate(parsed.data, req.user!.sub);
  await logActivity(req.user!.sub, 'NOTIFICATION_TEMPLATE_CREATED', {
    req,
    module: MODULE,
    targetType: 'NotificationTemplate',
    targetId: template.key,
    metadata: { event: template.event, channels: template.channels, status: template.status, isSensitive: template.isSensitive, transactional: template.transactional },
  });
  res.status(201).json({ success: true, data: templateView(template, await templateStats()) });
}

/**
 * POST /comms/templates/:key/send-test — Lot G (Q117): the template with
 * sample variables to the signed-in operator's own email / mobile. The body
 * may narrow the channels and nothing else; the destination is never taken
 * from the request. Audited `NOTIFICATION_TEMPLATE_TEST_SENT`.
 */
export async function sendTestTemplateHandler(req: Request, res: Response): Promise<void> {
  const params = templateKeyParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'key');
  const parsed = sendTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const result = await sendTestTemplate(params.data.key, req.user!.sub, parsed.data.channels);
  await logActivity(req.user!.sub, 'NOTIFICATION_TEMPLATE_TEST_SENT', {
    req,
    module: MODULE,
    targetType: 'NotificationTemplate',
    targetId: result.templateKey,
    metadata: { deliveries: result.deliveries, variables: Object.keys(result.variables) },
  });
  res.status(201).json({ success: true, data: result });
}

export async function updateTemplateHandler(req: Request, res: Response): Promise<void> {
  const params = templateKeyParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'key');
  const parsed = updateTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const { before, after } = await updateTemplate(params.data.key, parsed.data, req.user!.sub);
  await logActivity(req.user!.sub, 'NOTIFICATION_TEMPLATE_UPDATED', {
    req,
    module: MODULE,
    targetType: 'NotificationTemplate',
    targetId: after.key,
    diff: auditDiff(before, after, ['event', 'channels', 'subject', 'emailBody', 'smsKind', 'smsBody', 'isSensitive', 'transactional', 'status', 'version']),
  });
  res.json({ success: true, data: templateView(after, await templateStats()) });
}

/* ── the delivery log ────────────────────────────────────────────── */

export async function listDeliveriesHandler(req: Request, res: Response): Promise<void> {
  const parsed = listDeliveriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, channel, templateKey, userId, from, to, ...page } = parsed.data;
  const { items, total, counts, byChannel } = await listDeliveries({ q, status, channel, templateKey, userId, from, to }, page);
  // E10-2: the channel histogram rides beside the status one.
  res.json({ success: true, data: { ...toListPage(items, total, counts, page), byChannel } });
}

/**
 * GET /comms/deliveries/export.csv — E10-2: the log under the current
 * filters as a file, streamed a thousand rows at a time under the cap.
 * Masked recipients only; the variables never leave, whatever the template.
 */
export async function exportDeliveriesHandler(req: Request, res: Response): Promise<void> {
  const parsed = exportDeliveriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { sort, ...filter } = parsed.data;

  // Logged before the first byte: an export that fails half-way was still an export.
  await logActivity(req.user!.sub, 'COMMS_DELIVERIES_EXPORTED', {
    req,
    module: MODULE,
    metadata: { filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() }, sort, cap: DELIVERY_EXPORT_ROW_CAP },
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="deliveries-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write(deliveryCsvHeader());
  for await (const rows of iterateDeliveryRows(filter, sort)) {
    res.write(rows.map(deliveryCsvLine).join(''));
  }
  res.end();
}

export async function getDeliveryHandler(req: Request, res: Response): Promise<void> {
  const params = deliveryIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  res.json({ success: true, data: await getDelivery(params.data.id) });
}

export async function resendDeliveryHandler(req: Request, res: Response): Promise<void> {
  const params = deliveryIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  const row = await resendDelivery(params.data.id);
  await logActivity(req.user!.sub, 'NOTIFICATION_RESENT', {
    req,
    module: MODULE,
    targetType: 'NotificationDelivery',
    targetId: row.id,
    metadata: { originalDeliveryId: params.data.id, templateKey: row.templateKey, channel: row.channel, status: row.status },
  });
  res.status(201).json({ success: true, data: row });
}

/* ── unsubscribe ─────────────────────────────────────────────────── */

/** GET /comms/unsubscribe/:token — a link in an email, so the answer is a page, not JSON. */
export async function unsubscribeHandler(req: Request, res: Response): Promise<void> {
  const params = unsubscribeParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'token');
  const { alreadyUnsubscribed } = await unsubscribe(params.data.token);
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>ADX</title></head><body style="font-family:sans-serif;padding:40px">` +
        `<h2>${alreadyUnsubscribed ? 'You were already unsubscribed' : 'You are unsubscribed'}</h2>` +
        `<p>ADX will not email you announcements. Messages about your own account, orders and payments still reach you.</p>` +
        `</body></html>`,
    );
}

/* ── delivery-report webhooks ────────────────────────────────────── */

function railWebhook(rail: SmsRailName) {
  return async (req: Request, res: Response): Promise<void> => {
    const url = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
    let reports;
    try {
      reports = await parseSmsDeliveryWebhook(rail, { body: req.body, headers: req.headers, url });
    } catch (err) {
      if (err instanceof WebhookRejected) throw new ApiError(401, 'UNAUTHORIZED', err.message);
      throw err;
    }
    const { matched } = await recordDeliveryReports(rail, reports);
    logger.info('SMS delivery report received', { rail, reports: reports.length, matched, requestId: req.requestId });
    res.json({ success: true, data: { received: reports.length, matched } });
  };
}

export const msg91WebhookHandler = railWebhook('msg91');
export const twilioWebhookHandler = railWebhook('twilio');
