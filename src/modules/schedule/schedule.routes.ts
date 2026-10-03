import { Router } from 'express';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  createEntryHandler,
  deleteEntryHandler,
  patchEntryHandler,
  readScheduleHandler,
  readScheduleLogHandler,
} from './schedule.controller';

/**
 * The staff diary — Lot E (Q99). ADMIN at the router: the diary is the
 * console's, and an agent reads their own day through `/agents/me/day`.
 */
export const scheduleRouter = Router();
scheduleRouter.use(authenticate, requireRole('ADMIN'));

scheduleRouter.get('/', requirePermission('hr.view'), asyncHandler(readScheduleHandler));
/* Declared ahead of '/:entryId' so "log" is never read as an entry id. */
scheduleRouter.get('/log', requirePermission('hr.view'), asyncHandler(readScheduleLogHandler));
scheduleRouter.post('/', requirePermission('hr.edit'), asyncHandler(createEntryHandler));
scheduleRouter.patch('/:entryId', requirePermission('hr.edit'), asyncHandler(patchEntryHandler));
scheduleRouter.delete('/:entryId', requirePermission('hr.delete'), asyncHandler(deleteEntryHandler));
