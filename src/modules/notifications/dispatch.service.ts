import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../config/env';
import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { sendEmail as sendThroughDoor } from '../../shared/email';
import { isSmsKind, sendSms, type DeliveryReport, type SmsRailName } from '../../shared/sms';
import { getEffectiveLeadChannelsConfig } from '../../shared/integrations';
import { whatsappAdapter } from '../../shared/outreach';
import type { DeliveryAttempt, NotificationChannel, NotificationDelivery, NotificationTemplate, NotificationType, Prisma } from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';
import { dayWindowIST } from '../../shared/time';
import { getPlatformSettings } from '../app-config';
import { prismaCommsRepository as comms } from './prisma-comms.repository';
import {
  MAX_DELIVERY_ATTEMPTS,
  type CapSubject,
  type DeliveryFilter,
  type DeliverySlice,
  type Recipient,
  type TemplateFilter,
  type TemplateInput,
} from './comms.repository';
import { quietHoursDeferral, readDeferral, sampleVariablesFor, weekWindowIST } from './comms-rules';
import { createNotification, mayDeliver } from './notifications.service';
import { hashRecipient, looksLikeAddress, maskAddressesIn, maskDevices, maskRecipient } from './recipient';
import { prismaPushRepository as pushDevices } from './push/prisma-push.repository';
import { attemptPushDelivery } from './push/push-delivery';
import { DEFAULT_TEMPLATES, EVENT_REGISTRY, renderHtml, renderText, stringifyVars, variablesOf, type EventRegistryEntry, type TemplateVars } from './templates';
import type { NewNotification } from './notifications.types';

/**
 * The dispatcher — Lot E (Q87/Q147): one send path for everything that
 * leaves ADX.
 *
 * `notify` writes the in-app row exactly as `createNotification` always has,
 * and beside it one `NotificationDelivery` per outbound channel the ACTIVE
 * template for the event names and the person's preference allows. The row
 * carries the address masked and hashed and the variables, never the
 * rendered text — an OTP is not something the log should hold — and the
 * sender job (or the request itself, for an OTP) renders and sends it.
 *
 * The address itself has to live somewhere the sender can find it for a
 * retry, and the table is not that place. It sits in Redis under the
 * delivery id for two days: long enough for three attempts across an outage,
 * gone before the log is read by anyone.
 */

/**
 * G6 (Q103/133): PUSH is the third outbound channel — to every device the
 * person has registered. LH6: WHATSAPP is the fourth — the mobile on file,
 * through the outreach hub's BSP adapter (`shared/outreach`); a template's
 * `smsBody` is the text, or the card's approved template of the same key.
 */
export type OutboundChannel = 'EMAIL' | 'SMS' | 'PUSH' | 'WHATSAPP';
const OUTBOUND: readonly OutboundChannel[] = ['EMAIL', 'SMS', 'PUSH', 'WHATSAPP'];

export type SkipReason = 'NO_TEMPLATE' | 'NO_ADDRESS' | 'PREFERENCE_OFF' | 'UNSUBSCRIBED' | 'NO_SMS_KIND' | 'ACCOUNT_CLOSED' | 'WEEKLY_CAP' | 'NO_DEVICE';

export interface NotifyOptions {
  /** The in-app row, written through `createNotification`; needs a `userId`. */
  inApp?: Omit<NewNotification, 'userId'>;
  /** The kind the preference check is made against; defaults to the in-app row's, then SYSTEM. */
  type?: NotificationType;
  /** An address that is not the user's own — an invite to a stranger, a sale to an advertiser with no login. */
  recipient?: { email?: string | null | undefined; mobile?: string | null | undefined };
  /** Only these channels, whatever the template names — an announcement's own choice. */
  channels?: readonly NotificationChannel[];
  /** Send in the request rather than on the job's next tick — the OTPs. Failures still retry on the job. */
  immediate?: boolean;
}

export interface NotifyResult {
  notificationId: string | null;
  templateKey: string | null;
  /**
   * Lot G (Q117): a WEEKLY_CAP skip still has a row (SKIPPED, so the log
   * shows what was withheld); a quiet-hours deferral is a QUEUED row with a
   * `scheduledFor`.
   */
  deliveries: { channel: OutboundChannel; deliveryId: string | null; skipped?: SkipReason; scheduledFor?: Date }[];
}

const ADDRESS_KEY = (deliveryId: string) => `comms:addr:${deliveryId}`;
const ADDRESS_TTL_SECONDS = 48 * 60 * 60;

async function stashAddress(deliveryId: string, address: string): Promise<void> {
  try {
    await redis.set(ADDRESS_KEY(deliveryId), address, 'EX', ADDRESS_TTL_SECONDS);
  } catch (err) {
    logger.warn('Could not stash the delivery address', { deliveryId, reason: err instanceof Error ? err.message : String(err) });
  }
}

async function forgetAddress(deliveryId: string): Promise<void> {
  try {
    await redis.del(ADDRESS_KEY(deliveryId));
  } catch {
    /* a key that outlives its row expires on its own */
  }
}

function addressFor(recipient: { email?: string | null | undefined; mobile?: string | null | undefined } | null, channel: OutboundChannel): string | null {
  if (!recipient || channel === 'PUSH') return null;
  // WhatsApp goes to the same number an SMS would.
  const value = channel === 'EMAIL' ? recipient.email : recipient.mobile;
  return value && value.trim() ? value.trim() : null;
}

