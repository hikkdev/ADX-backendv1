import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { audienceFieldsHandler, getIntegrationsHandler, testAudienceVendorHandler, testEmailDoorHandler, updateIntegrationsHandler } from './integrations.controller';

export const integrationsRouter = Router();

// Every endpoint exposes or mutates provider credentials, so ADMIN guards the
// whole router rather than each route.
integrationsRouter.use(authenticate, requireRole('ADMIN'));
integrationsRouter.get('/', asyncHandler(getIntegrationsHandler));
integrationsRouter.put('/', asyncHandler(updateIntegrationsHandler));
// AC-B2: the audience card. The field catalogue the variable map is drawn
// from (a read), and the vendor test — it spends one vendor call on the
// stored key, so it is the same power as editing the row.
integrationsRouter.get('/audience/fields', asyncHandler(audienceFieldsHandler));
integrationsRouter.post('/audience/test', requirePermission('settings.edit'), asyncHandler(testAudienceVendorHandler));
// AE-B: the email card's test — one message through the one door on the
// stored credentials, the same power as editing the row.
integrationsRouter.post('/email/test', requirePermission('settings.edit'), asyncHandler(testEmailDoorHandler));
