import { logger } from '../logging/logger';
import { env } from '../../config/env';
import { getEffectiveSmsConfig } from '../integrations/integration-config';
import { isSmsRailName, type SmsKind, type SmsKindRegistration, type SmsRailName } from './kinds';
import { renderSmsBody, toE164, type DeliveryReport, type DeliveryWebhookInput, type SmsRail } from './rail';
import { msg91Rail } from './rails/msg91';
import { twilioRail } from './rails/twilio';
import { thirdRail } from './rails/third';

/**
 * The one door an SMS leaves by — Lot E (Q128/Q147).
 *
 * A caller names a **kind**, never a body: the kind is a DLT-registered
 * message, and the rail in use renders it from its own registration. The
 * primary rail comes from the credentials row; when it throws, the fallbacks
 * are tried in order, each only if it has the kind registered and its keys on
 * file. A kind registered nowhere is logged and skipped — the operator would
 * reject the text anyway, and ADX would be billed for the attempt.
 *
 * Outside production the message is logged instead of sent unless
 * `SMS_LIVE_IN_DEV` says otherwise: the OTP already reaches the developer on
 * the terminal and in the response, so a live send buys nothing and costs a
 * failure mode.
 */

export interface SendSmsInput {
  to: string;
  kind: SmsKind;
  /** Values are stringified before they reach a rail. */
  vars?: Record<string, string | number | boolean | null | undefined>;
  /**
   * The rendered text, for a rail that posts text rather than variables.
   * Rendered from the registration's `body` when the caller gives none.
   */
  body?: string;
}

export type SendSmsResult =
  | { skipped: false; rail: SmsRailName; providerMessageId: string | null; responseText?: string | null }
  | { skipped: true; reason: 'DEV' | 'UNREGISTERED_KIND' | 'NO_RAIL' };

const RAILS: Record<SmsRailName, SmsRail> = {
  msg91: msg91Rail,
  twilio: twilioRail,
  third: thirdRail,
};

export function smsRail(name: SmsRailName): SmsRail {
  return RAILS[name];
}

function stringifyVars(vars: SendSmsInput['vars']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/** The rails to try for a kind, in order: primary first, then the fallbacks, each once. */
export async function railOrderFor(kind: SmsKind): Promise<{ rail: SmsRailName; registration: SmsKindRegistration }[]> {
  const cfg = await getEffectiveSmsConfig();
  const names: SmsRailName[] = [];
  const push = (name: unknown) => {
    if (isSmsRailName(name) && !names.includes(name)) names.push(name);
  };
  push(cfg.primaryRail);
  for (const name of cfg.fallbackRails ?? []) push(name);

  const order: { rail: SmsRailName; registration: SmsKindRegistration }[] = [];
  for (const rail of names) {
    const registration = cfg.templates?.[rail]?.[kind];
    if (registration?.templateId) order.push({ rail, registration });
  }
  return order;
}

/** Whether any rail in the routing order can carry this kind. */
export async function isSmsKindRegistered(kind: SmsKind): Promise<boolean> {
  return (await railOrderFor(kind)).length > 0;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const to = toE164(input.to);
  const vars = stringifyVars(input.vars);

  if (env.NODE_ENV !== 'production' && !env.SMS_LIVE_IN_DEV) {
    logger.info(`[SMS DEV] -> ${to}: ${input.kind}`, { vars, body: input.body });
    return { skipped: true, reason: 'DEV' };
  }

  const order = await railOrderFor(input.kind);
  if (order.length === 0) {
    logger.warn('SMS skipped: kind is not registered on any rail', { kind: input.kind });
    return { skipped: true, reason: 'UNREGISTERED_KIND' };
  }

  const cfg = await getEffectiveSmsConfig();
  const dlt = { entityId: cfg.dltEntityId, senderId: cfg.senderId };
  let lastError: unknown = null;
  let tried = 0;

  for (const { rail, registration } of order) {
    const adapter = RAILS[rail];
    const { configured } = await adapter.describe();
    if (!configured) {
      logger.warn('SMS rail skipped: not configured', { rail, kind: input.kind });
      continue;
    }
    tried += 1;
    const body = input.body ?? (registration.body ? renderSmsBody(registration.body, vars) : '');
    try {
      const { providerMessageId, responseText } = await adapter.send({ to, kind: input.kind, registration, vars, body, dlt });
      return { skipped: false, rail, providerMessageId, responseText: responseText ?? null };
    } catch (err) {
      lastError = err;
      logger.warn('SMS rail failed; trying the next', { rail, kind: input.kind, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (tried === 0) {
    logger.warn('SMS skipped: no configured rail carries this kind', { kind: input.kind });
    return { skipped: true, reason: 'NO_RAIL' };
  }
  throw lastError instanceof Error ? lastError : new Error('SMS delivery failed on every rail');
}

/** The webhook door: one rail's delivery report read into the common shape. */
export async function parseSmsDeliveryWebhook(rail: SmsRailName, input: DeliveryWebhookInput): Promise<DeliveryReport[]> {
  return RAILS[rail].parseDeliveryWebhook(input);
}
