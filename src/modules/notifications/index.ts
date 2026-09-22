/**
 * Notifications — the public surface other modules may use.
 *
 * createNotification is the in-app row, unchanged: orders, order assignment,
 * publisher KYC and the publisher-timer job all raise notifications. Lot E
 * (Q87/Q147) adds `notify`, the dispatcher — the in-app row plus the outbound
 * deliveries the event's template names — and the comms desk. Everything
 * else here is internal to the module.
 */
export { notificationRouter } from './notifications.routes';
export { commsRouter, commsWebhookRouter } from './comms.routes';
export { createNotification, mayDeliver } from './notifications.service';
export { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, RELATED_TYPES, isRelatedType } from './notifications.types';
export type {
  AnnouncementPayload,
  IncentiveRecordedPayload,
  KycDecisionAgentPayload,
  NewNotification,
  NotificationPayload,
  RelatedType,
  StatementReadyPayload,
} from './notifications.types';

/** The dispatcher: for auth (2FA), packages (the payment link), announcements, and anyone else who sends. */
export { notify, unsubscribeUrlFor } from './dispatch.service';
export type { NotifyOptions, NotifyResult, OutboundChannel, SkipReason } from './dispatch.service';

/**
 * G6 (Q103/133): push. `deviceRouter` is mounted at `/users` by bootstrap
 * (`/users/me/devices`); `broadcastFlagsChanged` is what bootstrap hands
 * `feature-flags`' change port, so a moved flag reaches every phone as a
 * silent `{ type: 'FLAGS_CHANGED' }`; `sendPushToUser` is for a module that
 * needs a push outside the dispatcher (none does today — prefer `notify`).
 */
export { deviceRouter } from './push/devices.routes';
export { broadcastFlagsChanged, sendPushToUser } from './push/push.service';
export type { BroadcastOutcome, DeviceView, PushOutcome } from './push/push.service';

/** LH6: the two comms rules as pure functions, so the outreach hub rules every outbound the way the dispatcher rules its own. */
export { quietHoursDeferral, weekWindowIST } from './comms-rules';
export type { QuietHours } from './comms-rules';
export { TEMPLATE_CHANNELS } from './notifications.types';
export { renderText, renderHtml } from './templates';

/** For bootstrap and the jobs: the seed at boot, the sender tick, the nightly purge. */
export { ensureTemplates, purgeDeliveries, sendQueuedDeliveries } from './dispatch.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
