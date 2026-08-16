import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { upperEnum } from '../lib/zod';
import { prisma } from '../lib/prisma';
import { getTickets, getTicketById, createTicket, addReply, closeTicket, reopenTicket } from '../services/support.service';

export async function getTicketsHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = z.object({
    limit: z.coerce.number().default(50),
    offset: z.coerce.number().default(0),
    status: upperEnum(['OPEN', 'CLOSED'] as const).optional(),
    search: z.string().optional(),
  }).safeParse(req.query);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const tickets = await getTickets(userId, parsed.data);
  res.json({ success: true, data: tickets });
}

export async function getTicketHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const userId = req.user!.sub;
  const ticket = await getTicketById(ticketId);
  if (!ticket || ticket.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  res.json({ success: true, data: ticket });
}

export async function createTicketHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    category: z.string().optional(),
    relatedOrderId: z.string().optional(),
  }).safeParse(req.body);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const ticket = await createTicket({ userId, ...parsed.data });
  res.status(201).json({ success: true, data: ticket });
}

export async function addReplyHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const userId = req.user!.sub;
  const parsed = z.object({ message: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const [ticket, user] = await Promise.all([
    prisma.supportTicket.findUnique({ where: { id: ticketId } }),
    prisma.user.findUnique({ where: { id: userId } }),
  ]);

  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this ticket');

  const message = await addReply({
    ticketId,
    authorId: userId,
    authorName: user?.name ?? user?.mobile ?? 'Agent',
    message: parsed.data.message,
  });
  res.status(201).json({ success: true, data: message });
}

export async function updateTicketStatusHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const userId = req.user!.sub;
  const parsed = z.object({ status: upperEnum(['OPEN', 'CLOSED'] as const) }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await getTicketById(ticketId);
  if (!existing || existing.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  const ticket = parsed.data.status === 'CLOSED'
    ? await closeTicket(ticketId)
    : await reopenTicket(ticketId);
  res.json({ success: true, data: ticket });
}
