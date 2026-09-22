/**
 * LH6 (the Lead Hunt, 22 Sep 2026): the outreach adapters' shared shapes.
 *
 * An adapter is one provider on the wire — a WhatsApp BSP, Meta's Graph
 * API for the two DMs, Google Business Messages, a telephony operator.
 * Each answers `describe()` (is its card filled?), sends what it is handed,
 * and reads its own webhook into the two events every channel has: a
 * message that came in, and a status on one that went out. What a lead is,
 * whether it may be written to, and what to do with a reply is the hub's
 * business (`modules/leads/outreach.service.ts`), not the adapter's.
 *
 * Imports nothing from `modules/`: `notifications` reaches the WhatsApp
 * adapter for its own WHATSAPP channel and `leads` reaches every one.
 */

export type MessagingChannel = 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER' | 'GOOGLE_BUSINESS';

/** What `describe()` answers: whether the card is filled and, when it is not, which fields are missing. */
export interface AdapterDescription {
  configured: boolean;
  /** The provider the card names — `gupshup`, `meta`, `exotel` — or null when no provider is chosen. */
  provider: string | null;
  missing: string[];
}

export type SendFailureCode = 'NOT_CONFIGURED' | 'NO_TEMPLATE' | 'PROVIDER_ERROR';

/** Every send answers one of these; a thrown error is a bug, not a provider's no. */
export type SendOutcome =
  | { ok: true; providerId: string | null; response: string | null }
  | { ok: false; code: SendFailureCode; message: string };

export interface TextSend {
  /** The thread the provider addresses — an E.164 number for WhatsApp, a scoped user id for the DMs, a conversation id for Business Messages. */
  to: string;
  text: string;
}

export interface TemplateSend {
  to: string;
  /** The BSP's approved template — its name and language, and the values in the order it takes them. */
  template: { name: string; language?: string | undefined; params?: string[] | undefined };
  values: Record<string, string>;
}

/** A message the lead sent us, as the adapter read it off the webhook. */
export interface InboundEvent {
  kind: 'MESSAGE';
  channel: MessagingChannel;
  providerThreadId: string;
  providerMessageId: string;
  /** The lead's own address — the number, the handle, the display name the provider gave. */
  from: string;
  fromName: string | null;
  text: string;
  at: Date;
  /** DM: how it came — a comment on a post, a reply to a story, or a plain message. */
  source: 'DM' | 'COMMENT' | 'STORY_REPLY';
}

/** A status the provider reported on a message we sent. */
export interface StatusEvent {
  kind: 'STATUS';
  channel: MessagingChannel;
  providerMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  error: string | null;
  at: Date;
}

export type WebhookEvent = InboundEvent | StatusEvent;

export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  /** The bytes as received — every provider signs those, not the parsed object. */
  rawBody?: Buffer | undefined;
  body: unknown;
  query?: Record<string, unknown> | undefined;
  /** The full URL the provider posted to — Twilio signs it. */
  url?: string | undefined;
}

/** A webhook the adapter would not trust: a bad signature, no secret on file. The route answers 401. */
export class OutreachWebhookRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutreachWebhookRejected';
  }
}

export function headerValue(headers: WebhookInput['headers'], name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A body that may be an object: `body.x` without the cast at every read. */
export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : null);

/** A provider's epoch — seconds or milliseconds, a number or a string — into a Date; now when it is unreadable. */
export function epochToDate(value: unknown, now = new Date()): Date {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
    return now;
  }
  return new Date(n < 1e12 ? n * 1000 : n);
}

/* ── telephony ─────────────────────────────────────────────────────── */

export type CallOutcome = 'ANSWERED' | 'NO_ANSWER' | 'BUSY' | 'VOICEMAIL';

export interface PlaceCallInput {
  /** The agent's own number — rung first. */
  agentNumber: string;
  /** The lead's number — rung when the agent picks up. */
  leadNumber: string;
  /** The masked number the lead sees: one of the card's caller ids. */
  callerId: string;
  /** Record the call — only ever true when the consent line is set. */
  record: boolean;
  consentLine: string | null;
  /** Where the operator posts the call's end. */
  statusCallbackUrl: string;
  /** Twilio: the URL that answers with the TwiML (the consent line, then the dial). */
  answerUrl: string;
}

export type PlaceCallOutcome =
  | { ok: true; providerCallId: string; maskedNumber: string }
  | { ok: false; code: 'NOT_CONFIGURED' | 'NO_CALLER_ID' | 'PROVIDER_ERROR'; message: string };

/** One status callback on a call we placed. */
export interface CallStatusEvent {
  providerCallId: string;
  /** Null while the call is still in progress. */
  outcome: CallOutcome | null;
  durationSec: number | null;
  recordingUrl: string | null;
  /** The operator's last word on this call — nothing more will come. */
  final: boolean;
  raw: string;
}

/** A call the lead made — a missed call to the missed-call number, or an IVR key press. */
export interface InboundCallEvent {
  from: string;
  to: string | null;
  providerCallId: string | null;
  /** The key pressed on the IVR, or null on a missed call. */
  digits: string | null;
  at: Date;
}
