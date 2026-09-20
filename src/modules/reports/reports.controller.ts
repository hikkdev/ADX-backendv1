import type { NextFunction, Request, Response } from 'express';
import { prismaReportData } from './prisma-reports.repository';
import { resolveWindow } from './windows';
import type { OnboardingBoardRow } from './reports.repository';
import { onboardingBoardQuerySchema } from './reports.schema';
import { authenticate, requireRole } from '../../shared/auth';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { toListPage } from '../../shared/pagination';
import type { OpenedFile } from '../uploads';
import {
  createScheduleSchema,
  fileTokenQuerySchema,
  listRunsQuerySchema,
  listSchedulesQuerySchema,
  runIdParamSchema,
  runReportSchema,
  scheduleIdParamSchema,
  updateScheduleSchema,
} from './reports.schema';
import {
  createSchedule,
  deleteSchedule,
  describedCatalogue,
  getRun,
  getSchedule,
  isValidRunLink,
  listRuns,
  listSchedules,
  openRunFile,
  runReportForAdmin,
  runView,
  updateSchedule,
} from './reports.service';

function invalid(error: { flatten(): unknown }, what = 'request'): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}`, error.flatten());
}

/** GET /reports/catalogue — the twelve kinds, their filters and columns. */
export function catalogueHandler(_req: Request, res: Response): void {
  res.json({ success: true, data: describedCatalogue() });
}

/** POST /reports/run — rendered now; answers the run (its id, status, row count, expiry). */
// QR-14: GET /reports/boards/onboarding?preset=last30 | from=&to= [&via=&role=] — the team board, ranked.
export async function onboardingBoardHandler(req: Request, res: Response): Promise<void> {
  const parsed = onboardingBoardQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { via, role, ...windowInput } = parsed.data;
  const window = resolveWindow('preset' in windowInput && windowInput.preset ? { preset: windowInput.preset } : { from: windowInput.from!, to: windowInput.to! });
  const rows = await prismaReportData.onboardingBoard(window, { via, role });
  res.json({
    success: true,
    data: {
      window: { from: window.from, to: window.to, label: window.label },
      rows: rows.map((row: OnboardingBoardRow, i: number) => ({ ...row, rank: row.actorId ? i + 1 : null })),
    },
  });
}

export async function runHandler(req: Request, res: Response): Promise<void> {
  const parsed = runReportSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const run = await runReportForAdmin(parsed.data, req.user!.sub, req);
  if (run.status === 'FAILED') {
    throw new ApiError(500, 'REPORT_FAILED', 'The report could not be rendered', { runId: run.id, error: run.error });
  }
  res.status(201).json({ success: true, data: runView(run) });
}

export async function listRunsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listRunsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, kind, scheduleId, ...page } = parsed.data;
  const { items, total, counts, summary } = await listRuns({ q, status, kind, scheduleId }, page);
  // G13-B: the week's figures ride beside the page.
  res.json({ success: true, data: { ...toListPage(items, total, counts, page), summary } });
}

export async function getRunHandler(req: Request, res: Response): Promise<void> {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  res.json({ success: true, data: runView(await getRun(params.data.id)) });
}

/**
 * The file route's guard: a valid signed link (`?t=`) opens the run it was
 * minted for; anything else has to be an ADMIN bearer token. The signed
 * path never sets `req.user`, so the handler knows which it was.
 */
export function signedLinkOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const params = runIdParamSchema.safeParse(req.params);
  const query = fileTokenQuerySchema.safeParse(req.query);
  if (params.success && query.success && query.data.t && isValidRunLink(params.data.id, query.data.t)) {
    res.locals['signedLink'] = true;
    next();
    return;
  }
  try {
    authenticate(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      try {
        requireRole('ADMIN')(req, res, next);
      } catch (guardErr) {
        next(guardErr);
      }
    });
  } catch (err) {
    next(err);
  }
}

async function sendStored(res: Response, opened: OpenedFile, filename: string, mimeType: string): Promise<boolean> {
  res.set('Content-Type', mimeType);
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.set('Cache-Control', 'private, no-store');
  if (opened.kind === 'stream') {
    await new Promise<void>((resolve, reject) => res.sendFile(opened.path, (err) => (err ? reject(err) : resolve()))).catch((err: unknown) => {
      logger.warn('Could not stream the stored report', { path: opened.path, err });
    });
    return res.headersSent;
  }
  // A presigned read: fetched here and sent, never handed on as a redirect a mail client would follow blind.
  const upstream = await fetch(opened.url).catch(() => null);
  if (!upstream || !upstream.ok) return false;
  res.send(Buffer.from(await upstream.arrayBuffer()));
  return true;
}

/** GET /reports/runs/:id/file — the bytes, as an attachment; 410 past thirty days. */
export async function runFileHandler(req: Request, res: Response): Promise<void> {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  const { run, opened, filename } = await openRunFile(params.data.id);
  const mimeType = run.format === 'PDF' ? 'application/pdf' : 'text/csv; charset=utf-8';
  if (!(await sendStored(res, opened, filename, mimeType))) {
    throw new ApiError(502, 'STORAGE_UNAVAILABLE', 'The report file could not be read from storage');
  }
}

/* ── schedules ───────────────────────────────────────────────────── */

export async function listSchedulesHandler(req: Request, res: Response): Promise<void> {
  const parsed = listSchedulesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, kind, ...page } = parsed.data;
  const { items, total, counts } = await listSchedules({ q, status, kind }, page);
  res.json({ success: true, data: toListPage(items, total, counts, page) });
}

export async function createScheduleHandler(req: Request, res: Response): Promise<void> {
  const parsed = createScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const schedule = await createSchedule(parsed.data, req.user!.sub, req);
  res.status(201).json({ success: true, data: schedule });
}

export async function getScheduleHandler(req: Request, res: Response): Promise<void> {
  const params = scheduleIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  res.json({ success: true, data: await getSchedule(params.data.id) });
}

export async function updateScheduleHandler(req: Request, res: Response): Promise<void> {
  const params = scheduleIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  const parsed = updateScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await updateSchedule(params.data.id, parsed.data, req.user!.sub, req) });
}

export async function deleteScheduleHandler(req: Request, res: Response): Promise<void> {
  const params = scheduleIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  await deleteSchedule(params.data.id, req.user!.sub, req);
  res.json({ success: true, data: { id: params.data.id, deleted: true } });
}
