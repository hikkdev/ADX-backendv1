import { ApiError } from '../../shared/errors';
import { findActivity, type ActivityRow } from '../../shared/audit';
import { dayWindowISTFor } from '../../shared/time';
import type { ScheduleEntry } from '../../shared/database';
import { findPerson, holidaysInRange, type HolidayView } from '../hr';
import { findUserLabels, type UserLabel } from '../users';
import { agentWorkInWindow, type OverlayEntry } from '../visits';
import { prismaScheduleRepository as repository } from './prisma-schedule.repository';
import type { EntryPatch } from './schedule.repository';
import type { CreateEntryInput, PatchEntryInput, ScheduleLogQuery, ScheduleQuery } from './schedule.schema';

/**
 * The staff diary — Lot E (Q72/Q99).
 *
 * ADX owns the entries: a meeting, a call, a day at the printer, put against
 * a person the registry knows — staff or agent, both assignable. Field work
 * is never copied in. When the selected person is also an agent and the
 * caller asks for it, their visits, site visits and jobs in the window are
 * overlaid from their own tables as read-only rows, through `visits`' fold,
 * each with a link to where the console opens it.
 */
export type EntryView = {
  id: string;
  date: string;
  startTime: string;
  endTime: string | null;
  title: string;
  notes: string | null;
  assigneeUserId: string;
  department: string | null;
  status: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** E10-1: an entry as the window read answers it — the assignee named beside the id, active or not. */
export type EntryWithAssignee = EntryView & { assignee: UserLabel };

export type ScheduleWindow = {
  from: string;
  to: string;
  entries: EntryWithAssignee[];
  /** The holidays in the window, so the grid can shade them. */
  holidays: HolidayView[];
  /** Read-only rows from the field, only for a selected person who is an agent. */
  overlay: OverlayEntry[];
};

/** A `@db.Date` column is written as the UTC midnight of the day it names. */
const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
const isoDateOf = (value: Date): string => value.toISOString().slice(0, 10);

export const toEntryView = (row: ScheduleEntry): EntryView => ({
  id: row.id,
  date: isoDateOf(row.date),
  startTime: row.startTime,
  endTime: row.endTime,
  title: row.title,
  notes: row.notes,
  assigneeUserId: row.assigneeUserId,
  department: row.department,
  status: row.status,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The Indian days `from`..`to` name, as one `[start, end)` window of instants. */
const instantWindow = (from: string, to: string) => ({ start: dayWindowISTFor(from).start, end: dayWindowISTFor(to).end });

export async function readSchedule(query: ScheduleQuery, now = new Date()): Promise<ScheduleWindow> {
  const { from, to, assigneeUserId, include } = query;
  const wantsOverlay = include.visits || include.milestones || include.jobs;

  const [entries, holidays, overlay] = await Promise.all([
    repository.findInRange(dateColumn(from), dateColumn(to), assigneeUserId),
    holidaysInRange(from, to),
    wantsOverlay && assigneeUserId ? overlayFor(assigneeUserId, from, to, include, now) : Promise.resolve([]),
  ]);
  // E10-1: every assignee by name, one lookup for the window — through
  // `users`, not the registry, because an entry against someone who has
  // since left still has to say who.
  const labels = await labelsFor(entries.map((row) => row.assigneeUserId));

  return { from, to, entries: entries.map((row) => ({ ...toEntryView(row), assignee: labelOf(labels, row.assigneeUserId) })), holidays, overlay };
}

async function labelsFor(ids: readonly string[]): Promise<Map<string, UserLabel>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  return unique.length === 0 ? new Map() : findUserLabels(unique);
}

const labelOf = (labels: Map<string, UserLabel>, id: string): UserLabel => labels.get(id) ?? { id, name: null };

/**
 * The overlay is shown only for the selected person (Q99), and only when
 * that person has an agent profile: a staffer with no field work has
 * nothing to overlay, and the answer is an empty list, not an error.
 */
async function overlayFor(
  assigneeUserId: string,
  from: string,
  to: string,
  include: ScheduleQuery['include'],
  now: Date,
): Promise<OverlayEntry[]> {
  const person = await findPerson(assigneeUserId);
  if (!person?.agentProfileId) return [];
  return agentWorkInWindow(person.agentProfileId, instantWindow(from, to), include, now);
}

/** An assignee must be somebody the registry knows — active staff or an ACTIVE agent. */
async function requirePerson(userId: string): Promise<void> {
  if (!(await findPerson(userId))) {
    throw new ApiError(404, 'NOT_FOUND', 'That person is not in the people registry');
  }
}

export async function createEntry(input: CreateEntryInput, createdByUserId: string): Promise<EntryView> {
  await requirePerson(input.assigneeUserId);
  const row = await repository.create({
    date: dateColumn(input.date),
    startTime: input.startTime,
    endTime: input.endTime ?? null,
    title: input.title,
    notes: input.notes ?? null,
    assigneeUserId: input.assigneeUserId,
    department: input.department ?? null,
    createdByUserId,
  });
  return toEntryView(row);
}

export async function patchEntry(id: string, patch: PatchEntryInput): Promise<{ before: EntryView; after: EntryView }> {
  const existing = await requireEntry(id);
  if (patch.assigneeUserId !== undefined && patch.assigneeUserId !== existing.assigneeUserId) {
    await requirePerson(patch.assigneeUserId);
  }
  // The half the patch leaves out is checked against the stored one.
  const startTime = patch.startTime ?? existing.startTime;
  const endTime = patch.endTime !== undefined ? patch.endTime : existing.endTime;
  if (endTime !== null && endTime <= startTime) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The end is not after the start');
  }

  const update: EntryPatch = {
    ...(patch.date !== undefined ? { date: dateColumn(patch.date) } : {}),
    ...(patch.startTime !== undefined ? { startTime: patch.startTime } : {}),
    ...(patch.endTime !== undefined ? { endTime: patch.endTime } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.assigneeUserId !== undefined ? { assigneeUserId: patch.assigneeUserId } : {}),
    ...(patch.department !== undefined ? { department: patch.department } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  const after = await repository.update(id, update);
  return { before: toEntryView(existing), after: toEntryView(after) };
}

export async function deleteEntry(id: string): Promise<EntryView> {
  await requireEntry(id);
  return toEntryView(await repository.remove(id));
}

async function requireEntry(id: string): Promise<ScheduleEntry> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Schedule entry not found');
  return row;
}

/* ── the log ─────────────────────────────────────────────────────────── */

export const SCHEDULE_ACTIONS = ['SCHEDULE_ENTRY_CREATED', 'SCHEDULE_ENTRY_UPDATED', 'SCHEDULE_ENTRY_DELETED'] as const;

export type ScheduleLogRow = {
  id: string;
  action: string;
  targetId: string | null;
  at: string;
  actor: { id: string; name: string | null };
  /** E10-1: the person the row was written against (`metadata.assigneeUserId`), named; null when the row names nobody. */
  assignee: UserLabel | null;
  diff: unknown;
  metadata: unknown;
};

/**
 * GET /schedule/log — the trail read back by this module's actions, over the
 * window's Indian days. Read through `shared/audit`; there is no delete, here
 * or anywhere: the trail is the record of the diary, not part of it.
 */
export async function readScheduleLog(query: ScheduleLogQuery): Promise<{ items: ScheduleLogRow[]; total: number; page: number; pageSize: number }> {
  const window = instantWindow(query.from, query.to);
  const page = await findActivity({ module: 'schedule', from: window.start, to: window.end }, { page: query.page, pageSize: query.pageSize, sort: 'newest' });
  const actions = new Set<string>(SCHEDULE_ACTIONS);
  const rows = page.items.filter((row) => actions.has(row.action));
  const labels = await labelsFor(rows.map(assigneeOf).filter((id): id is string => id !== null));
  const items = rows.map((row) => toLogRow(row, labels));
  return { items, total: page.total, page: page.page, pageSize: page.pageSize };
}

/** The assignee a schedule audit row names in its metadata, if any. */
const assigneeOf = (row: ActivityRow): string | null => {
  const meta = row.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const id = (meta as Record<string, unknown>)['assigneeUserId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const toLogRow = (row: ActivityRow, labels: Map<string, UserLabel>): ScheduleLogRow => {
  const assigneeUserId = assigneeOf(row);
  return {
    id: row.id,
    action: row.action,
    targetId: row.targetId,
    at: row.createdAt.toISOString(),
    actor: { id: row.user.id, name: row.user.name },
    assignee: assigneeUserId ? labelOf(labels, assigneeUserId) : null,
    diff: row.diff,
    metadata: row.metadata,
  };
};
