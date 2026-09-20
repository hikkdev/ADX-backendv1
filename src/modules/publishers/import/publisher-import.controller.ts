import type { Request, Response } from 'express';
import { actorLabelFor } from '../../access-control';
import { ApiError } from '../../../shared/errors';
import { importBodySchema } from './publisher-import.schema';
import { commitImport, getImport, importReportCsv, listImports, parseImportCsv, revokeImport, validateImport } from './publisher-import.service';

/**
 * POST /publishers/import — Lot D (Q43/Q86).
 *
 * Two shapes in: a multipart CSV under `file` (the `uploads` CSV multer runs
 * ahead of this handler and leaves it in memory), or a JSON body of rows.
 * One shape out: a VALIDATED import with its per-row plan.
 */
export async function importPublishersHandler(req: Request, res: Response): Promise<void> {
  const file = req.file as { originalname: string; buffer: Buffer } | undefined;
  if (file) {
    const rows = parseImportCsv(file.buffer.toString('utf8'));
    if (rows.length === 0) throw new ApiError(400, 'BAD_REQUEST', 'The CSV has a header and no rows');
    const note = typeof req.body?.['note'] === 'string' ? (req.body['note'] as string).trim().slice(0, 500) : undefined;
    res.status(201).json({ success: true, data: await validateImport({ fileName: file.originalname, note, rows }, req.user!.sub, req) });
    return;
  }

  const parsed = importBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Send a CSV under `file` or a JSON body of rows', parsed.error.flatten());
  const rows = parsed.data.rows.map((data, index) => ({ rowNumber: index + 1, data }));
  res.status(201).json({
    success: true,
    data: await validateImport({ fileName: parsed.data.fileName, note: parsed.data.note, rows }, req.user!.sub, req),
  });
}

export async function listImportsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listImports() });
}

export async function getImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getImport(req.params['id'] as string) });
}

export async function commitImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await commitImport(req.params['id'] as string, req.user!.sub, req, await actorLabelFor(req.user!.sub, req.user?.roles ?? [])) });
}

export async function revokeImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await revokeImport(req.params['id'] as string, req.user!.sub, req) });
}

export async function importReportHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const csv = await importReportCsv(id);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="publisher-import-${id}.csv"`);
  res.send(csv);
}
