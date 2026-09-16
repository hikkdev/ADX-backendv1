import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { auditPageSchema, exportAuditQuerySchema, listAuditQuerySchema, targetParamsSchema } from './audit.schema';
import { csvHeader, csvLine, EXPORT_ROW_CAP, iterateAuditRows, listAudit, targetTimeline } from './audit.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// GET /audit — the list contract over the whole trail, actor joined.
export async function listAuditHandler(req: Request, res: Response): Promise<void> {
  const parsed = listAuditQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { sort, page, pageSize, ...filter } = parsed.data;
  res.json({ success: true, data: await listAudit(filter, { sort, page, pageSize }) });
}

// GET /audit/export.csv — the same filter, streamed, capped, and itself audited.
export async function exportAuditHandler(req: Request, res: Response): Promise<void> {
  const parsed = exportAuditQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { sort, ...filter } = parsed.data;

  // Logged before the first byte: an export that fails half-way was still an
  // export, and this row is what says who pulled the trail and when.
  await logActivity(req.user!.sub, 'AUDIT_EXPORTED', {
    req,
    module: 'audit',
    metadata: {
      filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() },
      sort,
      cap: EXPORT_ROW_CAP,
    },
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write(csvHeader());
  for await (const rows of iterateAuditRows(filter, sort)) {
    res.write(rows.map(csvLine).join(''));
  }
  res.end();
}

// GET /audit/targets/:targetType/:targetId — one record's timeline.
export async function targetTimelineHandler(req: Request, res: Response): Promise<void> {
  const params = targetParamsSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error);
  const page = auditPageSchema.safeParse(req.query);
  if (!page.success) throw invalid(page.error);
  res.json({ success: true, data: await targetTimeline(params.data, page.data) });
}
