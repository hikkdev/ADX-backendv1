import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { getConfigHandler, putConfigHandler } from './app-config.controller';
import { adminSecretOrAdminRole } from './app-config.policy';

export const configRouter = Router();

// GET is deliberately unauthenticated: the agent app fetches it on boot,
// before anyone has signed in.
configRouter.get('/', asyncHandler(getConfigHandler));
configRouter.put('/', adminSecretOrAdminRole, asyncHandler(putConfigHandler));
