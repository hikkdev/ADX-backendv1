import { logger } from '../../../shared/logging';
import type { NotificationDelivery, NotificationTemplate } from '../../../shared/database';
import { MAX_DELIVERY_ATTEMPTS } from '../comms.repository';
import { prismaCommsRepository as comms } from '../prisma-comms.repository';
import { getNotificationById } from '../notifications.service';
import { renderText, stringifyVars, type TemplateVars } from '../templates';
import { sendPushToUser, type PushOutcome } from './push.service';

/**
 * One attempt on a PUSH delivery — G6 (Q103/133), the dispatcher's third
 * channel.
 *
 * What the phone shows: the template's `pushTitle` and `pushBody` (G10 —
 * push copy edited on its own, the same `{{vars}}`) when set, else its
 * `subject` as the title and its `smsBody` (plain text) as the body —
 * falling back to the in-app row's own title and message when the delivery
 * sits beside one, so a template that names PUSH with no copy of its own
 * still says what the feed says. The data payload carries the event, the notification id and
 * what it relates to, so a tap opens the right screen.
 *
 * The outcome is judged over every device: one delivered is SENT; none
 * delivered and something worth retrying (the rail down, the quota hit, the
 * bearer refused) is QUEUED until the cap, then FAILED; every device stale
 * or malformed is FAILED at once — there is nothing to retry to. No devices
 * at all, or no Firebase configuration, is SKIPPED: not an error.
 */

export const PUSH_PROVIDER = 'fcm';

/** The per-device tally, as the attempt row holds it. Token suffixes only. */
function summarise(outcome: PushOutcome): string {
  return JSON.stringify({
    devices: outcome.devices,
    sent: outcome.sent,
    unregistered: outcome.unregistered,
    retryable: outcome.retryable,
    failed: outcome.failed,
    results: outcome.results,
  }).slice(0, 1_000);
}

async function recordPushAttempt(row: NotificationDelivery, attempt: number, outcome: PushOutcome | null, error: string | null): Promise<void> {
  try {
    await comms.recordAttempt({
      deliveryId: row.id,
      attempt,
      provider: PUSH_PROVIDER,
      providerMessageId: outcome?.messageId ?? null,
      ok: Boolean(outcome && outcome.sent > 0),
      responseText: outcome ? summarise(outcome) : null,
      error,
    });
  } catch (err) {
    logger.warn('Push attempt row not written', { deliveryId: row.id, attempt, reason: err instanceof Error ? err.message : String(err) });
  }
}

export async function attemptPushDelivery(
  row: NotificationDelivery,
  template: NotificationTemplate,
  attempts: number,
  now: Date,
): Promise<NotificationDelivery> {
  if (!row.userId) {
    await recordPushAttempt(row, attempts, null, 'RECIPIENT_UNAVAILABLE');
    return comms.updateDelivery(row.id, { status: 'FAILED', attempts, lastError: 'RECIPIENT_UNAVAILABLE' });
  }

  const vars = stringifyVars((row.variables ?? {}) as TemplateVars);
  const inApp = row.notificationId ? await getNotificationById(row.notificationId) : null;
  const rendered = (text: string | null | undefined) => (text ? renderText(text, vars) : '').trim();
  const title = rendered(template.pushTitle) || rendered(template.subject) || inApp?.title || 'ADX';
  const body = rendered(template.pushBody) || rendered(template.smsBody) || inApp?.message || inApp?.subtitle || '';

  const data: Record<string, string> = { type: template.event, deliveryId: row.id };
  // Lot N: a raise may name the screen a tap should open (`adx://…`) in its
  // variables; the phone reads it ahead of `relatedType` / `relatedId`.
  const deepLink = vars['deepLink'];
  if (typeof deepLink === 'string' && deepLink.startsWith('adx://')) data['deepLink'] = deepLink;
  if (inApp) {
    data['notificationId'] = inApp.id;
    data['notificationType'] = inApp.type;
    if (inApp.relatedType) data['relatedType'] = inApp.relatedType;
    if (inApp.relatedId) data['relatedId'] = inApp.relatedId;
  }

  let outcome: PushOutcome;
  try {
    outcome = await sendPushToUser(row.userId, { notification: { title, body }, data });
  } catch (err) {
    const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    logger.warn('Push attempt failed', { deliveryId: row.id, attempts, exhausted, lastError });
    await recordPushAttempt(row, attempts, null, lastError);
    return comms.updateDelivery(row.id, { status: exhausted ? 'FAILED' : 'QUEUED', attempts, lastError });
  }

  if (outcome.skipped) {
    await recordPushAttempt(row, attempts, outcome, outcome.skipped);
    return comms.updateDelivery(row.id, { status: 'SKIPPED', attempts, provider: PUSH_PROVIDER, lastError: outcome.skipped });
  }
  if (outcome.sent > 0) {
    await recordPushAttempt(row, attempts, outcome, null);
    return comms.updateDelivery(row.id, {
      status: 'SENT',
      attempts,
      provider: PUSH_PROVIDER,
      providerMessageId: outcome.messageId,
      lastError: null,
      sentAt: now,
    });
  }
  if (outcome.retryable > 0) {
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const lastError = `FCM_UNAVAILABLE: ${outcome.results.find((r) => !r.ok)?.error ?? 'no device answered'}`.slice(0, 500);
    await recordPushAttempt(row, attempts, outcome, lastError);
    return comms.updateDelivery(row.id, { status: exhausted ? 'FAILED' : 'QUEUED', attempts, provider: PUSH_PROVIDER, lastError });
  }
  // Every device was stale or malformed; the stale ones are gone already.
  await recordPushAttempt(row, attempts, outcome, 'NO_VALID_DEVICE');
  return comms.updateDelivery(row.id, { status: 'FAILED', attempts, provider: PUSH_PROVIDER, lastError: 'NO_VALID_DEVICE' });
}
