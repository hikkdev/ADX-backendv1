import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import {
  createTemplateHandler,
  exportDeliveriesHandler,
  getDeliveryHandler,
  getTemplateHandler,
  listDeliveriesHandler,
  listEventsHandler,
  listTemplatesHandler,
  msg91WebhookHandler,
  resendDeliveryHandler,
  sendTestTemplateHandler,
  smsKindsHandler,
  twilioWebhookHandler,
  unsubscribeHandler,
  updateTemplateHandler,
} from './comms.controller';

/**
 * /comms — the outbound desk (Lot E, Q87): the templates, the masked
 * delivery log, and the one public route in it.
 *
 * The unsubscribe link is registered ahead of the guard because it arrives
 * from an email with no session behind it; the token is its own proof.
 * Everything else is ADMIN, with the comms permission tiers on top: reading
 * the log is `comms.view`, changing copy or resending is `comms.edit`.
 */
export const commsRouter = Router();

commsRouter.get('/unsubscribe/:token', asyncHandler(unsubscribeHandler));

commsRouter.use(authenticate, requireRole('ADMIN'));
/* E10-2: the vocabulary the editor builds from — the events the code raises
 * with the variables it supplies, and the SMS kinds and rails. Literal paths,
 * so nothing here is order-sensitive against `/templates/:key`. */
commsRouter.get('/events', requirePermission('comms.view'), asyncHandler(listEventsHandler));
commsRouter.get('/sms-kinds', requirePermission('comms.view'), asyncHandler(smsKindsHandler));
commsRouter.get('/templates', requirePermission('comms.view'), asyncHandler(listTemplatesHandler));
commsRouter.post('/templates', requirePermission('comms.edit'), asyncHandler(createTemplateHandler));
commsRouter.get('/templates/:key', requirePermission('comms.view'), asyncHandler(getTemplateHandler));
commsRouter.patch('/templates/:key', requirePermission('comms.edit'), asyncHandler(updateTemplateHandler));
/* Lot G (Q117): the template to the operator's own inbox / phone with sample variables. */
commsRouter.post('/templates/:key/send-test', requirePermission('comms.edit'), asyncHandler(sendTestTemplateHandler));
commsRouter.get('/deliveries', requirePermission('comms.view'), asyncHandler(listDeliveriesHandler));
/* E10-2: registered ahead of `/deliveries/:id` so "export.csv" is never read as an id. Do not reorder. */
commsRouter.get('/deliveries/export.csv', requirePermission('comms.view'), asyncHandler(exportDeliveriesHandler));
commsRouter.get('/deliveries/:id', requirePermission('comms.view'), asyncHandler(getDeliveryHandler));
commsRouter.post('/deliveries/:id/resend', requirePermission('comms.edit'), asyncHandler(resendDeliveryHandler));

/**
 * /webhooks/{msg91,twilio} — the rails' delivery reports. No token: Twilio's
 * signature is checked in its adapter and fails closed; MSG91 has none, and a
 * report can only move a row whose message id we issued.
 */
export const commsWebhookRouter = Router();
commsWebhookRouter.post('/msg91', asyncHandler(msg91WebhookHandler));
commsWebhookRouter.post('/twilio', asyncHandler(twilioWebhookHandler));
