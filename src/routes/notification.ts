import { Router } from 'express';
import {
  getNotificationsHandler, getNotificationHandler,
  markReadHandler, markAllReadHandler,
  getPreferencesHandler, savePreferencesHandler,
} from '../controllers/notification';
import { asyncHandler } from '../shared/http';
import { authenticate } from '../shared/auth';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get('/', asyncHandler(getNotificationsHandler));
notificationRouter.patch('/read-all', asyncHandler(markAllReadHandler));
notificationRouter.get('/preferences', asyncHandler(getPreferencesHandler));
notificationRouter.put('/preferences', asyncHandler(savePreferencesHandler));
notificationRouter.get('/:notificationId', asyncHandler(getNotificationHandler));
notificationRouter.patch('/:notificationId/read', asyncHandler(markReadHandler));
