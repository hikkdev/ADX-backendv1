import { Router } from 'express';
import { getAllAgentsHandler, getAgentByIdHandler } from '../controllers/agent';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';

export const agentRouter = Router();
agentRouter.use(authenticate);

agentRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAgentsHandler));
agentRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAgentByIdHandler));
