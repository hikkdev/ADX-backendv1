import { ApiError } from '../../shared/errors';
import { getUserDisplayName } from '../users';
import { prismaSupportRepository as repository } from './prisma-support.repository';
import type { ListTicketsOptions, NewTicket } from './support.types';

export async function getTickets(userId: string, opts: ListTicketsOptions = {}) {
  return repository.findManyForUser(userId, opts);
}

export async function getTicketById(ticketId: string) {
  return repository.findById(ticketId);
}

/**
 * A ticket is visible only to the user who raised it. Returns null rather than
 * throwing so the caller decides between 404 and a silent skip.
 */
export async function getOwnedTicket(ticketId: string, userId: string) {
  const ticket = await repository.findById(ticketId);
  return ticket && ticket.userId === userId ? ticket : null;
}

export async function createTicket(data: NewTicket) {
  return repository.create(data);
}

/**
 * Replying distinguishes "no such ticket" (404) from "not yours" (403), unlike
 * reading, which reports both as 404. Preserved from the original controller.
 */
export async function addReply(ticketId: string, authorId: string, message: string) {
  const ticket = await repository.findSummaryById(ticketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  if (ticket.userId !== authorId) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this ticket');
  }

  // 'Agent' is the fallback when the user has neither name nor mobile.
  const authorName = (await getUserDisplayName(authorId)) ?? 'Agent';
  return repository.addReply({ ticketId, authorId, authorName, message });
}

export async function setTicketStatus(ticketId: string, status: 'OPEN' | 'CLOSED') {
  return repository.setStatus(ticketId, status);
}
