import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { INBOX_CHANNEL, subscribe, ticketChannel, type BusEvent } from './live-chat.bus';
import {
  convertLiveChat,
  createCannedReply,
  deleteCannedReply,
  liveChatStatus,
  liveInbox,
  listCannedReplies,
  markThreadSeen,
  operatorPresence,
  publishTyping,
  reassignLiveChat,
  startLiveChat,
  updateCannedReply,
} from './live-chat.service';
import { heartbeatOperator, setOperatorPresence } from './live-chat.presence';
import { INBOX_TOKEN_TICKET, lastEventInstant, mintStreamToken, openSse } from './live-chat.stream';
import { prismaSupportRepository as repository } from './prisma-support.repository';
import { messageEvent } from './live-chat.messaging';
import {
  cannedQuerySchema,
  cannedReplyCreateSchema,
  cannedReplyPatchSchema,
  convertSchema,
  liveInboxQuerySchema,
  liveStartSchema,
  presenceSchema,
  reassignSchema,
  typingSchema,
} from './support.schema';
import type { Actor } from './support.types';

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });
const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');

/** One shape for every body and query here: a 400 with the flattened issues, never a cast. */
function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

/* ── status and start ────────────────────────────────────────────── */

// GET /support/live/status — what the phone asks before drawing a chat button.
export async function liveStatusHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await liveChatStatus(actorOf(req)) });
}

// POST /support/live/start — 403 NOT_ENTITLED with the upsell; a ticket when the door is shut.
export async function liveStartHandler(req: Request, res: Response): Promise<void> {
  const input = parse(liveStartSchema, req.body ?? {});
  const result = await startLiveChat(actorOf(req), input);
  res.status(result.continued ? 200 : 201).json({
    success: true,
    data: {
      ticketId: result.ticket.id,
      displayId: result.ticket.displayId,
      channel: result.channel,
      continued: result.continued,
      assignedAdmin: result.assignedAdmin ?? null,
      ...(result.fallback ? { fallback: result.fallback, nextOpening: result.nextOpening ?? null } : {}),
    },
  });
}

/* ── presence ────────────────────────────────────────────────────── */

// PUT /support/presence — the desk says it is at the desk; the 90 s TTL says how long that is believed.
export async function setPresenceHandler(req: Request, res: Response): Promise<void> {
  const { online } = parse(presenceSchema, req.body ?? {});
  await setOperatorPresence(req.user!.sub, online);
  res.json({ success: true, data: { online } });
}

// POST /support/presence/heartbeat — every 30 s from an open desk.
export async function presenceHeartbeatHandler(req: Request, res: Response): Promise<void> {
  await heartbeatOperator(req.user!.sub);
  res.json({ success: true, data: { online: true } });
}

// GET /support/presence — who is on, and how much each is holding.
export async function presenceHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await operatorPresence() });
}

/* ── the stream ──────────────────────────────────────────────────── */

// POST /support/tickets/:ticketId/stream-token — the console's way in; EventSource sets no headers.
export async function streamTokenHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const ticketId = req.params['ticketId'] as string;
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.userId !== actor.sub && !isAdmin(actor)) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  res.status(201).json({ success: true, data: await mintStreamToken(ticketId, actor) });
}

// POST /support/live/inbox/stream-token — the same door for the desk's inbox stream.
export async function inboxStreamTokenHandler(req: Request, res: Response): Promise<void> {
  res.status(201).json({ success: true, data: await mintStreamToken(INBOX_TOKEN_TICKET, actorOf(req)) });
}

/**
 * GET /support/tickets/:ticketId/events — the thread as it happens.
 *
 * The catch-up first (`Last-Event-ID`, or `lastMessageAt` when the client
 * says nothing), then every event the bus carries for this ticket. An
 * internal note never reaches the requester's socket: the filter is here,
 * on the way out, rather than on the publish, because the same event goes
 * to the desk.
 */
export async function ticketEventsHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const ticketId = req.params['ticketId'] as string;
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  const admin = isAdmin(actor);
  if (ticket.userId !== actor.sub && !admin) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  let unsubscribe: (() => void) | null = null;
  const stream = openSse(req, res, () => unsubscribe?.());
  const mineOf = (authorId: string) => authorId === actor.sub;

  const since = lastEventInstant(req);
  if (since) {
    for (const message of await repository.findMessagesAfter(ticketId, since)) {
      if (message.internal && !admin) continue;
      const event = messageEvent(message);
      stream.send('message', { ...event, mine: mineOf(message.authorId) }, String(message.createdAt.getTime()));
    }
  }
  stream.send('status', { status: ticket.status, channel: ticket.channel });

  unsubscribe = subscribe(ticketChannel(ticketId), (event: BusEvent) => {
    // The ticket channel only ever carries TicketEvents; the union is wider
    // because one bus carries the inbox too.
    if (event.type === 'message' && 'authorId' in event) {
      if (event.internal && !admin) return;
      stream.send('message', { ...event, mine: mineOf(event.authorId) }, String(new Date(event.createdAt).getTime()));
      return;
    }
    stream.send(event.type, event);
  });
}

