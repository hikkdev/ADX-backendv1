import type { Request } from 'express';
import type { Prisma, ReportCadence, ReportFormat, ReportRun, ReportSchedule } from '../../shared/database';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import type { ListQuery } from '../../shared/pagination';
import { notify } from '../notifications';
import { openStoredFile, storeGeneratedFile, type OpenedFile } from '../uploads';
import { listAdminUserIds, systemUserId } from '../users';
import { buildCatalogue, describeCatalogue, filterSchemaFor, type ReportKind } from './catalogue';
import { runFileUrl, verifyRunFileToken } from './links';
import { prismaReportData, prismaReportsRepository as repository } from './prisma-reports.repository';
import { MAILED_KEY, type RunFilter, type ScheduleFilter } from './reports.repository';
import { renderCsv, renderPdf } from './render';
import { fixedWindowSchema } from './reports.schema';
import { nextRunAtFor, resolveWindow, weekStartIST, windowForCadence, type LabelledWindow, type WindowInput } from './windows';

/**
 * Reports — Lot G (Q129/Q143).
 *
 * A run is rendered in the request: the kind's query answers rows for the
 * window, the rows become a CSV or a PDF, the bytes go to a PRIVATE file
 * (`REPORT`, behind `/files/:id` like an invoice) and the run row says
 * where. It stays readable for thirty days, by an admin's token or by the
 * signed link a schedule mails, then the file route answers 410.
 *
 * A schedule is a kind, a cadence and a list of addresses. The job runs
 * whatever is due, mails each recipient a link, and moves `nextRunAt` on
 * whether or not the run succeeded — a report that fails every morning
 * should fail once a morning, not every five minutes.
 */

const MODULE = 'reports';
export const RUN_EXPIRY_DAYS = 30;

export const catalogue: readonly ReportKind[] = buildCatalogue(prismaReportData);
export const describedCatalogue = () => describeCatalogue(catalogue);

export function kindNamed(kind: string): ReportKind {
  const found = catalogue.find((entry) => entry.kind === kind);
  if (!found) throw new ApiError(400, 'VALIDATION_ERROR', `Unknown report kind: ${kind}`);
  return found;
}

