import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  addReplySchema,
  assignTicketSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  opsTicketQuerySchema,
  patchTicketSchema,
  updateTicketStatusSchema,
} from './support.schema';
import {
  addReply,
  assignTicket,
  createTicket,
  getOpsTickets,
  getTicketRequester,
  getTickets,
  getVisibleTicket,
  patchTicket,
  setTicketStatus,
} from './support.service';
import type { Actor } from './support.types';

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });

export async function getTicketsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listTicketsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const tickets = await getTickets(req.user!.sub, parsed.data);
  res.json({ success: true, data: tickets });
}

// GET /support/tickets/:ticketId — the raiser's, or ADX's, thread.
export async function getTicketHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const ticket = await getVisibleTicket(ticketId, actorOf(req));
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  res.json({ success: true, data: ticket });
}

export async function createTicketHandler(req: Request, res: Response): Promise<void> {
  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const ticket = await createTicket({ userId: req.user!.sub, ...parsed.data });
  res.status(201).json({ success: true, data: ticket });
}

export async function addReplyHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const parsed = addReplySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const actor = actorOf(req);
  const message = await addReply(ticketId, actor, parsed.data.message, {
    internal: parsed.data.internal,
    // Lot I: a private SUPPORT_ATTACHMENT file already stored through POST /upload.
    attachmentFileId: parsed.data.attachmentFileId,
  });
  // Lot D (Q53): an internal note is an ops write worth its own row; an
  // ordinary reply is the conversation and is not audited by hand.
  if (parsed.data.internal) {
    await logActivity(actor.sub, 'SUPPORT_TICKET_NOTE_ADDED', {
      req,
      module: 'support',
      targetType: 'SupportTicket',
      targetId: ticketId,
      metadata: { messageId: message.id },
    });
  }
  res.status(201).json({ success: true, data: message });
}

/**
 * PATCH /support/tickets/:ticketId — Lot D (Q53/Q91): the desk moves the
 * status (WAITING pauses the clock), the priority (resets it), the ops owner
 * and the team. Audited with the columns that moved.
 */
export async function patchTicketHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const parsed = patchTicketSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const actor = actorOf(req);
  const { before, after } = await patchTicket(ticketId, actor, parsed.data);
  await logActivity(actor.sub, 'SUPPORT_TICKET_UPDATED', {
    req,
    module: 'support',
    targetType: 'SupportTicket',
    targetId: ticketId,
    diff: auditDiff(before, after, ['status', 'priority', 'team', 'assignedAdminUserId', 'slaFirstResponseDueAt', 'slaResolutionDueAt', 'slaPausedMs']),
  });
  res.json({ success: true, data: after });
}

export async function updateTicketStatusHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const parsed = updateTicketStatusSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const actor = actorOf(req);
  const existing = await getVisibleTicket(ticketId, actor);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  const ticket = await setTicketStatus(ticketId, parsed.data.status as 'OPEN' | 'CLOSED', actor);
  res.json({ success: true, data: ticket });
}

/**
 * The ops queue.
 *
 * Every ticket rather than one user's, oldest first, with `unassigned=true` for
 * the list that actually needs working. Separate from `getTicketsHandler`
 * because that one is scoped to the caller and must stay that way — a ticket is
 * visible to the person who raised it and to ADX, and to nobody else.
 */
export async function opsTicketsHandler(req: Request, res: Response): Promise<void> {
  const parsed = opsTicketQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  // `mine` is the caller's own tickets as ops owner; resolved here because the
  // service never reads the request.
  const { mine, ...query } = parsed.data;
  res.json({
    success: true,
    data: await getOpsTickets({ ...query, ...(mine ? { assignedAdminUserId: req.user!.sub } : {}) }),
  });
}

/** E7-3: the requester rail beside a thread — ADMIN at the route. */
export async function ticketRequesterHandler(req: Request, res: Response): Promise<void> {
  const rail = await getTicketRequester(req.params['ticketId'] as string);
  if (!rail) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  res.json({ success: true, data: rail });
}

/**
 * Putting an agent on a request.
 *
 * This is the decision a publisher's access code is later bound to, which is
 * why it is ADMIN-only and why the actor is recorded. Sending `null` takes the
 * agent off without closing the ticket.
 */
export async function assignTicketHandler(req: Request, res: Response): Promise<void> {
  const parsed = assignTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const ticket = await assignTicket(
    req.params['ticketId'] as string,
    parsed.data.assignedAgentId,
    req.user!.sub,
  );
  res.json({ success: true, data: ticket });
}
