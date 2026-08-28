import type { SupportTicket, TicketMessage } from '../../shared/database';
import type { ListTicketsOptions, NewReply, NewTicket } from './support.types';

export interface SupportRepository {
  findManyForUser(userId: string, opts: ListTicketsOptions): Promise<SupportTicket[]>;
  findById(ticketId: string): Promise<SupportTicket | null>;
  /** Without the message thread — used for ownership checks before a write. */
  findSummaryById(ticketId: string): Promise<SupportTicket | null>;
  create(data: NewTicket): Promise<SupportTicket>;
  /** Creates the message and touches the ticket in one transaction. */
  addReply(data: NewReply): Promise<TicketMessage>;
  setStatus(ticketId: string, status: 'OPEN' | 'CLOSED'): Promise<SupportTicket>;
}
