import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import {
  getNotificationsHandler, getNotificationHandler,
  markReadHandler, markAllReadHandler,
  getPreferencesHandler, savePreferencesHandler,
} from './notifications.controller';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

// The literal paths must stay ahead of /:notificationId, or "read-all" and
// "preferences" would be captured as notification ids.
notificationRouter.get('/', asyncHandler(getNotificationsHandler));
notificationRouter.patch('/read-all', asyncHandler(markAllReadHandler));
notificationRouter.get('/preferences', asyncHandler(getPreferencesHandler));
notificationRouter.put('/preferences', asyncHandler(savePreferencesHandler));
notificationRouter.get('/:notificationId', asyncHandler(getNotificationHandler));
notificationRouter.patch('/:notificationId/read', asyncHandler(markReadHandler));
