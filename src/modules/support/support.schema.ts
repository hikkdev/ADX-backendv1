import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const TICKET_STATUSES = ['OPEN', 'CLOSED'] as const;

export const listTicketsQuerySchema = z.object({
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
  status: upperEnum(TICKET_STATUSES).optional(),
  search: z.string().optional(),
});

export const createTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().optional(),
  relatedOrderId: z.string().optional(),
});

export const addReplySchema = z.object({ message: z.string().min(1) });

export const updateTicketStatusSchema = z.object({ status: upperEnum(TICKET_STATUSES) });
