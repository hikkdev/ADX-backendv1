import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import {
  addReplySchema,
  createTicketSchema,
  listTicketsQuerySchema,
  updateTicketStatusSchema,
} from './support.schema';
import {
  addReply,
  createTicket,
  getOwnedTicket,
  getTickets,
  setTicketStatus,
} from './support.service';

export async function getTicketsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listTicketsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const tickets = await getTickets(req.user!.sub, parsed.data);
  res.json({ success: true, data: tickets });
}

export async function getTicketHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const ticket = await getOwnedTicket(ticketId, req.user!.sub);
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

  const message = await addReply(ticketId, req.user!.sub, parsed.data.message);
  res.status(201).json({ success: true, data: message });
}

export async function updateTicketStatusHandler(req: Request, res: Response): Promise<void> {
  const ticketId = req.params['ticketId'] as string;
  const parsed = updateTicketStatusSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await getOwnedTicket(ticketId, req.user!.sub);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  const ticket = await setTicketStatus(ticketId, parsed.data.status as 'OPEN' | 'CLOSED');
  res.json({ success: true, data: ticket });
}
