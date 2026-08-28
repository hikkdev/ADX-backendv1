import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { getIntegrationsHandler, updateIntegrationsHandler } from './integrations.controller';

export const integrationsRouter = Router();

// Both endpoints expose or mutate provider credentials, so ADMIN guards the
// whole router rather than each route.
integrationsRouter.use(authenticate, requireRole('ADMIN'));
integrationsRouter.get('/', asyncHandler(getIntegrationsHandler));
integrationsRouter.put('/', asyncHandler(updateIntegrationsHandler));
