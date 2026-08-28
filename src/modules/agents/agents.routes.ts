import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { getAllAgentsHandler, getAgentByIdHandler } from './agents.controller';

export const agentRouter = Router();
agentRouter.use(authenticate);

agentRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAgentsHandler));
agentRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAgentByIdHandler));
