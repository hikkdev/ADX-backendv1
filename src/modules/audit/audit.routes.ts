import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { exportAuditHandler, listAuditHandler, targetTimelineHandler } from './audit.controller';

export const auditRouter = Router();
auditRouter.use(authenticate, requireRole('ADMIN'));

auditRouter.get('/', requirePermission('system.view'), asyncHandler(listAuditHandler));
auditRouter.get('/export.csv', requirePermission('system.audit.export'), asyncHandler(exportAuditHandler));
auditRouter.get('/targets/:targetType/:targetId', requirePermission('system.view'), asyncHandler(targetTimelineHandler));
