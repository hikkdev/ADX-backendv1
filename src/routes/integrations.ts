import { Router } from 'express';
import { getIntegrationsHandler, updateIntegrationsHandler } from '../controllers/integrations';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const integrationsRouter = Router();

integrationsRouter.use(authenticate, requireRole('ADMIN'));
integrationsRouter.get('/', asyncHandler(getIntegrationsHandler));
integrationsRouter.put('/', asyncHandler(updateIntegrationsHandler));
