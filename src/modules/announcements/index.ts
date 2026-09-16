/**
 * Announcements — Lot E (Q64/Q130): a broadcast from ops, delivered through
 * the notifications dispatcher.
 */
export { announcementRouter } from './announcements.routes';

/** For `jobs/announcement-sender.job.ts`: promote what is due, fan out what is SENDING. */
export { sendDueAnnouncements } from './announcements.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
