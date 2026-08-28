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
  /**
   * Display name for a reply author.
   *
   * Reads the User row, which the `users` module owns. Kept here because
   * support was migrated first; see README for the planned inversion onto the
   * users module's public lookup.
   */
  findAuthorDisplayName(userId: string): Promise<string>;
}