/** GET /support/live/inbox/events — the desk's own stream: new chats, messages, breaches. */
export async function inboxEventsHandler(req: Request, res: Response): Promise<void> {
  let unsubscribe: (() => void) | null = null;
  const stream = openSse(req, res, () => unsubscribe?.());
  stream.comment('inbox open');
  unsubscribe = subscribe(INBOX_CHANNEL, (event: BusEvent) => stream.send(event.type, event));
}

/* ── typing and seen ─────────────────────────────────────────────── */

export async function typingHandler(req: Request, res: Response): Promise<void> {
  const { typing } = parse(typingSchema, req.body ?? {});
  const actor = actorOf(req);
  const ticket = await ticketFor(req, actor);
  const published = await publishTyping(ticket, actor, typing);
  res.json({ success: true, data: { typing, published } });
}

export async function seenHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const ticket = await ticketFor(req, actor);
  const updated = await markThreadSeen(ticket, actor);
  res.json({
    success: true,
    data: { requesterSeenAt: updated.requesterSeenAt, agentSeenAt: updated.agentSeenAt },
  });
}

async function ticketFor(req: Request, actor: Actor) {
  const ticket = await repository.findSummaryById(req.params['ticketId'] as string);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.userId !== actor.sub && !isAdmin(actor)) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  return ticket;
}

/* ── ops moves a chat ────────────────────────────────────────────── */

export async function reassignHandler(req: Request, res: Response): Promise<void> {
  const { adminUserId } = parse(reassignSchema, req.body ?? {});
  const actor = actorOf(req);
  const ticketId = req.params['ticketId'] as string;
  const { before, after } = await reassignLiveChat(ticketId, adminUserId, actor);
  await logActivity(actor.sub, 'SUPPORT_CHAT_REASSIGNED', {
    req,
    module: 'support',
    targetType: 'SupportTicket',
    targetId: ticketId,
    diff: auditDiff(before, after, ['assignedAdminUserId']),
  });
  res.json({ success: true, data: after });
}

export async function convertHandler(req: Request, res: Response): Promise<void> {
  parse(convertSchema, req.body ?? {});
  const actor = actorOf(req);
  const ticketId = req.params['ticketId'] as string;
  const { before, after } = await convertLiveChat(ticketId, actor);
  await logActivity(actor.sub, 'SUPPORT_CHAT_CONVERTED', {
    req,
    module: 'support',
    targetType: 'SupportTicket',
    targetId: ticketId,
    diff: auditDiff(before, after, ['channel']),
  });
  res.json({ success: true, data: after });
}

/* ── the inbox and the canned replies ────────────────────────────── */

export async function liveInboxHandler(req: Request, res: Response): Promise<void> {
  const query = parse(liveInboxQuerySchema, req.query);
  const { mine, ...rest } = query;
  res.json({
    success: true,
    data: await liveInbox({ ...rest, ...(mine ? { assignedAdminUserId: req.user!.sub } : {}) }),
  });
}

export async function listCannedHandler(req: Request, res: Response): Promise<void> {
  const query = parse(cannedQuerySchema, req.query);
  res.json({ success: true, data: await listCannedReplies(query) });
}

export async function createCannedHandler(req: Request, res: Response): Promise<void> {
  const input = parse(cannedReplyCreateSchema, req.body ?? {});
  const actor = actorOf(req);
  const created = await createCannedReply(input, actor);
  await logActivity(actor.sub, 'SUPPORT_CANNED_REPLY_CREATED', {
    req,
    module: 'support',
    targetType: 'CannedReply',
    targetId: created.id,
    metadata: { title: created.title, team: created.team },
  });
  res.status(201).json({ success: true, data: created });
}

export async function patchCannedHandler(req: Request, res: Response): Promise<void> {
  const patch = parse(cannedReplyPatchSchema, req.body ?? {});
  const actor = actorOf(req);
  const id = req.params['cannedId'] as string;
  const { before, after } = await updateCannedReply(id, patch);
  await logActivity(actor.sub, 'SUPPORT_CANNED_REPLY_UPDATED', {
    req,
    module: 'support',
    targetType: 'CannedReply',
    targetId: id,
    diff: auditDiff(before, after, ['title', 'body', 'team', 'isActive']),
  });
  res.json({ success: true, data: after });
}

export async function deleteCannedHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const id = req.params['cannedId'] as string;
  const removed = await deleteCannedReply(id);
  await logActivity(actor.sub, 'SUPPORT_CANNED_REPLY_DELETED', {
    req,
    module: 'support',
    targetType: 'CannedReply',
    targetId: id,
    metadata: { title: removed.title, team: removed.team },
  });
  res.json({ success: true, data: { id } });
}