/** The address a row was queued for, or the person's current one if it still hashes the same. */
async function resolveAddress(row: NotificationDelivery): Promise<string | null> {
  try {
    const stashed = await redis.get(ADDRESS_KEY(row.id));
    if (stashed) return stashed;
  } catch {
    /* fall through to the user row */
  }
  if (!row.userId || (row.channel !== 'EMAIL' && row.channel !== 'SMS' && row.channel !== 'WHATSAPP')) return null;
  const recipient = await comms.findRecipient(row.userId);
  const current = addressFor(recipient, row.channel);
  if (!current) return null;
  return hashRecipient(row.channel, current) === row.recipientHash ? current : null;
}

/* ── notify ──────────────────────────────────────────────────────── */

/**
 * Lot G (Q117): what the two comms rules say about a non-transactional
 * message raised now for this subject — skip it (the week's cap is spent),
 * hold it (quiet hours) until `deferUntil`, or let it go. `sentThisWeek` is
 * the count the cap was judged on, so a caller writing several rows can
 * move the counter itself without a second read.
 */
export async function commsRuling(
  subject: CapSubject | null,
  now: Date,
  nonTransactionalKeys: readonly string[],
): Promise<{ skip: 'WEEKLY_CAP' | null; deferUntil: Date | null; sentThisWeek: number; cap: number }> {
  const { comms: rules } = await getPlatformSettings();
  let sentThisWeek = 0;
  if (subject) {
    const week = weekWindowIST(now);
    sentThisWeek = await comms.countDeliveriesInWindow(subject, week.start, week.end, nonTransactionalKeys);
    if (sentThisWeek >= rules.weeklyCapPerUser) return { skip: 'WEEKLY_CAP', deferUntil: null, sentThisWeek, cap: rules.weeklyCapPerUser };
  }
  return { skip: null, deferUntil: quietHoursDeferral(now, rules.quietHours), sentThisWeek, cap: rules.weeklyCapPerUser };
}

