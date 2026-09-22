import type { Request, Response } from 'express';

import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  adminLeadsQuerySchema,
  convertLeadSchema,
  createLeadSchema,
  flagHotSchema,
  funnelQuerySchema,
  importLeadsSchema,
  logContactSchema,
  markEngagedSchema,
  markLostSchema,
  markProposedSchema,
  moveStageSchema,
  nearLeadsQuerySchema,
  patchLeadSchema,
  patchSourceSchema,
} from './leads.schema';
import {
  bookVisit,
  convertLead,
  createLead,
  flagHot,
  getLead,
  importLeads,
  leadsForAdmin,
  leadsNear,
  listSources,
  logContact,
  patchLead,
  patchSource,
} from './leads.service';
import { recomputeLead } from './scoring.service';
import { captureLead, captureLeadSchema } from './capture.service';
import { funnel, markEngaged, markProposed, moveStage } from './stages.service';

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  }
  return result.data as T;
};

/* ── The agent's own list ──────────────────────────────────────────── */

export async function leadsNearHandler(req: Request, res: Response): Promise<void> {
  const query = parse(nearLeadsQuerySchema, req.query);
  // AG-5: the list is the viewer's — narrowed to the bands their grade may take.
  res.json({ success: true, data: await leadsNear(query, req.user ? { userId: req.user.sub } : undefined) });
}

export async function getLeadHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getLead(req.params['leadId'] as string, req.user!.sub) });
}

export async function logContactHandler(req: Request, res: Response): Promise<void> {
  const body = parse(logContactSchema, req.body);
  res.json({ success: true, data: await logContact(req.params['leadId'] as string, req.user!.sub, body) });
}

export async function bookVisitHandler(req: Request, res: Response): Promise<void> {
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  const scheduledFor = typeof req.body?.scheduledFor === 'string' ? req.body.scheduledFor : undefined;
  res.json({
    success: true,
    data: await bookVisit(req.params['leadId'] as string, req.user!.sub, note, scheduledFor),
  });
}

/** LH1: the agent's flag. */
export async function flagHotHandler(req: Request, res: Response): Promise<void> {
  const body = parse(flagHotSchema, req.body ?? {});
  res.json({ success: true, data: await flagHot(req.params['leadId'] as string, req.user!.sub, body.hot) });
}

export async function convertLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(convertLeadSchema, req.body);
  const lead = await convertLead(req.params['leadId'] as string, req.user!.sub, body);
  await logActivity(req.user!.sub, 'LEAD_CONVERTED', req, { leadId: lead.id });
  res.json({ success: true, data: lead });
}

/* ── The ops desk ──────────────────────────────────────────────────── */

export async function adminLeadsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(adminLeadsQuerySchema, req.query);
  res.json({ success: true, data: await leadsForAdmin(query) });
}

export async function createLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createLeadSchema, req.body);
  const lead = await createLead(body, req.user!.sub);
  await logActivity(req.user!.sub, 'LEAD_CREATED', req, { leadId: lead.id });
  res.status(201).json({ success: true, data: lead });
}

export async function importLeadsHandler(req: Request, res: Response): Promise<void> {
  const body = parse(importLeadsSchema, req.body);
  const result = await importLeads(body.source, body.rows, req.user!.sub, { dryRun: body.dryRun });
  // A dry run writes nothing and is not an import; the tap still records the read.
  if (!body.dryRun) {
    await logActivity(req.user!.sub, 'LEADS_IMPORTED', {
      req,
      module: 'leads',
      targetType: 'Lead',
      metadata: {
        source: body.source,
        rows: body.rows.length,
        imported: result.imported,
        skipped: result.skipped,
        warnings: result.warnings,
        ids: result.ids,
      },
    });
  }
  res.status(body.dryRun ? 200 : 201).json({ success: true, data: result });
}

/* ── LH4: street capture ───────────────────────────────────────────── */

/** The agent's "Spot a lead" — audited under the agent, since it is the one write an agent makes that opens a row. */
export async function captureLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(captureLeadSchema, req.body);
  const lead = await captureLead(req.user!.sub, body);
  await logActivity(req.user!.sub, 'LEAD_CAPTURED', { req, module: 'leads', targetType: 'Lead', targetId: lead.id, metadata: { side: body.side, category: body.category, photos: body.photoFileIds.length, latitude: body.latitude, longitude: body.longitude } });
  res.status(201).json({ success: true, data: lead });
}

/* ── LH2: the stages ───────────────────────────────────────────────── */

/** The desk's move — forward, or LOST with a reason. Audited. */
export async function moveStageHandler(req: Request, res: Response): Promise<void> {
  const body = parse(moveStageSchema, req.body);
  const leadId = req.params['leadId'] as string;
  await moveStage(leadId, body.stage, 'ADMIN', { actorUserId: req.user!.sub, reason: body.reason, lostNote: body.lostNote, note: body.note ?? null });
  const lead = await getLead(leadId, req.user!.sub);
  await logActivity(req.user!.sub, 'LEAD_STAGE_MOVED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { stage: body.stage, reason: body.reason ?? null, note: body.note ?? null } });
  res.json({ success: true, data: lead });
}

/** The agent's loss — a reason, a note. */
export async function markLostHandler(req: Request, res: Response): Promise<void> {
  const body = parse(markLostSchema, req.body);
  const leadId = req.params['leadId'] as string;
  await moveStage(leadId, 'LOST', 'AGENT', { actorUserId: req.user!.sub, reason: body.reason, lostNote: body.note });
  res.json({ success: true, data: await getLead(leadId, req.user!.sub) });
}

/** They replied — ENGAGED. */
export async function markEngagedHandler(req: Request, res: Response): Promise<void> {
  const body = parse(markEngagedSchema, req.body ?? {});
  const leadId = req.params['leadId'] as string;
  await markEngaged(leadId, req.user!.sub, { note: body.note, channel: body.channel });
  res.json({ success: true, data: await getLead(leadId, req.user!.sub) });
}

/** A proposal went out — PROPOSED. */
export async function markProposedHandler(req: Request, res: Response): Promise<void> {
  const body = parse(markProposedSchema, req.body ?? {});
  const leadId = req.params['leadId'] as string;
  await markProposed(leadId, req.user!.sub, body.note);
  res.json({ success: true, data: await getLead(leadId, req.user!.sub) });
}

/** GET /leads/funnel — aggregates only. */
export async function funnelHandler(req: Request, res: Response): Promise<void> {
  const query = parse(funnelQuerySchema, req.query);
  res.json({ success: true, data: await funnel(query) });
}

/* ── LH1: sources and the score ────────────────────────────────────── */

export async function listSourcesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listSources() });
}

export async function patchSourceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchSourceSchema, req.body);
  const source = await patchSource(req.params['sourceId'] as string, body);
  await logActivity(req.user!.sub, 'LEAD_SOURCE_UPDATED', { req, module: 'leads', targetType: 'LeadSource', targetId: source.id, metadata: { patch: body } });
  res.json({ success: true, data: source });
}

/** The desk asks for a fresh score now rather than at the next touch or tonight. */
export async function rescoreLeadHandler(req: Request, res: Response): Promise<void> {
  const result = await recomputeLead(req.params['leadId'] as string);
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  res.json({ success: true, data: await getLead(req.params['leadId'] as string, req.user!.sub) });
}

export async function patchLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchLeadSchema, req.body);
  const lead = await patchLead(req.params['leadId'] as string, req.user!.sub, body as Record<string, unknown>);
  await logActivity(req.user!.sub, 'LEAD_UPDATED', req, { leadId: lead.id });
  res.json({ success: true, data: lead });
}
