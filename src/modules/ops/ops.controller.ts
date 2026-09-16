import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { opsHealth } from './ops.service';
import { systemHealthHistory } from './ops-history.service';
import { addIncidentUpdate, createIncident, getIncident, listIncidents, patchIncident } from './incidents.service';
import { createIncidentSchema, incidentIdParamSchema, incidentUpdateSchema, listIncidentsQuerySchema, patchIncidentSchema, subscribeSchema, subscriberTokenParamSchema } from './ops.schema';
import { confirmSubscription, publicStatus, regions, subscribe, unsubscribe } from './status.service';

function invalid(error: { flatten(): unknown }, what = 'request'): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}`, error.flatten());
}

function incidentId(req: Request): string {
  const params = incidentIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  return params.data.id;
}

/** GET /settings/system-health/ops — the housekeeping, in one read. */
export async function getOpsHealthHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await opsHealth() });
}

/** E6: GET /settings/system-health/history — the job heartbeats, thirty days of 5xx counts and (Lot G) the per-service sample series. */
export async function getSystemHealthHistoryHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await systemHealthHistory() });
}

/** Lot G (Q130): GET /settings/system-health/regions — where this API runs, with a live round trip. */
export async function getRegionsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await regions() });
}

/* ── incidents (ADMIN) ───────────────────────────────────────────── */

export async function listIncidentsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listIncidentsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, service, ...page } = parsed.data;
  const { items, total, counts } = await listIncidents({ q, status, service }, page);
  res.json({ success: true, data: toListPage(items, total, counts, page) });
}

export async function getIncidentHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getIncident(incidentId(req)) });
}

export async function createIncidentHandler(req: Request, res: Response): Promise<void> {
  const parsed = createIncidentSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const incident = await createIncident(parsed.data, req.user!.sub, req);
  res.status(201).json({ success: true, data: incident });
}

export async function addIncidentUpdateHandler(req: Request, res: Response): Promise<void> {
  const id = incidentId(req);
  const parsed = incidentUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.status(201).json({ success: true, data: await addIncidentUpdate(id, parsed.data, req.user!.sub, req) });
}

export async function patchIncidentHandler(req: Request, res: Response): Promise<void> {
  const id = incidentId(req);
  const parsed = patchIncidentSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await patchIncident(id, parsed.data, req.user!.sub, req) });
}

/* ── the public status page ──────────────────────────────────────── */

export async function publicStatusHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await publicStatus() });
}

/** POST /status/subscribe — always 202: the answer never says whether the address was already on the list. */
export async function subscribeHandler(req: Request, res: Response): Promise<void> {
  const parsed = subscribeSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  await subscribe(parsed.data.email);
  res.status(202).json({ success: true, data: { message: 'If this address is new, a confirmation email is on its way.' } });
}

const page = (heading: string, text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ADX status</title></head><body style="font-family:sans-serif;padding:40px">` +
  `<h2>${heading}</h2><p>${text}</p></body></html>`;

/** GET /status/confirm/:token — a link in an email, so the answer is a page, not JSON. */
export async function confirmSubscriptionHandler(req: Request, res: Response): Promise<void> {
  const params = subscriberTokenParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'token');
  const { alreadyConfirmed } = await confirmSubscription(params.data.token);
  res
    .status(200)
    .type('html')
    .send(page(alreadyConfirmed ? 'You were already subscribed' : 'You are subscribed', 'ADX will email you when an incident is opened, updated or resolved. Every email carries an unsubscribe link.'));
}

/** GET /status/unsubscribe/:token — the same, in reverse. */
export async function unsubscribeHandler(req: Request, res: Response): Promise<void> {
  const params = subscriberTokenParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'token');
  await unsubscribe(params.data.token);
  res.status(200).type('html').send(page('You are unsubscribed', 'ADX will not email you status updates any more.'));
}
