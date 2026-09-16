import type { SmsKind, SmsKindRegistration, SmsRailName } from './kinds';

/**
 * The SMS rail port — Lot E (Q128).
 *
 * One shape for every operator so `sendSms` can pick a primary from the
 * credentials row and fall back down a list without knowing which vendor is
 * behind either. An adapter does three things: says whether it has what it
 * needs to send, sends one DLT-registered message, and reads its own delivery
 * report back into the common vocabulary.
 */

export interface SmsSendRequest {
  /** E.164 with the plus, `+919845012210`; the adapter reshapes it for its API. */
  to: string;
  kind: SmsKind;
  /** The registration for `kind` on this rail — the caller has already checked it exists. */
  registration: SmsKindRegistration;
  /** Named variables, already stringified. */
  vars: Record<string, string>;
  /** The rendered text, for a rail that posts the body rather than the variables. */
  body: string;
  /** TRAI DLT: the principal entity id and the header (sender id) registered against it. */
  dlt: { entityId?: string | undefined; senderId?: string | undefined };
}

export interface SmsSendResult {
  /** The rail's id for the message, for the delivery report to find it by. */
  providerMessageId: string | null;
  /** Lot G (Q121): the rail's answer as it came (trimmed), for the delivery log's attempt row. */
  responseText?: string | null;
}

export type DeliveryReportStatus = 'SENT' | 'DELIVERED' | 'FAILED';

export interface DeliveryReport {
  providerMessageId: string;
  status: DeliveryReportStatus;
  error?: string | undefined;
  at?: Date | undefined;
}

/** What a webhook handler passes an adapter: the parsed body plus what a signature check needs. */
export interface DeliveryWebhookInput {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** The absolute URL the provider posted to, as Twilio signs it. */
  url: string;
}

export interface SmsRail {
  readonly name: SmsRailName;
  /** `configured: false` means "do not try me" — no key, no account, or a stub. */
  describe(): Promise<{ configured: boolean }>;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
  /**
   * Reads one delivery-report call into reports. Throws `WebhookRejected`
   * when the call fails the rail's own authentication, so the controller can
   * answer 401 rather than record a report anybody could have posted.
   */
  parseDeliveryWebhook(input: DeliveryWebhookInput): Promise<DeliveryReport[]>;
}

export class WebhookRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRejected';
  }
}

/** `{{name}}` → the variable, empty when absent. Plain text: nothing is escaped. */
export function renderSmsBody(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => vars[name] ?? '');
}

/**
 * Canonical E.164 for an Indian number, the only country ADX sends to today.
 * Ten digits get the country code; a leading zero is dropped; anything that
 * already carries a plus is trusted.
 */
export function toE164(mobile: string): string {
  const trimmed = mobile.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  const digits = trimmed.replace(/\D/g, '').replace(/^0/, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

/** The variables a registration names, or every variable when it names none. */
export function pickVars(registration: SmsKindRegistration, vars: Record<string, string>): Record<string, string> {
  if (!registration.vars || registration.vars.length === 0) return { ...vars };
  const picked: Record<string, string> = {};
  for (const name of registration.vars) picked[name] = vars[name] ?? '';
  return picked;
}

export function headerValue(headers: DeliveryWebhookInput['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
