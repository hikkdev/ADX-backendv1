import type { Request, Response } from 'express';

import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  adminLeadsQuerySchema,
  convertLeadSchema,
  createLeadSchema,
  importLeadsSchema,
  logContactSchema,
  nearLeadsQuerySchema,
  patchLeadSchema,
} from './leads.schema';
import {
  bookVisit,
  convertLead,
  createLead,
  getLead,
  importLeads,
  leadsForAdmin,
  leadsNear,
  logContact,
  patchLead,
} from './leads.service';

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
  res.json({ success: true, data: await leadsNear(query) });
}

export async function getLeadHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getLead(req.params['leadId'] as string) });
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

export async function patchLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchLeadSchema, req.body);
  const lead = await patchLead(req.params['leadId'] as string, req.user!.sub, body as Record<string, unknown>);
  await logActivity(req.user!.sub, 'LEAD_UPDATED', req, { leadId: lead.id });
  res.json({ success: true, data: lead });
}