export async function notify(event: string, userId: string | null, vars: TemplateVars, opts: NotifyOptions = {}, now = new Date()): Promise<NotifyResult> {
  let notificationId: string | null = null;
  if (opts.inApp && userId) {
    const row = await createNotification({ userId, ...opts.inApp });
    notificationId = row.id;
  }

  const template = await comms.findActiveTemplate(event);
  if (!template) return { notificationId, templateKey: null, deliveries: [] };

  const type: NotificationType = opts.type ?? opts.inApp?.type ?? 'SYSTEM';
  const onFile: Recipient | null = opts.recipient ? null : userId ? await comms.findRecipient(userId) : null;
  const recipient = opts.recipient ?? onFile;
  const closed = Boolean(onFile && (onFile.closedAt !== null || !onFile.isActive));
  const unsubscribed = Boolean(onFile?.emailUnsubscribedAt);

  const wanted = template.channels.filter((c): c is OutboundChannel => (OUTBOUND as readonly string[]).includes(c));
  const allowed = opts.channels ? wanted.filter((c) => opts.channels!.includes(c)) : wanted;
  const deliveries: NotifyResult['deliveries'] = [];
  const created: NotificationDelivery[] = [];

  // Lot G (Q117): the quiet hours and the weekly cap govern non-transactional
  // copy only. The ruling is made once per call on the person's rows this
  // Indian week across every channel, then applied to each channel below,
  // the counter moving by the rows this call writes — so a message on two
  // channels spends two of the week's five, and the sixth is withheld.
  const governed = template.transactional === false;
  const nonTransactionalKeys = governed ? await comms.nonTransactionalTemplateKeys() : [];
  let ruling: Awaited<ReturnType<typeof commsRuling>> | null = null;
  let writtenHere = 0;

  for (const channel of allowed) {
    // G6: a push's "address" is the login itself; the devices behind it are
    // read here for the mask and again at send time, so a phone registered
    // between the two still hears it.
    const address = channel === 'PUSH' ? userId : addressFor(recipient ?? null, channel);
    if (!address) {
      deliveries.push({ channel, deliveryId: null, skipped: channel === 'PUSH' ? 'NO_DEVICE' : 'NO_ADDRESS' });
      continue;
    }
    if (closed) {
      deliveries.push({ channel, deliveryId: null, skipped: 'ACCOUNT_CLOSED' });
      continue;
    }
    let deviceCount = 0;
    if (channel === 'PUSH') {
      deviceCount = (await pushDevices.listForUser(address)).length;
      if (deviceCount === 0) {
        deliveries.push({ channel, deliveryId: null, skipped: 'NO_DEVICE' });
        continue;
      }
    }
    if (channel === 'SMS' && !isSmsKind(template.smsKind)) {
      deliveries.push({ channel, deliveryId: null, skipped: 'NO_SMS_KIND' });
      continue;
    }
    if (channel === 'EMAIL' && type === 'ANNOUNCEMENT' && unsubscribed) {
      deliveries.push({ channel, deliveryId: null, skipped: 'UNSUBSCRIBED' });
      continue;
    }
    if (userId && !(await mayDeliver(userId, type, channel))) {
      deliveries.push({ channel, deliveryId: null, skipped: 'PREFERENCE_OFF' });
      continue;
    }

    const recipientHash = hashRecipient(channel, address);
    const base = {
      userId,
      notificationId,
      templateKey: template.key,
      channel,
      recipientMasked: channel === 'PUSH' ? maskDevices(deviceCount) : maskRecipient(channel, address),
      recipientHash,
      variables: stringifyVars(vars) as Prisma.InputJsonValue,
    };

    if (governed) {
      ruling ??= await commsRuling(userId ? { userId } : { recipientHash }, now, nonTransactionalKeys);
      if (ruling.skip || ruling.sentThisWeek + writtenHere >= ruling.cap) {
        const row = await comms.createDelivery({ ...base, status: 'SKIPPED', lastError: 'WEEKLY_CAP' });
        deliveries.push({ channel, deliveryId: row.id, skipped: 'WEEKLY_CAP' });
        continue;
      }
      if (ruling.deferUntil) {
        // G10: the instant sits on the row's own column; the sender's pick reads it.
        const row = await comms.createDelivery({ ...base, scheduledFor: ruling.deferUntil });
        if (channel !== 'PUSH') await stashAddress(row.id, address);
        writtenHere += 1;
        deliveries.push({ channel, deliveryId: row.id, scheduledFor: ruling.deferUntil });
        continue;
      }
    }

    const row = await comms.createDelivery(base);
    if (channel !== 'PUSH') await stashAddress(row.id, address);
    writtenHere += 1;
    created.push(row);
    deliveries.push({ channel, deliveryId: row.id });
  }

  if (opts.immediate) {
    for (const row of created) {
      await attemptDelivery(row.id).catch((err: unknown) =>
        logger.warn('Immediate delivery attempt failed; the job will retry', { deliveryId: row.id, reason: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  return { notificationId, templateKey: template.key, deliveries };
}

/* ── sending ─────────────────────────────────────────────────────── */

/**
 * By the one door (`shared/email`'s `sendEmail` — AE-B): SMTP, Resend or
 * the Ethereal test inbox, as the integrations row says. An unconfigured
 * door still "sends" — the helper logs the message, which is how a
 * developer reads an invite link locally — but the row is marked SKIPPED
 * rather than SENT, because nothing left. The door's answer is mapped onto
 * the attempt row's fields: the provider in the log's lower-case spelling
 * (`smtp`, `resend`, `ethereal` — beside the SMS rails' `msg91`), and an
 * Ethereal preview URL appended to the response text so the Delivery log
 * shows where the message can be read.
 */
async function sendEmail(
  to: string,
  template: NotificationTemplate,
  vars: Record<string, string>,
): Promise<{ provider: string; configured: boolean; providerMessageId: string | null; responseText: string | null }> {
  const subject = renderText(template.subject ?? '', vars);
  const html = renderHtml(template.emailBody ?? '', vars);
  const result = await sendThroughDoor(to, subject, html);
  const responseText = result.previewUrl
    ? [result.response, `preview: ${result.previewUrl}`].filter(Boolean).join(' | ')
    : (result.response ?? null);
  return {
    provider: result.provider.toLowerCase(),
    configured: result.configured,
    providerMessageId: result.messageId ?? null,
    responseText,
  };
}

/**
 * LH6: WhatsApp through the outreach adapter. The card's approved template
 * of the same key goes when there is one (a business-initiated message
 * must be one); else the template's `smsBody` as free text, which the BSP
 * delivers only inside a customer-service window. `configured` false is a
 * SKIPPED row, the way an unconfigured email door is.
 */
async function sendWhatsApp(
  to: string,
  template: NotificationTemplate,
  vars: Record<string, string>,
): Promise<{ ok: true; provider: string; providerId: string | null; response: string | null } | { ok: false; code: 'NOT_CONFIGURED' | 'PROVIDER_ERROR'; message: string }> {
  const description = await whatsappAdapter.describe();
  if (!description.configured) return { ok: false, code: 'NOT_CONFIGURED', message: `WhatsApp is not configured (${description.missing.join(', ')} missing)` };
  const provider = `whatsapp:${description.provider ?? 'bsp'}`;
  const approved = (await getEffectiveLeadChannelsConfig()).whatsapp?.templates?.[template.key];
  const outcome = approved
    ? await whatsappAdapter.sendTemplate({ to, template: approved, values: vars })
    : await whatsappAdapter.sendText({ to, text: renderText(template.smsBody ?? template.pushBody ?? '', vars) });
  if (!outcome.ok) return outcome.code === 'NOT_CONFIGURED' ? { ok: false, code: 'NOT_CONFIGURED', message: outcome.message } : { ok: false, code: 'PROVIDER_ERROR', message: outcome.message };
  return { ok: true, provider, providerId: outcome.providerId, response: outcome.response };
}

/** Lot G (Q121): the rail's raw answer, cut to what a row holds, with any address inside it masked. */
export const ATTEMPT_RESPONSE_MAX = 1_000;

function attemptText(value: string | null | undefined): string | null {
  if (!value) return null;
  return maskAddressesIn(value).slice(0, ATTEMPT_RESPONSE_MAX);
}

/**
 * Lot G (Q121): one row per try, whatever the try came to. Never awaited
 * into the outcome — an attempt row that cannot be written is logged and
 * the delivery's own status still moves.
 */
async function recordAttempt(
  row: NotificationDelivery,
  attempt: number,
  outcome: { ok: boolean; provider?: string | null; providerMessageId?: string | null; responseText?: string | null; error?: string | null },
): Promise<void> {
  try {
    await comms.recordAttempt({
      deliveryId: row.id,
      attempt,
      provider: outcome.provider ?? null,
      providerMessageId: outcome.providerMessageId ?? null,
      ok: outcome.ok,
      responseText: attemptText(outcome.responseText),
      error: attemptText(outcome.error),
    });
  } catch (err) {
    logger.warn('Delivery attempt row not written', { deliveryId: row.id, attempt, reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One attempt on one QUEUED row. Success marks it SENT with the provider and
 * its message id; a failure leaves it QUEUED with the error until the third,
 * which marks it FAILED. A rail that declines the kind marks it SKIPPED —
 * that is not an error to retry. Lot G (Q121): every try leaves a
 * `DeliveryAttempt` row beside the outcome, carrying the rail's answer.
 */
export async function attemptDelivery(deliveryId: string, now = new Date()): Promise<NotificationDelivery | null> {
  const row = await comms.findDelivery(deliveryId);
  if (!row || row.status !== 'QUEUED') return row;
  if (row.channel !== 'EMAIL' && row.channel !== 'SMS' && row.channel !== 'PUSH' && row.channel !== 'WHATSAPP') {
    return comms.updateDelivery(row.id, { status: 'SKIPPED', lastError: 'CHANNEL_NOT_OUTBOUND' });
  }

  const attempts = row.attempts + 1;

  const template = row.templateKey ? await comms.findTemplateByKey(row.templateKey) : null;
  if (!template) {
    await forgetAddress(row.id);
    await recordAttempt(row, attempts, { ok: false, error: 'TEMPLATE_MISSING' });
    return comms.updateDelivery(row.id, { status: 'FAILED', attempts, lastError: 'TEMPLATE_MISSING' });
  }

  // G6: a push has no stashed address — the devices are read at send time.
  if (row.channel === 'PUSH') return attemptPushDelivery(row, template, attempts, now);

  const address = await resolveAddress(row);
  if (!address) {
    await forgetAddress(row.id);
    await recordAttempt(row, attempts, { ok: false, error: 'RECIPIENT_UNAVAILABLE' });
    return comms.updateDelivery(row.id, { status: 'FAILED', attempts, lastError: 'RECIPIENT_UNAVAILABLE' });
  }

  const vars = stringifyVars((row.variables ?? {}) as TemplateVars);

  try {
    if (row.channel === 'EMAIL') {
      const { provider, configured, providerMessageId, responseText } = await sendEmail(address, template, vars);
      await forgetAddress(row.id);
      if (!configured) {
        await recordAttempt(row, attempts, { ok: false, provider, error: 'EMAIL_UNCONFIGURED' });
        return await comms.updateDelivery(row.id, { status: 'SKIPPED', attempts, provider, lastError: 'EMAIL_UNCONFIGURED' });
      }
      await recordAttempt(row, attempts, { ok: true, provider, providerMessageId, responseText });
      return await comms.updateDelivery(row.id, { status: 'SENT', attempts, provider, providerMessageId, lastError: null, sentAt: now });
    }

    if (row.channel === 'WHATSAPP') {
      const outcome = await sendWhatsApp(address, template, vars);
      await forgetAddress(row.id);
      if (!outcome.ok) {
        const skipped = outcome.code === 'NOT_CONFIGURED';
        await recordAttempt(row, attempts, { ok: false, provider: 'whatsapp', error: skipped ? 'WHATSAPP_UNCONFIGURED' : outcome.message });
        if (skipped) return await comms.updateDelivery(row.id, { status: 'SKIPPED', attempts, provider: 'whatsapp', lastError: 'WHATSAPP_UNCONFIGURED' });
        throw new Error(outcome.message);
      }
      await recordAttempt(row, attempts, { ok: true, provider: outcome.provider, providerMessageId: outcome.providerId, responseText: outcome.response });
      return await comms.updateDelivery(row.id, { status: 'SENT', attempts, provider: outcome.provider, providerMessageId: outcome.providerId, lastError: null, sentAt: now });
    }

    const smsKind = template.smsKind;
    if (!isSmsKind(smsKind)) {
      await forgetAddress(row.id);
      await recordAttempt(row, attempts, { ok: false, error: 'NO_SMS_KIND' });
      return await comms.updateDelivery(row.id, { status: 'SKIPPED', attempts, lastError: 'NO_SMS_KIND' });
    }
    const result = await sendSms({ to: address, kind: smsKind, vars, body: renderText(template.smsBody ?? '', vars) });
    await forgetAddress(row.id);
    if (result.skipped) {
      await recordAttempt(row, attempts, { ok: false, error: result.reason });
      return await comms.updateDelivery(row.id, { status: 'SKIPPED', attempts, lastError: result.reason });
    }
    await recordAttempt(row, attempts, { ok: true, provider: result.rail, providerMessageId: result.providerMessageId, responseText: result.responseText ?? null });
    return await comms.updateDelivery(row.id, {
      status: 'SENT',
      attempts,
      provider: result.rail,
      providerMessageId: result.providerMessageId,
      lastError: null,
      sentAt: now,
    });
  } catch (err) {
    const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    if (exhausted) await forgetAddress(row.id);
    logger.warn('Delivery attempt failed', { deliveryId: row.id, channel: row.channel, attempts, exhausted, lastError });
    await recordAttempt(row, attempts, { ok: false, error: lastError });
    return comms.updateDelivery(row.id, { status: exhausted ? 'FAILED' : 'QUEUED', attempts, lastError });
  }
}

/** G10: how many legacy-marker rows one tick folds onto the column. */
export const LEGACY_DEFERRAL_FOLD_BATCH = 500;

/**
 * G10, one release: a row deferred before `scheduledFor` existed carries its
 * instant as `QUIET_HOURS until <iso>` in `lastError`. This moves it onto the
 * column and clears the marker, so the pick below treats it like any other
 * deferral. A marker that does not parse is scheduled for now rather than
 * left stuck. On most ticks the read finds nothing; once every such row has
 * been folded this step and the marker can go.
 */
export async function foldLegacyDeferrals(now = new Date()): Promise<number> {
  const rows = await comms.findLegacyDeferred(LEGACY_DEFERRAL_FOLD_BATCH);
  for (const row of rows) {
    await comms.updateDelivery(row.id, { scheduledFor: readDeferral(row.lastError) ?? now, lastError: null });
  }
  return rows.length;
}

/** The job's tick: every QUEUED row under the cap whose `scheduledFor` has passed (or is null), oldest first. */
export async function sendQueuedDeliveries(limit = 200, now = new Date()): Promise<{ picked: number; sent: number; failed: number; skipped: number; retry: number; folded: number }> {
  const folded = await foldLegacyDeferrals(now);
  const rows = await comms.findQueued(limit, now);
  const tally = { picked: rows.length, sent: 0, failed: 0, skipped: 0, retry: 0, folded };
  for (const row of rows) {
    const after = await attemptDelivery(row.id, now).catch((err: unknown) => {
      logger.error('Delivery attempt threw', { deliveryId: row.id, reason: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (after?.status === 'SENT') tally.sent += 1;
    else if (after?.status === 'FAILED') tally.failed += 1;
    else if (after?.status === 'SKIPPED') tally.skipped += 1;
    else tally.retry += 1;
  }
  return tally;
}

/* ── retention ───────────────────────────────────────────────────── */

export const VARIABLE_RETENTION_DAYS = 90;
export const SENSITIVE_VARIABLE_RETENTION_DAYS = 7;
export const DELIVERY_RETENTION_DAYS = 180;

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/** Nightly: variables go at 90 days (7 for a sensitive template), the rows at 180. */
export async function purgeDeliveries(now = new Date()): Promise<{ sensitive: number; standard: number; deleted: number }> {
  const sensitiveKeys = await comms.sensitiveTemplateKeys();
  const sensitive = sensitiveKeys.length ? await comms.purgeVariables(daysAgo(now, SENSITIVE_VARIABLE_RETENTION_DAYS), now, sensitiveKeys) : 0;
  const standard = await comms.purgeVariables(daysAgo(now, VARIABLE_RETENTION_DAYS), now);
  const deleted = await comms.deleteCreatedBefore(daysAgo(now, DELIVERY_RETENTION_DAYS));
  return { sensitive, standard, deleted };
}

/* ── delivery reports ────────────────────────────────────────────── */

/** A rail's report, matched on the message id it gave us at send time. Unknown ids are ignored. */
export async function recordDeliveryReports(rail: SmsRailName, reports: DeliveryReport[], now = new Date()): Promise<{ matched: number }> {
  let matched = 0;
  for (const report of reports) {
    const row = await comms.findByProviderMessageId(rail, report.providerMessageId);
    if (!row) continue;
    matched += 1;
    if (report.status === 'DELIVERED') {
      await comms.updateDelivery(row.id, { status: 'DELIVERED', deliveredAt: report.at ?? now, lastError: null });
    } else if (report.status === 'FAILED') {
      await comms.updateDelivery(row.id, { status: 'FAILED', lastError: (report.error ?? 'Rejected by the operator').slice(0, 500) });
    }
    // SENT: still in flight; the row already says so.
  }
  return { matched };
}

/* ── templates ───────────────────────────────────────────────────── */

/**
 * At boot: the shipped copy, written once by key and never overwritten. Lot G
 * (Q117): a seeded row nobody has edited also takes the seed's
 * `transactional` flag, since the column arrived defaulting to true.
 */
export async function ensureTemplates(): Promise<number> {
  const written = await comms.ensureTemplates(DEFAULT_TEMPLATES);
  if (written > 0) logger.info('Notification templates seeded', { written });
  const flagged = await comms.ensureTransactionalFlags(
    DEFAULT_TEMPLATES.filter((seed) => seed.transactional === false).map((seed) => ({ key: seed.key, transactional: false })),
  );
  if (flagged > 0) logger.info('Notification templates marked non-transactional', { flagged });
  return written;
}

export function listTemplates(filter: TemplateFilter, page: ListQuery) {
  return comms.listTemplates(filter, page);
}

/* ── template figures (E10-2) ────────────────────────────────────── */

export const TEMPLATE_STATS_DAYS = 30;

/**
 * A template's last thirty Indian days, from the delivery log.
 *
 * `sent30d` is the rows that left — SENT, or DELIVERED once a rail confirmed
 * it; `delivered30d` the confirmed subset (email has no report, so it stays
 * at zero there — that is the rail's silence, not a failure); `failed30d`
 * the rows the sender gave up on. `deliveryRate` is the share of attempts
 * that got out, `sent / (sent + failed)`, to two places; null before a
 * template has been attempted at all. QUEUED and SKIPPED rows count nowhere:
 * one is not decided yet and the other never tried.
 */
export interface TemplateStats {
  sent30d: number;
  delivered30d: number;
  failed30d: number;
  deliveryRate: number | null;
}

const EMPTY_STATS = (): TemplateStats => ({ sent30d: 0, delivered30d: 0, failed30d: 0, deliveryRate: null });

/** The window's first instant: the IST midnight `TEMPLATE_STATS_DAYS - 1` days back, so today is the thirtieth day. */
export function templateStatsSince(now = new Date()): Date {
  const { start } = dayWindowIST(now);
  return new Date(start.getTime() - (TEMPLATE_STATS_DAYS - 1) * 24 * 60 * 60 * 1000);
}

/** One grouped query for the page: every template's figures, keyed by template key. */
export async function templateStats(now = new Date()): Promise<Record<string, TemplateStats>> {
  const rows = await comms.templateStats(templateStatsSince(now));
  const out: Record<string, TemplateStats> = {};
  for (const row of rows) {
    const stats = (out[row.templateKey] ??= EMPTY_STATS());
    if (row.status === 'SENT' || row.status === 'DELIVERED') stats.sent30d += row.count;
    if (row.status === 'DELIVERED') stats.delivered30d += row.count;
    if (row.status === 'FAILED') stats.failed30d += row.count;
  }
  for (const stats of Object.values(out)) {
    const attempted = stats.sent30d + stats.failed30d;
    stats.deliveryRate = attempted === 0 ? null : Math.round((stats.sent30d / attempted) * 100) / 100;
  }
  return out;
}

/** The figures for one key, zeros where the log has nothing. */
export const statsFor = (all: Record<string, TemplateStats>, key: string): TemplateStats => all[key] ?? EMPTY_STATS();

/* ── the events catalogue (E10-2) ────────────────────────────────── */

export interface EventCatalogueEntry extends EventRegistryEntry {
  /** The templates in the table that answer this event, ACTIVE or not. */
  templates: { key: string; status: string; channels: string[] }[];
}

/**
 * Every event the code raises, the variables it supplies, and the copy on
 * file for it — the console's picker and the template editor's hints. A
 * template whose event is in the table but not in the registry is listed
 * last under its own event with no variables: copy nothing raises.
 */
export async function eventCatalogue(): Promise<EventCatalogueEntry[]> {
  const templates = await comms.allTemplates();
  const byEvent = new Map<string, EventCatalogueEntry['templates']>();
  for (const t of templates) {
    const list = byEvent.get(t.event) ?? [];
    list.push({ key: t.key, status: t.status, channels: [...t.channels] });
    byEvent.set(t.event, list);
  }
  const catalogue: EventCatalogueEntry[] = EVENT_REGISTRY.map((entry) => ({ ...entry, templates: byEvent.get(entry.event) ?? [] }));
  const known = new Set(EVENT_REGISTRY.map((entry) => entry.event));
  for (const [event, list] of byEvent) {
    if (known.has(event)) continue;
    catalogue.push({ event, variables: [], raisedBy: [], via: 'notify', note: 'No code raises this event.', templates: list });
  }
  return catalogue;
}

export async function getTemplate(key: string): Promise<NotificationTemplate> {
  const template = await comms.findTemplateByKey(key);
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Template not found');
  return template;
}

function assertTemplateShape(data: Partial<TemplateInput>, merged: Pick<TemplateInput, 'channels' | 'smsKind' | 'emailBody' | 'smsBody'>): void {
  if (merged.channels.includes('SMS') && !isSmsKind(merged.smsKind)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'An SMS template needs a registered smsKind', { smsKind: merged.smsKind ?? null });
  }
  if (merged.channels.includes('EMAIL') && !merged.emailBody) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'An email template needs an emailBody');
  }
  if (merged.channels.includes('SMS') && !merged.smsBody) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'An SMS template needs its registered smsBody');
  }
  void data;
}

export async function createTemplate(data: TemplateInput, actorId: string): Promise<NotificationTemplate> {
  if (await comms.findTemplateByKey(data.key)) throw new ApiError(409, 'CONFLICT', 'A template with that key already exists');
  assertTemplateShape(data, { channels: data.channels, smsKind: data.smsKind, emailBody: data.emailBody, smsBody: data.smsBody });
  return comms.createTemplate({ ...data, updatedById: actorId });
}

export async function updateTemplate(key: string, patch: Partial<TemplateInput>, actorId: string): Promise<{ before: NotificationTemplate; after: NotificationTemplate }> {
  const before = await getTemplate(key);
  const merged = {
    channels: patch.channels ?? before.channels,
    smsKind: patch.smsKind === undefined ? before.smsKind : patch.smsKind,
    emailBody: patch.emailBody === undefined ? before.emailBody : patch.emailBody,
    smsBody: patch.smsBody === undefined ? before.smsBody : patch.smsBody,
  };
  assertTemplateShape(patch, merged);
  const after = await comms.updateTemplate(key, { ...patch, updatedById: actorId });
  return { before, after };
}

/* ── the delivery log ────────────────────────────────────────────── */

export interface DeliveryListInput extends Omit<DeliveryFilter, 'maskedContains' | 'recipientHash'> {
  q?: string | undefined;
}

/** `q` is an exact address (hashed and matched) or a fragment of a mask. */
export function deliveryFilterFrom(input: DeliveryListInput): DeliveryFilter {
  const { q, ...rest } = input;
  if (!q) return rest;
  const address = looksLikeAddress(q);
  if (address) return { ...rest, recipientHash: hashRecipient(address.channel, address.address) };
  if (/^[0-9a-f]{64}$/i.test(q)) return { ...rest, recipientHash: q.toLowerCase() };
  return { ...rest, maskedContains: q };
}

/**
 * A sensitive template's variables are a credential while they live (an OTP,
 * a payment link), so the log shows a reader which variables were sent and
 * never their values — a comms desk must not be able to read a second
 * factor. The row itself keeps the values for the sender's retries and the
 * 7-day purge; only the read is masked.
 */
export const REDACTED_VALUE = '•••';

async function redactSensitive<T extends Pick<NotificationDelivery, 'templateKey' | 'variables'>>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const sensitive = new Set(await comms.sensitiveTemplateKeys());
  return rows.map((row) => {
    if (!row.templateKey || !sensitive.has(row.templateKey) || !row.variables || typeof row.variables !== 'object') return row;
    const masked = Object.fromEntries(Object.keys(row.variables as Record<string, unknown>).map((key) => [key, REDACTED_VALUE]));
    return { ...row, variables: masked };
  });
}

export async function listDeliveries(input: DeliveryListInput, page: ListQuery) {
  const result = await comms.listDeliveries(deliveryFilterFrom(input), page);
  // Lot G (Q117) / G10: every row carries `scheduledFor` — the quiet-hours deferral, or null.
  return { ...result, items: await redactSensitive(result.items) };
}

/* ── the export (E10-2) ──────────────────────────────────────────── */

/** The export walks the same query a slice at a time and stops here regardless of the filter. */
export const DELIVERY_EXPORT_ROW_CAP = 50_000;
export const DELIVERY_EXPORT_BATCH = 1_000;

/** What leaves in the CSV: the masked recipient, never the variables — the log's rule, on paper. */
export const DELIVERY_CSV_COLUMNS = [
  'id',
  'createdAt',
  'templateKey',
  'channel',
  'status',
  'recipientMasked',
  'userId',
  'notificationId',
  'attempts',
  'provider',
  'providerMessageId',
  'lastError',
  'sentAt',
  'deliveredAt',
] as const;

/**
 * Rows for the export, in batches, never more than the cap — an async
 * generator so the controller streams each batch as it arrives rather than
 * holding fifty thousand rows before the first byte leaves.
 *
 * E12-B: the walk is by keyset — each slice continues strictly past the
 * last row of the one before under the fixed (createdAt, id) order — never
 * skip/take. The sender writes rows while a file streams; under an offset a
 * row landing ahead of the cursor pushed the row at the boundary into the
 * next slice a second time (newest first) or out of the file altogether
 * (oldest first). A row landing behind the cursor is rightly not in a file
 * that had already passed its place.
 */
export async function* iterateDeliveryRows(
  input: DeliveryListInput,
  sort: DeliverySlice['sort'],
  cap = DELIVERY_EXPORT_ROW_CAP,
): AsyncGenerator<NotificationDelivery[], void, void> {
  const filter = deliveryFilterFrom(input);
  let written = 0;
  let after: DeliverySlice['after'];
  while (written < cap) {
    const take = Math.min(DELIVERY_EXPORT_BATCH, cap - written);
    const rows = await comms.findDeliveryRows(filter, { take, sort, ...(after ? { after } : {}) });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < take) return;
    written += rows.length;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
  }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function deliveryCsvHeader(): string {
  return `${DELIVERY_CSV_COLUMNS.join(',')}\r\n`;
}

/**
 * One row — the columns above and nothing else; `variables` and the hash
 * never reach the file. E12-B: `lastError` is the provider's own words, and
 * a provider quotes the mailbox or the number it failed to reach — so any
 * address inside it leaves masked the way the recipient column is.
 */
export function deliveryCsvLine(row: NotificationDelivery): string {
  return `${DELIVERY_CSV_COLUMNS.map((column) => csvCell(column === 'lastError' && row.lastError ? maskAddressesIn(row.lastError) : row[column])).join(',')}\r\n`;
}

async function loadDelivery(id: string): Promise<NotificationDelivery> {
  const row = await comms.findDelivery(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Delivery not found');
  return row;
}

/**
 * The desk's read: a sensitive template's variable values are masked. Lot G:
 * `scheduledFor` (Q117, on the row itself) and `attemptRows` (Q121) — every
 * try, oldest first, with the rail's answer as it came, addresses masked.
 */
export async function getDelivery(id: string): Promise<NotificationDelivery & { attemptRows: DeliveryAttempt[] }> {
  const [row] = await redactSensitive([await loadDelivery(id)]);
  const attemptRows = await comms.findAttempts(id);
  return { ...row!, attemptRows };
}

/* ── the test send (Lot G, Q117) ─────────────────────────────────── */

/** The test send is email and SMS only — the operator's own addresses; a push has no address to own. */
export type TestSendChannel = 'EMAIL' | 'SMS';

export interface TestSendResult {
  templateKey: string;
  variables: Record<string, string>;
  deliveries: { channel: TestSendChannel; deliveryId: string | null; status: string | null; skipped?: 'NO_ADDRESS' | 'NO_SMS_KIND' }[];
}

/**
 * The template rendered with sample variables and sent to the operator's
 * **own** email and mobile — the addresses on their user row, never one the
 * request names. Any status of template (a DRAFT is what one tests), any
 * sensitivity (the variables are samples, not credentials). Bypasses the
 * preference matrix, the quiet hours and the weekly cap: the operator asked
 * for it, now. The rows are ordinary deliveries — they show in the log with
 * the operator as the recipient — attempted in the request.
 */
export async function sendTestTemplate(key: string, operatorId: string, channels?: readonly TestSendChannel[]): Promise<TestSendResult> {
  const template = await getTemplate(key);
  const operator = await comms.findRecipient(operatorId);
  if (!operator) throw new ApiError(404, 'NOT_FOUND', 'Operator not found');

  const variables = sampleVariablesFor(variablesOf(template.subject, template.emailBody, template.smsBody, template.pushTitle, template.pushBody));
  const wanted = template.channels.filter((c): c is TestSendChannel => c === 'EMAIL' || c === 'SMS');
  const chosen = channels ? wanted.filter((c) => channels.includes(c)) : wanted;
  if (chosen.length === 0) throw new ApiError(409, 'CONFLICT', 'This template names no outbound channel to test', { channels: template.channels });

  const deliveries: TestSendResult['deliveries'] = [];
  for (const channel of chosen) {
    const address = addressFor(operator, channel);
    if (!address) {
      deliveries.push({ channel, deliveryId: null, status: null, skipped: 'NO_ADDRESS' });
      continue;
    }
    if (channel === 'SMS' && !isSmsKind(template.smsKind)) {
      deliveries.push({ channel, deliveryId: null, status: null, skipped: 'NO_SMS_KIND' });
      continue;
    }
    const row = await comms.createDelivery({
      userId: operatorId,
      notificationId: null,
      templateKey: template.key,
      channel,
      recipientMasked: maskRecipient(channel, address),
      recipientHash: hashRecipient(channel, address),
      variables: variables as Prisma.InputJsonValue,
    });
    await stashAddress(row.id, address);
    const after = await attemptDelivery(row.id).catch((err: unknown) => {
      logger.warn('Test send attempt failed; the job will retry', { deliveryId: row.id, reason: err instanceof Error ? err.message : String(err) });
      return row;
    });
    deliveries.push({ channel, deliveryId: row.id, status: after?.status ?? row.status });
  }
  if (deliveries.every((d) => d.deliveryId === null)) {
    throw new ApiError(409, 'CONFLICT', 'You have no address on file for the channels this template names', { deliveries });
  }
  return { templateKey: template.key, variables, deliveries };
}

/**
 * A fresh row for the same person and the same variables, sent now.
 * Refused for a sensitive template: an OTP or a payment link re-sent from a
 * desk is a phishing tool, and the variables are purged in a week anyway.
 */
export async function resendDelivery(id: string): Promise<NotificationDelivery> {
  const original = await loadDelivery(id);
  if (original.channel !== 'EMAIL' && original.channel !== 'SMS' && original.channel !== 'PUSH') {
    throw new ApiError(409, 'CONFLICT', 'Only email, SMS and push deliveries can be resent');
  }
  const template = original.templateKey ? await comms.findTemplateByKey(original.templateKey) : null;
  if (!template) throw new ApiError(409, 'CONFLICT', 'The template behind this delivery no longer exists');
  if (template.isSensitive) throw new ApiError(409, 'CONFLICT', 'A sensitive message is never resent from the log', { templateKey: template.key });
  if (original.purgedAt || original.variables === null) throw new ApiError(409, 'CONFLICT', 'The variables of this delivery were purged');

  // G6: a push resend goes to whatever devices the person holds now; there is no address to resolve.
  const address = original.channel === 'PUSH' ? null : await resolveAddress(original);
  if (original.channel !== 'PUSH' && !address) throw new ApiError(409, 'CONFLICT', 'The recipient address is no longer available for this delivery');

  const row = await comms.createDelivery({
    userId: original.userId,
    notificationId: original.notificationId,
    templateKey: template.key,
    channel: original.channel,
    recipientMasked: original.recipientMasked,
    recipientHash: original.recipientHash,
    variables: original.variables as Prisma.InputJsonValue,
  });
  if (address) await stashAddress(row.id, address);
  return (await attemptDelivery(row.id)) ?? row;
}

/* ── unsubscribe ─────────────────────────────────────────────────── */

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function unsubscribeSignature(userId: string): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`unsubscribe:${userId}`).digest('base64url');
}

export function unsubscribeToken(userId: string): string {
  return `${b64url(userId)}.${unsubscribeSignature(userId)}`;
}

/** The user the token names, or null when it was not minted here. */
export function readUnsubscribeToken(token: string): string | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  let userId: string;
  try {
    userId = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!userId) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(unsubscribeSignature(userId));
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

export function publicBaseUrl(): string {
  return (env.BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
}

export function unsubscribeUrlFor(userId: string): string {
  return `${publicBaseUrl()}/api/v1/comms/unsubscribe/${unsubscribeToken(userId)}`;
}

/** Stamps `User.emailUnsubscribedAt`. Idempotent; a bad token is a 404, not a hint. */
export async function unsubscribe(token: string, now = new Date()): Promise<{ userId: string; alreadyUnsubscribed: boolean }> {
  const userId = readUnsubscribeToken(token);
  if (!userId) throw new ApiError(404, 'NOT_FOUND', 'This unsubscribe link is not valid');
  const changed = await comms.markEmailUnsubscribed(userId, now);
  return { userId, alreadyUnsubscribed: !changed };
}
