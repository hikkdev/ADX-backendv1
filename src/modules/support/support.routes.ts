import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import {
  getTicketsHandler, getTicketHandler, createTicketHandler,
  addReplyHandler, updateTicketStatusHandler,
  opsTicketsHandler, assignTicketHandler, patchTicketHandler,
  ticketRequesterHandler,
} from './support.controller';
import {
  convertHandler,
  createCannedHandler,
  deleteCannedHandler,
  inboxEventsHandler,
  inboxStreamTokenHandler,
  liveInboxHandler,
  liveStartHandler,
  liveStatusHandler,
  listCannedHandler,
  patchCannedHandler,
  presenceHandler,
  presenceHeartbeatHandler,
  reassignHandler,
  seenHandler,
  setPresenceHandler,
  streamTokenHandler,
  ticketEventsHandler,
  typingHandler,
} from './live-chat.controller';
import { authenticateStream } from './live-chat.stream';

export const supportRouter = Router();

/* Lot I: the two SSE routes are registered ahead of the router-wide
 * `authenticate`, because a browser's EventSource cannot set an
 * Authorization header: they take the bearer token when it is there and a
 * single-use `?t=` stream token otherwise (`authenticateStream`). Both
 * still end up with `req.user` set, and both check the caller against the
 * ticket in the handler. */
supportRouter.get(
  '/tickets/:ticketId/events',
  authenticateStream,
  requireFeature('support.live-chat'),
  asyncHandler(ticketEventsHandler),
);
supportRouter.get(
  '/live/inbox/events',
  authenticateStream,
  requireRole('ADMIN'),
  requireFeature('support.live-chat'),
  asyncHandler(inboxEventsHandler),
);

supportRouter.use(authenticate);

/* ── Lot I: live chat ──────────────────────────────────────────────
 * `/live/status` is deliberately NOT behind `requireFeature`: it is the
 * read the phone makes to decide which screen to draw, and a 503 would
 * tell it nothing. With the feature off it answers `entitled: false,
 * reason: FEATURE_OFF` and the app keeps the ticket thread. Every other
 * live route is behind the switch. */
supportRouter.get('/live/status', asyncHandler(liveStatusHandler));
supportRouter.post('/live/start', requireFeature('support.live-chat'), asyncHandler(liveStartHandler));

/* The desk's presence: online, the 30 s heartbeat that keeps the 90 s key
 * alive, and who is on. */
supportRouter.put('/presence', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(setPresenceHandler));
supportRouter.post('/presence/heartbeat', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(presenceHeartbeatHandler));
supportRouter.get('/presence', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(presenceHandler));

/* The live inbox and its stream token, above /tickets/:ticketId so no path
 * is read as a ticket id. */
supportRouter.get('/live/inbox', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(liveInboxHandler));
supportRouter.post('/live/inbox/stream-token', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(inboxStreamTokenHandler));

/* The desk's canned replies. */
supportRouter.get('/canned', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(listCannedHandler));
supportRouter.post('/canned', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(createCannedHandler));
supportRouter.patch('/canned/:cannedId', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(patchCannedHandler));
supportRouter.delete('/canned/:cannedId', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(deleteCannedHandler));

/* The ops queue, registered above /tickets/:ticketId so "queue" is never read
 * as a ticket id. */
supportRouter.get('/tickets/queue', requireRole('ADMIN'), asyncHandler(opsTicketsHandler));

supportRouter.get('/tickets', asyncHandler(getTicketsHandler));
supportRouter.post('/tickets', asyncHandler(createTicketHandler));
supportRouter.get('/tickets/:ticketId', asyncHandler(getTicketHandler));
/* E7-3: the requester rail — who raised it, their record, wallet, orders, trail. ADMIN. */
supportRouter.get('/tickets/:ticketId/requester', requireRole('ADMIN'), asyncHandler(ticketRequesterHandler));
supportRouter.post('/tickets/:ticketId/reply', asyncHandler(addReplyHandler));
/* Lot I: the stream's token, the typing indicator and the seen mark. */
supportRouter.post('/tickets/:ticketId/stream-token', requireFeature('support.live-chat'), asyncHandler(streamTokenHandler));
supportRouter.post('/tickets/:ticketId/typing', requireFeature('support.live-chat'), asyncHandler(typingHandler));
supportRouter.post('/tickets/:ticketId/seen', requireFeature('support.live-chat'), asyncHandler(seenHandler));
supportRouter.post('/tickets/:ticketId/reassign', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(reassignHandler));
supportRouter.post('/tickets/:ticketId/convert', requireRole('ADMIN'), requireFeature('support.live-chat'), asyncHandler(convertHandler));
supportRouter.patch('/tickets/:ticketId/status', asyncHandler(updateTicketStatusHandler));
/* Lot D (Q53/Q91): the desk's own patch — WAITING, priority, ops owner, team. */
supportRouter.patch('/tickets/:ticketId', requireRole('ADMIN'), asyncHandler(patchTicketHandler));
/* ADX decides who handles a request. That decision is what later authorises
 * delegated access to the publisher's account, so it is ADMIN-only. */
supportRouter.post('/tickets/:ticketId/assign', requireRole('ADMIN'), asyncHandler(assignTicketHandler));
