/**
 * Notifications — the public surface other modules may use.
 *
 * createNotification is the only behaviour exported outward: orders, order
 * assignment, publisher KYC and the publisher-timer job all raise
 * notifications. Everything else here is internal to the module.
 */
export { notificationRouter } from './notifications.routes';
export { createNotification } from './notifications.service';
export type { NewNotification } from './notifications.types';
