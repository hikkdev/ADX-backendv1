import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import {
  getTicketsHandler, getTicketHandler, createTicketHandler,
  addReplyHandler, updateTicketStatusHandler,
} from './support.controller';

export const supportRouter = Router();
supportRouter.use(authenticate);

supportRouter.get('/tickets', asyncHandler(getTicketsHandler));
supportRouter.post('/tickets', asyncHandler(createTicketHandler));
supportRouter.get('/tickets/:ticketId', asyncHandler(getTicketHandler));
supportRouter.post('/tickets/:ticketId/reply', asyncHandler(addReplyHandler));
supportRouter.patch('/tickets/:ticketId/status', asyncHandler(updateTicketStatusHandler));
