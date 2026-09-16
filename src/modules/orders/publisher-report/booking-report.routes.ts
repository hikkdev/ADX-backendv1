import { Router } from 'express';
import { authenticate, requireRole } from '../../../shared/auth';
import { asyncHandler } from '../../../shared/http';
import { requireFeature } from '../../feature-flags';
import { bookingReportPdfHandler, spotInsightsHandler } from './booking-report.controller';

/**
 * G6 (Q110): the publisher's side of a booking — mounted by bootstrap at
 * `/publishers/me/bookings`, AHEAD of `publisherRouter` the way the
 * publisher's invoices are, so nothing in that tree reads "me" as an id.
 * The role gets a caller through the door; whose booking it is — the
 * listing's publisher, or their agent under a live grant — is the
 * service's question, asked on every call.
 */
export const publisherBookingRouter = Router();
publisherBookingRouter.use(authenticate);
publisherBookingRouter.use(requireRole('PUBLISHER', 'AGENT_PUBLISHER'));
publisherBookingRouter.get('/:orderId/report.pdf', asyncHandler(bookingReportPdfHandler));
/* G10: the kill switch on spot insights (Q9) — 503 FEATURE_OFF ahead of the service's own per-publisher 403. */
publisherBookingRouter.get('/:orderId/insights', requireFeature('publisher.spot-insights'), asyncHandler(spotInsightsHandler));
