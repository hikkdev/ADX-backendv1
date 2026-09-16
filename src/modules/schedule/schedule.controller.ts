import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { createEntrySchema, patchEntrySchema, scheduleLogQuerySchema, scheduleQuerySchema } from './schedule.schema';
import { createEntry, deleteEntry, patchEntry, readSchedule, readScheduleLog } from './schedule.service';

const parse = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

/** What a diff on an entry reports — the notes are left to the row. */
const ENTRY_FIELDS = ['date', 'startTime', 'endTime', 'title', 'assigneeUserId', 'department', 'status'] as const;
const entryId = (req: Request) => req.params['entryId'] as string;

export async function readScheduleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await readSchedule(parse(scheduleQuerySchema, req.query)) });
}

export async function createEntryHandler(req: Request, res: Response): Promise<void> {
  const entry = await createEntry(parse(createEntrySchema, req.body), req.user!.sub);
  await logActivity(req.user!.sub, 'SCHEDULE_ENTRY_CREATED', {
    req,
    module: 'schedule',
    targetType: 'ScheduleEntry',
    targetId: entry.id,
    metadata: { date: entry.date, title: entry.title, assigneeUserId: entry.assigneeUserId },
  });
  res.status(201).json({ success: true, data: entry });
}

export async function patchEntryHandler(req: Request, res: Response): Promise<void> {
  const patch = parse(patchEntrySchema, req.body);
  const { before, after } = await patchEntry(entryId(req), patch);
  await logActivity(req.user!.sub, 'SCHEDULE_ENTRY_UPDATED', {
    req,
    module: 'schedule',
    targetType: 'ScheduleEntry',
    targetId: after.id,
    diff: auditDiff(before, after, ENTRY_FIELDS),
    metadata: { date: after.date, title: after.title, assigneeUserId: after.assigneeUserId, fields: Object.keys(patch) },
  });
  res.json({ success: true, data: after });
}

export async function deleteEntryHandler(req: Request, res: Response): Promise<void> {
  const entry = await deleteEntry(entryId(req));
  await logActivity(req.user!.sub, 'SCHEDULE_ENTRY_DELETED', {
    req,
    module: 'schedule',
    targetType: 'ScheduleEntry',
    targetId: entry.id,
    metadata: { date: entry.date, title: entry.title, assigneeUserId: entry.assigneeUserId },
  });
  res.json({ success: true, data: { message: 'Schedule entry deleted' } });
}

export async function readScheduleLogHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await readScheduleLog(parse(scheduleLogQuerySchema, req.query)) });
}
