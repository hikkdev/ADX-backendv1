import { Router } from 'express';
import { getAllAgentsHandler, getAgentByIdHandler } from '../controllers/agent';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const agentRouter = Router();
agentRouter.use(authenticate);

agentRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAgentsHandler));
agentRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAgentByIdHandler));
