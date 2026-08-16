import { Router } from 'express';
import { getIntegrationsHandler, updateIntegrationsHandler } from '../controllers/integrations';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';

export const integrationsRouter = Router();

integrationsRouter.use(authenticate, requireRole('ADMIN'));
integrationsRouter.get('/', asyncHandler(getIntegrationsHandler));
integrationsRouter.put('/', asyncHandler(updateIntegrationsHandler));
