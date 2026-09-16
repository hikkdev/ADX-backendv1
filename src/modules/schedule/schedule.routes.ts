import { Router } from 'express';
import { authenticate, requireRole } from '../../shared/auth';
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

scheduleRouter.get('/', asyncHandler(readScheduleHandler));
/* Declared ahead of '/:entryId' so "log" is never read as an entry id. */
scheduleRouter.get('/log', asyncHandler(readScheduleLogHandler));
scheduleRouter.post('/', asyncHandler(createEntryHandler));
scheduleRouter.patch('/:entryId', asyncHandler(patchEntryHandler));
scheduleRouter.delete('/:entryId', asyncHandler(deleteEntryHandler));
