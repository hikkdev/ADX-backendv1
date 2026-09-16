/**
 * Support — user-raised tickets and their message threads.
 */
export { supportRouter } from './support.routes';

/**
 * Used by `account-lifecycle` (Lot A, Q21): the ACCOUNT ticket a closure
 * request raises, and the count of open tickets the closure review reports.
 * Both go through this module so ops keeps one queue.
 */
export { raiseAccountTicket, countOpenTicketsForUser } from './support.service';

/**
 * E7-3: the port bootstrap fills from `publishers`, `advertisers`, `agents`,
 * `wallets`, `listings` and `orders`, so the queue rows and the requester
 * rail can name the party behind a ticket without this module importing six
 * more modules.
 */
export { registerRequesterPort, resetRequesterPort } from './requester.port';
export type { RequesterPort, RequesterParty, RequesterPartyType } from './requester.port';

/**
 * Lot I: live chat for paid subscribers.
 *
 * `sweepLiveChats` is what `jobs/live-chat-sla.job.ts` runs every minute;
 * `supportAttachmentViewer` is what bootstrap fills into
 * `uploads.FileAccessPort` so the requester can open the file ADX attached
 * to their own thread; `liveChatEntitlement` is the read the console's
 * subscriber rail and the apps' chat button both ask.
 */
export { sweepLiveChats, supportAttachmentViewer, liveChatEntitlement } from './live-chat.service';
export type { Entitlement, EntitlementReason } from './live-chat.entitlement';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
