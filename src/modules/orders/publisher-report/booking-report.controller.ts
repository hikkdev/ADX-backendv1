import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { z } from 'zod';
import { bookingReportPdf, spotInsights, type BookingActor } from './booking-report.service';

const paramsSchema = z.object({ orderId: z.string().trim().min(1).max(64) });

function actorOf(req: Request): BookingActor {
  return { userId: req.user!.sub, roles: req.user!.roles };
}

function orderIdOf(req: Request): string {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order id', parsed.error.flatten());
  return parsed.data.orderId;
}

/** GET /publishers/me/bookings/:orderId/report.pdf — rendered now, stored for the publisher, streamed inline. */
export async function bookingReportPdfHandler(req: Request, res: Response): Promise<void> {
  const result = await bookingReportPdf(orderIdOf(req), actorOf(req), req);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${result.filename}"`);
  if (result.fileId) res.set('X-ADX-File-Id', result.fileId);
  res.send(result.buffer);
}

/** GET /publishers/me/bookings/:orderId/insights — `{ scans, estimatedReach, interactions }`, behind the flag. */
export async function spotInsightsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await spotInsights(orderIdOf(req), actorOf(req)) });
}
