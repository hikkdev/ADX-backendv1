import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { exportAuditHandler, listAuditHandler, targetTimelineHandler } from './audit.controller';

export const auditRouter = Router();
auditRouter.use(authenticate, requireRole('ADMIN'));

auditRouter.get('/', asyncHandler(listAuditHandler));
auditRouter.get('/export.csv', asyncHandler(exportAuditHandler));
auditRouter.get('/targets/:targetType/:targetId', asyncHandler(targetTimelineHandler));
