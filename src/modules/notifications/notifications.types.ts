import type { NotificationChannel, NotificationType } from '../../shared/database';

/** ANNOUNCEMENT is Lot E (Q64): a broadcast from ops, delivered through `announcements`. */
/** WORK is Lot AA: a task assigned, due, sent back or awaiting review. */
export const NOTIFICATION_TYPES = ['ORDER', 'BOOKING', 'PAYOUT', 'KYC', 'MESSAGE', 'SYSTEM', 'DISPUTE', 'ANNOUNCEMENT', 'WORK'] as const;

/**
 * Where a notification can be delivered — DR 07 wave 5, decision 5.
 *
 * The Notification Preferences frame draws PUSH, EMAIL and SMS sections, so
 * the model carries the axis. IN_APP is the list the bell counts and the only
 * channel that has ever been delivered; the other three are recorded
 * preferences honoured the day delivery is built, which is why the screen says
 * so rather than implying a push that does not exist.
 */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS'] as const;
/**
 * LH6: the channels a comms template may name — the four above plus
 * WhatsApp, which the outreach hub's BSP adapter carries. WhatsApp has no
 * row of its own on the preferences screen: it follows the person's SMS
 * preference (`mayDeliver`), the way a WhatsApp message stands in for an SMS.
 */
export const TEMPLATE_CHANNELS = [...NOTIFICATION_CHANNELS, 'WHATSAPP'] as const;

/**
 * OTP and security messages are not a preference: they always go. So does a
 * CRITICAL announcement's SMS (Lot E, Q130) — it is a service notice, the
 * only kind of announcement that reaches SMS at all, and the one message a
 * person would not thank ADX for filtering.
 */
export const MANDATORY: { type: NotificationType; channel: NotificationChannel }[] = [
  { type: 'SYSTEM', channel: 'SMS' },
  // Lot E (Q147): the admin second factor's email backup goes through the
  // dispatcher too, and a sign-in code is not something to switch off.
  { type: 'SYSTEM', channel: 'EMAIL' },
  { type: 'ANNOUNCEMENT', channel: 'SMS' },
];

export const isMandatory = (type: NotificationType, channel: NotificationChannel): boolean =>
  MANDATORY.some((entry) => entry.type === type && entry.channel === channel);

/**
 * What a person gets when they have saved nothing.
 *
 * In-app is on for everything — it is the record, and switching it off would
 * hide what ADX already told them. Push follows in-app (G6: on for every
 * kind, the SMS-default kinds included). Email
 * is money only: nobody wants an email per order offer. SMS is off but for the
 * mandatory security messages, because an SMS costs the person nothing to
 * receive and ADX something to send.
 */
export function defaultEnabled(type: NotificationType, channel: NotificationChannel): boolean {
  if (isMandatory(type, channel)) return true;
  switch (channel) {
    case 'IN_APP':
      return true;
    case 'PUSH':
      // G6 (Q103/133): on for everything in-app is, and for the kinds SMS
      // carries by default (the security and service notices) — a push
      // costs the person nothing and is how the phone learns anything at
      // all when the app is closed. Every row stays switchable.
      return true;
    case 'EMAIL':
      // Announcements carry their own unsubscribe link (User.emailUnsubscribedAt).
      return type === 'PAYOUT' || type === 'ANNOUNCEMENT';
    default:
      return false;
  }
}

export type ListNotificationsOptions = {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  type?: NotificationType;
};

/**
 * E9: what `relatedId` names, so a push or a tap opens the right record.
 *
 * The eleven records an app screen can open. A notice whose `relatedId` is
 * something else — a KYC case, a fraud case, a safety alert, a package sale,
 * a spot, a settings key — carries no `relatedType`: the id is still there
 * for the screen that raised it, but nothing in the apps is told to open it.
 */
export const RELATED_TYPES = [
  'ORDER',
  'PUBLISHER',
  'ADVERTISER',
  'CAMPAIGN',
  'STATEMENT',
  'WITHDRAWAL',
  'TICKET',
  'DISPUTE',
  'ANNOUNCEMENT',
  'LISTING',
  /** AB-B: a work task — every `work` notice, so a tap opens the task. */
  'WORK',
  /** LH5: a lead — the hunting map's three pushes, so a tap opens the lead in the agent app. */
  'LEAD',
] as const;

export type RelatedType = (typeof RELATED_TYPES)[number];

export const isRelatedType = (value: unknown): value is RelatedType =>
  typeof value === 'string' && (RELATED_TYPES as readonly string[]).includes(value);

/**
 * E9: the structured facts behind a notice the apps draw as a modal, beside
 * the prose. Only the events below carry one; every other notice has
 * `payload: null`. The shapes are the contract the phones read:
 *
 * - `KYC_DECISION_AGENT` (relatedType PUBLISHER — the agent is told of the
 *   decision on a publisher they brought in): `{ publisherId, publisherName,
 *   status, decidedAt }`, `decidedAt` an ISO timestamp.
 * - `INCENTIVE_RECORDED` (relatedType CAMPAIGN for an assist, else the party
 *   the row names): `{ event, amount, campaignId, partyName }`, `amount` the
 *   money string, `campaignId` null but for an assist.
 * - `ANNOUNCEMENT` (relatedType ANNOUNCEMENT): `{ announcementId, importance,
 *   title, body }`.
 * - `STATEMENT_READY` (relatedType STATEMENT): `{ statementId, month, net }`,
 *   `month` the label the statement wears, `net` the money string.
 */
export type KycDecisionAgentPayload = { publisherId: string; publisherName: string; status: string; decidedAt: string };
export type IncentiveRecordedPayload = { event: string; amount: string; campaignId: string | null; partyName: string };
export type AnnouncementPayload = { announcementId: string; importance: string; title: string; body: string };
export type StatementReadyPayload = { statementId: string; month: string; net: string };

export type NotificationPayload = KycDecisionAgentPayload | IncentiveRecordedPayload | AnnouncementPayload | StatementReadyPayload;

export type NewNotification = {
  userId: string;
  type: NotificationType;
  title: string;
  subtitle?: string;
  message: string;
  suggestedAction?: string;
  relatedId?: string;
  /** E9: what `relatedId` names — one of `RELATED_TYPES`. */
  relatedType?: RelatedType;
  /** E9: the modal's facts — one of the shapes above, JSON-serialisable. */
  payload?: NotificationPayload;
};

export type NotificationPreferenceInput = {
  type: NotificationType;
  /** Absent means IN_APP, so a client written before wave 5 still works. */
  channel?: NotificationChannel;
  enabled: boolean;
};

export type PreferenceRow = {
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  /** True when the row cannot be switched off — the screen draws it as Required. */
  mandatory: boolean;
};