/** The kind's own filter contract: a key it does not declare is a 400, not a silent no-op. */
export function parseFilters(kind: ReportKind, raw: Record<string, string | undefined>): Record<string, string | undefined> {
  const parsed = filterSchemaFor(kind).safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid filters for ${kind.kind}`, parsed.error.flatten());
  return parsed.data as Record<string, string | undefined>;
}

const asJson = (filters: Record<string, string | undefined>): Prisma.InputJsonValue | null => {
  const entries = Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : null;
};

/* ── runs ────────────────────────────────────────────────────────── */

export interface RunInput {
  kind: ReportKind;
  format: ReportFormat;
  filters: Record<string, string | undefined>;
  window: LabelledWindow;
  /** The admin who pressed Run; null for a schedule. */
  requestedById: string | null;
  scheduleId?: string | null;
}

/**
 * Renders now. The file is stored under `fileOwnerId` — the requester, or
 * the system account for a schedule — because an UploadedFile needs an
 * uploader. Never throws for a report that fails: the run row is marked
 * FAILED with the reason and returned, so a schedule can carry on to the
 * next one and a request can answer with the id.
 */
export async function runReport(input: RunInput, fileOwnerId: string, now = new Date()): Promise<ReportRun> {
  const run = await repository.createRun({
    kind: input.kind.kind,
    format: input.format,
    filters: asJson(input.filters),
    scheduleId: input.scheduleId ?? null,
    requestedById: input.requestedById,
  });
  try {
    const rows = await input.kind.query(input.filters, input.window);
    const rendered =
      input.format === 'PDF'
        ? await renderPdf({ title: input.kind.name, windowLabel: input.window.label, generatedAt: now, columns: input.kind.columns, rows })
        : renderCsv(input.kind.columns, rows);
    const stored = await storeGeneratedFile(fileOwnerId, {
      content: rendered.buffer,
      filename: `${input.kind.kind}-${input.window.from}-to-${input.window.to}.${rendered.extension}`,
      mimeType: rendered.mimeType,
      purpose: 'REPORT',
    });
    return await repository.updateRun(run.id, {
      status: 'READY',
      fileId: stored.id,
      rowCount: rows.length,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + RUN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error('Report run failed', { runId: run.id, kind: input.kind.kind, err });
    return repository.updateRun(run.id, { status: 'FAILED', error: message, finishedAt: now });
  }
}

/** POST /reports/run — an admin's own run, audited against the run row. */
export async function runReportForAdmin(
  input: { kind: string; format: ReportFormat; filters: Record<string, string | undefined>; window: WindowInput },
  actorId: string,
  req?: Request,
): Promise<ReportRun> {
  const kind = kindNamed(input.kind);
  const filters = parseFilters(kind, input.filters);
  const window = resolveWindow(input.window);
  const run = await runReport({ kind, format: input.format, filters, window, requestedById: actorId }, actorId);
  await logActivity(actorId, 'REPORT_RUN', {
    req,
    module: MODULE,
    targetType: 'ReportRun',
    targetId: run.id,
    metadata: { kind: kind.kind, format: input.format, window: window.label, filters: asJson(filters), status: run.status, rowCount: run.rowCount },
  });
  return run;
}

/** G11-2: a run as the console reads it — the filters the kind declares, and who the schedule mailed it to. */
export type RunView = ReportRun & { mailedTo: number | null; mailedAt: string | null };

/**
 * Splits the mailing record back out of the run's `filters` JSON (see
 * `recordMailed`): `mailedTo` / `mailedAt` on the row, `filters` left as
 * the declared filters alone. A run by hand, or one the schedule could not
 * mail, answers null for both.
 */
export function runView(run: ReportRun): RunView {
  const raw = run.filters && typeof run.filters === 'object' && !Array.isArray(run.filters) ? (run.filters as Record<string, unknown>) : null;
  const { [MAILED_KEY]: mailed, ...filters } = raw ?? {};
  const record = mailed && typeof mailed === 'object' && !Array.isArray(mailed) ? (mailed as Record<string, unknown>) : null;
  return {
    ...run,
    filters: raw ? (filters as Prisma.JsonObject) : run.filters,
    mailedTo: typeof record?.['to'] === 'number' ? record['to'] : null,
    mailedAt: typeof record?.['at'] === 'string' ? record['at'] : null,
  };
}

/**
 * G13-B: the figures over the runs list — READY runs started this Indian
 * week (Monday 00:00 IST), the runs a schedule mailed this week (by their
 * `mailedAt`), and the distinct addresses across the enabled schedules'
 * recipient sets, an empty set standing for every admin with an email.
 */
export type RunsSummary = { readyThisWeek: number; mailedThisWeek: number; uniqueRecipients: number };

export async function runsSummary(now = new Date()): Promise<RunsSummary> {
  const since = weekStartIST(now);
  const [runs, sets] = await Promise.all([repository.findRunsStartedSince(since), repository.enabledScheduleRecipients()]);
  const views = runs.map(runView);
  const readyThisWeek = views.filter((run) => run.status === 'READY').length;
  const mailedThisWeek = views.filter((run) => run.mailedAt !== null && Date.parse(run.mailedAt) >= since.getTime()).length;
  const recipients = new Set<string>();
  const admins = sets.some((set) => set.length === 0) ? await repository.adminEmails() : [];
  for (const set of sets) for (const email of set.length ? set : admins) recipients.add(email.trim().toLowerCase());
  return { readyThisWeek, mailedThisWeek, uniqueRecipients: recipients.size };
}

export async function listRuns(filter: RunFilter, page: ListQuery): Promise<{ items: RunView[]; total: number; counts: Record<string, number>; summary: RunsSummary }> {
  const [{ items, ...rest }, summary] = await Promise.all([repository.listRuns(filter, page), runsSummary()]);
  return { items: items.map(runView), ...rest, summary };
}

export async function getRun(id: string): Promise<ReportRun> {
  const run = await repository.findRun(id);
  if (!run) throw new ApiError(404, 'NOT_FOUND', 'Report run not found');
  return run;
}

/**
 * The file behind a run, for a caller the route has already let through —
 * an admin, or a signed link. 409 while it is still rendering, 404 when it
 * failed, 410 once the thirty days are up.
 */
export async function openRunFile(id: string, now = new Date()): Promise<{ run: ReportRun; opened: OpenedFile; filename: string }> {
  const run = await getRun(id);
  if (run.status === 'RUNNING') throw new ApiError(409, 'REPORT_NOT_READY', 'The report is still rendering');
  if (run.status === 'FAILED' || !run.fileId) throw new ApiError(404, 'NOT_FOUND', 'This report run has no file');
  if (run.expiresAt && run.expiresAt.getTime() <= now.getTime()) throw new ApiError(410, 'REPORT_EXPIRED', 'This report has expired');
  const opened = await openStoredFile(run.fileId);
  if (!opened) throw new ApiError(404, 'NOT_FOUND', 'The report file is gone');
  const filename = opened.kind === 'stream' ? opened.filename : `${run.kind}.${run.format === 'PDF' ? 'pdf' : 'csv'}`;
  return { run, opened, filename };
}

export const isValidRunLink = (runId: string, token: string, now = new Date()): boolean => verifyRunFileToken(runId, token, now);

/* ── schedules ───────────────────────────────────────────────────── */

/** G13-B: the reserved key a schedule's fixed window sits under in its `filters` JSON — never a filter a kind declares. */
export const SCHEDULE_WINDOW_KEY = 'window';

export type FixedWindow = { from: string; to: string };

/**
 * G13-B: a schedule's filters as they come in — the kind's own strings,
 * validated by the catalogue, and the optional fixed `window` kept beside
 * them (`null` drops it). What comes back is the JSON the row stores.
 */
function parseScheduleFilters(kind: ReportKind, raw: Record<string, unknown>): Prisma.InputJsonValue | null {
  const { [SCHEDULE_WINDOW_KEY]: window, ...rest } = raw;
  const filters = asJson(parseFilters(kind, rest as Record<string, string | undefined>));
  if (window === null || window === undefined) return filters;
  const parsed = fixedWindowSchema.safeParse(window);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid schedule window', parsed.error.flatten());
  return { ...((filters as Record<string, string>) ?? {}), [SCHEDULE_WINDOW_KEY]: parsed.data };
}

/** G13-B: the fixed window a stored schedule carries, if any — read back leniently, never trusted past the schema. */
export function scheduleFixedWindow(filters: unknown): FixedWindow | null {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const parsed = fixedWindowSchema.safeParse((filters as Record<string, unknown>)[SCHEDULE_WINDOW_KEY]);
  return parsed.success ? parsed.data : null;
}

export interface ScheduleInput {
  kind: string;
  name: string;
  cadence: ReportCadence;
  format: ReportFormat;
  recipients: string[];
  /** The kind's string filters, plus (G13-B) an optional `window: { from, to } | null`. */
  filters: Record<string, unknown>;
  enabled: boolean;
}

const AUDITED_SCHEDULE_FIELDS = ['name', 'kind', 'cadence', 'format', 'recipients', 'filters', 'enabled', 'nextRunAt'] as const;

export async function createSchedule(input: ScheduleInput, actorId: string, req?: Request, now = new Date()): Promise<ReportSchedule> {
  const kind = kindNamed(input.kind);
  const filters = parseScheduleFilters(kind, input.filters);
  const schedule = await repository.createSchedule({
    kind: kind.kind,
    name: input.name,
    cadence: input.cadence,
    format: input.format,
    recipients: input.recipients,
    filters,
    enabled: input.enabled,
    createdById: actorId,
    nextRunAt: nextRunAtFor(input.cadence, now),
  });
  await logActivity(actorId, 'REPORT_SCHEDULE_CREATED', {
    req,
    module: MODULE,
    targetType: 'ReportSchedule',
    targetId: schedule.id,
    diff: auditDiff(null, schedule, AUDITED_SCHEDULE_FIELDS),
    metadata: { recipientCount: schedule.recipients.length },
  });
  return schedule;
}

export async function getSchedule(id: string): Promise<ReportSchedule> {
  const schedule = await repository.findSchedule(id);
  if (!schedule) throw new ApiError(404, 'NOT_FOUND', 'Report schedule not found');
  return schedule;
}

export function listSchedules(filter: ScheduleFilter, page: ListQuery) {
  return repository.listSchedules(filter, page);
}

export async function updateSchedule(id: string, patch: Partial<Omit<ScheduleInput, 'kind'>>, actorId: string, req?: Request, now = new Date()): Promise<ReportSchedule> {
  const before = await getSchedule(id);
  const kind = kindNamed(before.kind);
  const filters = patch.filters !== undefined ? parseScheduleFilters(kind, patch.filters) : undefined;
  const cadence = patch.cadence ?? before.cadence;
  const enabled = patch.enabled ?? before.enabled;
  // A cadence change or a re-enable recomputes the next fire; a disable leaves it, so the page still shows when it would have run.
  const nextRunAt =
    (patch.cadence !== undefined && patch.cadence !== before.cadence) || (enabled && !before.enabled) ? nextRunAtFor(cadence, now) : undefined;
  const after = await repository.updateSchedule(id, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
    ...(patch.format !== undefined ? { format: patch.format } : {}),
    ...(patch.recipients !== undefined ? { recipients: patch.recipients } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  });
  await logActivity(actorId, 'REPORT_SCHEDULE_UPDATED', {
    req,
    module: MODULE,
    targetType: 'ReportSchedule',
    targetId: id,
    diff: auditDiff(before, after, AUDITED_SCHEDULE_FIELDS),
  });
  return after;
}

export async function deleteSchedule(id: string, actorId: string, req?: Request): Promise<void> {
  const before = await getSchedule(id);
  await repository.deleteSchedule(id);
  await logActivity(actorId, 'REPORT_SCHEDULE_DELETED', {
    req,
    module: MODULE,
    targetType: 'ReportSchedule',
    targetId: id,
    diff: auditDiff(before, null, AUDITED_SCHEDULE_FIELDS),
    metadata: { kind: before.kind, name: before.name },
  });
}

/* ── the job's tick ──────────────────────────────────────────────── */

export interface DueScheduleOutcome {
  scheduleId: string;
  runId: string;
  status: ReportRun['status'];
  recipients: number;
}

/** The system account, the first admin as a stand-in; null means nothing can be stored. */
async function fileOwner(): Promise<string | null> {
  return (await systemUserId()) ?? (await listAdminUserIds())[0] ?? null;
}

/**
 * Every enabled schedule whose time has come: render, mail, move on. A
 * schedule with no recipients mails every ADMIN account with an email. A
 * run that failed is not mailed — the run row and the log say why — and
 * the schedule still advances. Returns what happened, for the job's log.
 */
export async function runDueSchedules(now = new Date()): Promise<DueScheduleOutcome[]> {
  const due = await repository.findDueSchedules(now);
  if (due.length === 0) return [];
  const owner = await fileOwner();
  if (!owner) {
    logger.warn('Report schedules skipped: no system or admin account to store the files under', { due: due.length });
    return [];
  }
  const outcomes: DueScheduleOutcome[] = [];
  for (const schedule of due) {
    const outcome = await runSchedule(schedule, owner, now);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function runSchedule(schedule: ReportSchedule, owner: string, now: Date): Promise<DueScheduleOutcome> {
  const kind = kindNamed(schedule.kind);
  const stored = schedule.filters && typeof schedule.filters === 'object' && !Array.isArray(schedule.filters) ? (schedule.filters as Record<string, unknown>) : {};
  // G13-B: the fixed window, when the schedule carries one, is rendered instead of the cadence's own.
  const { [SCHEDULE_WINDOW_KEY]: _window, ...rawFilters } = stored;
  const fixed = scheduleFixedWindow(stored);
  const window = fixed ? resolveWindow(fixed, now) : windowForCadence(schedule.cadence, now);
  let run: ReportRun;
  try {
    run = await runReport(
      { kind, format: schedule.format, filters: parseFilters(kind, rawFilters as Record<string, string | undefined>), window, requestedById: null, scheduleId: schedule.id },
      owner,
      now,
    );
  } catch (err) {
    // parseFilters on a schedule whose kind changed shape — advance and report, never loop.
    logger.error('Report schedule could not run', { scheduleId: schedule.id, err });
    await repository.updateSchedule(schedule.id, { lastRunAt: now, nextRunAt: nextRunAtFor(schedule.cadence, now) });
    return { scheduleId: schedule.id, runId: '', status: 'FAILED', recipients: 0 };
  }

  let mailed = 0;
  if (run.status === 'READY' && run.expiresAt) {
    const recipients = schedule.recipients.length ? schedule.recipients : await repository.adminEmails();
    const url = runFileUrl(run.id, run.expiresAt);
    for (const email of recipients) {
      const result = await notify(
        'REPORT_READY',
        null,
        {
          reportName: schedule.name,
          window: window.label,
          rowCount: run.rowCount ?? 0,
          format: run.format,
          url,
          expiresAt: run.expiresAt.toISOString().slice(0, 10),
        },
        { recipient: { email }, type: 'SYSTEM' },
      );
      if (result.deliveries.some((d) => d.deliveryId)) mailed += 1;
    }
    // G11-2: the run remembers it was mailed — to how many, and when.
    if (mailed > 0) run = await repository.recordMailed(run.id, { to: mailed, at: now });
  }

  await repository.updateSchedule(schedule.id, { lastRunAt: now, nextRunAt: nextRunAtFor(schedule.cadence, now) });
  await logActivity(owner, 'REPORT_SCHEDULE_RUN', {
    module: MODULE,
    targetType: 'ReportSchedule',
    targetId: schedule.id,
    metadata: { by: 'reportScheduleJob', runId: run.id, status: run.status, rowCount: run.rowCount, window: window.label, mailed },
  });
  return { scheduleId: schedule.id, runId: run.id, status: run.status, recipients: mailed };
}
