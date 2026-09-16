import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { dayWindowISTFor } from '../../shared/time';

/**
 * Work — Lot AA (Q70, and the owner's "there was a Tasks section in DR 10").
 *
 * The vocabulary of the DR 10 screens, essentials only: a project (a
 * department's or a city's), a task with sub-tasks, people, reviewers,
 * prerequisites, comments, hours and issues. No baseline, buffer, slack or
 * overtime engine, no Gantt, no payroll — those are the PMO tool's, not
 * ADX's (Q70).
 */

export const PROJECT_KINDS = ['DEPARTMENT', 'REGION'] as const;
export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const TASK_STATUSES = ['DRAFT', 'TODO', 'IN_PROGRESS', 'PENDING_REVIEW', 'VERIFIED', 'BLOCKED', 'ARCHIVED'] as const;
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const ISSUE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX'] as const;
export const ISSUE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const PEOPLE_KINDS = ['EMPLOYEE', 'AGENT'] as const;
/** What a task can be about, when it is about a record. */
export const LINKED_KINDS = ['ORDER', 'LISTING', 'LEAD', 'VISIT', 'CITY', 'PUBLISHER', 'ADVERTISER', 'PRINT_PARTNER', 'CAMPAIGN'] as const;
export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export const TASK_SORTS = ['DEADLINE', 'PRIORITY', 'UPDATED', 'CREATED'] as const;
/** The statuses the board draws — every one but ARCHIVED. */
export const BOARD_STATUSES = TASK_STATUSES.filter((s) => s !== 'ARCHIVED');
/** A task still on somebody's plate: not done, not archived, not a draft. */
export const OPEN_STATUSES = ['TODO', 'IN_PROGRESS', 'PENDING_REVIEW', 'BLOCKED'] as const;
/** A prerequisite is finished at VERIFIED or ARCHIVED. */
export const FINISHED_STATUSES = ['VERIFIED', 'ARCHIVED'] as const;
export const OPEN_ISSUE_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export type PersonKind = (typeof PEOPLE_KINDS)[number];
export type LinkedKind = (typeof LINKED_KINDS)[number];
export type TaskSort = (typeof TASK_SORTS)[number];

/* ── the primitives ───────────────────────────────────────────────────── */

/** `YYYY-MM-DD`, and a real day. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a calendar day');

const isoDateTime = z.string().datetime({ offset: true });

/**
 * A start is an instant or a day: a day means the Indian midnight that
 * opens it. A deadline given as a day means the last instant of that
 * Indian day, so "due on the 16th" is not overdue until the 17th begins.
 */
export const startInputSchema = z.union([isoDateTime, isoDateSchema]).transform((value) => (value.length === 10 ? dayWindowISTFor(value).start : new Date(value)));
export const deadlineInputSchema = z
  .union([isoDateTime, isoDateSchema])
  .transform((value) => (value.length === 10 ? new Date(dayWindowISTFor(value).end.getTime() - 1) : new Date(value)));

/** A `@db.Date`-style column is written as the UTC midnight of the day it names. */
export const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
export const isoDateOf = (value: Date): string => value.toISOString().slice(0, 10);

const userId = z.string().trim().min(1).max(64);
const id = z.string().trim().min(1).max(64);
const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(5000);
const tags = z.array(z.string().trim().min(1).max(40)).max(20);
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).min(1).optional());
const bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const recurrenceSchema = z.object({
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  /** A weekday name, a day of the month — kept as the screen typed it. */
  occursOn: z.string().trim().max(40).optional(),
  endDate: isoDateSchema.optional(),
  totalOccurrences: z.number().int().min(1).max(1000).optional(),
});
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;

/* ── people ───────────────────────────────────────────────────────────── */

export const peopleQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(PEOPLE_KINDS).optional(),
});
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;

/* ── projects ─────────────────────────────────────────────────────────── */

export const projectsQuerySchema = listQuerySchema(PROJECT_STATUSES, ['newest', 'name'] as const).extend({
  kind: z.enum(PROJECT_KINDS).optional(),
  cityId: id.optional(),
  departmentId: id.optional(),
});
export type ProjectsQuery = z.infer<typeof projectsQuerySchema>;

export const createProjectSchema = z
  .object({
    name: title,
    description: description.optional(),
    kind: z.enum(PROJECT_KINDS),
    departmentId: id.optional(),
    cityId: id.optional(),
    ownerUserId: userId,
    startsAt: startInputSchema.optional(),
    endsAt: deadlineInputSchema.optional(),
  })
  .refine((body) => body.kind !== 'DEPARTMENT' || body.departmentId, { message: 'A DEPARTMENT project names its department', path: ['departmentId'] })
  .refine((body) => body.kind !== 'REGION' || body.cityId, { message: 'A REGION project names its city', path: ['cityId'] });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const patchProjectSchema = z
  .object({
    name: title.optional(),
    description: description.nullable().optional(),
    ownerUserId: userId.optional(),
    departmentId: id.optional(),
    cityId: id.optional(),
    startsAt: startInputSchema.nullable().optional(),
    endsAt: deadlineInputSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchProjectInput = z.infer<typeof patchProjectSchema>;

/* ── tasks ────────────────────────────────────────────────────────────── */

export const tasksQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: csv(TASK_STATUSES),
  priority: z.enum(PRIORITIES).optional(),
  projectId: id.optional(),
  assigneeUserId: userId.optional(),
  reviewerUserId: userId.optional(),
  dueFrom: startInputSchema.optional(),
  dueTo: deadlineInputSchema.optional(),
  overdue: bool,
  linkedKind: z.enum(LINKED_KINDS).optional(),
  linkedId: id.optional(),
  parentTaskId: id.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  sort: z.enum(TASK_SORTS).default('DEADLINE'),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type TasksQuery = z.infer<typeof tasksQuerySchema>;

const reviewerInput = z.object({ userId, approver: z.boolean().default(false) });

const linkedPair = (body: { linkedKind?: string | null | undefined; linkedId?: string | null | undefined }) =>
  (body.linkedKind == null) === (body.linkedId == null);

export const createTaskSchema = z
  .object({
    title,
    description: description.optional(),
    projectId: id.optional(),
    parentTaskId: id.optional(),
    priority: z.enum(PRIORITIES).default('MEDIUM'),
    status: z.enum(['DRAFT', 'TODO']).default('TODO'),
    startDate: startInputSchema.optional(),
    deadline: deadlineInputSchema.optional(),
    effortEstimateH: z.number().min(0).max(10_000).optional(),
    linkedKind: z.enum(LINKED_KINDS).optional(),
    linkedId: id.optional(),
    recurrence: recurrenceSchema.optional(),
    tags: tags.default([]),
    assigneeUserIds: z.array(userId).max(20).default([]),
    reviewers: z.array(reviewerInput).max(20).default([]),
    prerequisiteIds: z.array(id).max(50).default([]),
  })
  .refine(linkedPair, { message: 'linkedKind and linkedId go together', path: ['linkedId'] });
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const patchTaskSchema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    startDate: startInputSchema.nullable().optional(),
    deadline: deadlineInputSchema.nullable().optional(),
    revisedEndDate: deadlineInputSchema.nullable().optional(),
    effortEstimateH: z.number().min(0).max(10_000).nullable().optional(),
    progress: z.number().int().min(0).max(100).optional(),
    linkedKind: z.enum(LINKED_KINDS).nullable().optional(),
    linkedId: id.nullable().optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    tags: tags.optional(),
    projectId: id.nullable().optional(),
    blockedReason: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine((body) => body.linkedKind === undefined && body.linkedId === undefined ? true : linkedPair(body), {
    message: 'linkedKind and linkedId go together',
    path: ['linkedId'],
  });
export type PatchTaskInput = z.infer<typeof patchTaskSchema>;

export const statusChangeSchema = z.object({
  status: z.enum(TASK_STATUSES.filter((s) => s !== 'DRAFT') as unknown as [TaskStatus, ...TaskStatus[]]),
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

/** The assignee's own moves — Q70: the desk decides the rest. */
export const myStatusChangeSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'PENDING_REVIEW', 'BLOCKED']),
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type MyStatusChangeInput = z.infer<typeof myStatusChangeSchema>;

export const reviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().min(1).max(2000).optional(),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

export const assigneesSchema = z.object({ userIds: z.array(userId).max(20) });
export const reviewersSchema = z.object({ reviewers: z.array(reviewerInput).max(20) });
export const prerequisitesSchema = z.object({ ids: z.array(id).max(50) });

export const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export type CommentInput = z.infer<typeof commentSchema>;

export const timeLogSchema = z.object({
  forDate: isoDateSchema,
  hours: z.number().min(0.25).max(24),
  billable: z.boolean().default(false),
  note: z.string().trim().max(1000).optional(),
});
export type TimeLogInput = z.infer<typeof timeLogSchema>;

export const timeLogsQuerySchema = z
  .object({
    userId: userId.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    projectId: id.optional(),
  })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { message: '`to` is before `from`', path: ['to'] });
export type TimeLogsQuery = z.infer<typeof timeLogsQuerySchema>;

/* ── issues ───────────────────────────────────────────────────────────── */

export const issuesQuerySchema = listQuerySchema(ISSUE_STATUSES, ['newest', 'severity'] as const).extend({
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  projectId: id.optional(),
  taskId: id.optional(),
  assigneeId: userId.optional(),
});
export type IssuesQuery = z.infer<typeof issuesQuerySchema>;

export const createIssueSchema = z.object({
  title,
  description: description.optional(),
  severity: z.enum(ISSUE_SEVERITIES).default('MEDIUM'),
  projectId: id.optional(),
  taskId: id.optional(),
  assigneeId: userId.optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const patchIssueSchema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    assigneeId: userId.nullable().optional(),
    status: z.enum(['OPEN', 'IN_PROGRESS']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchIssueInput = z.infer<typeof patchIssueSchema>;

export const resolveIssueSchema = z.object({
  status: z.enum(['RESOLVED', 'WONT_FIX']),
  resolution: z.string().trim().min(1).max(2000),
});
export type ResolveIssueInput = z.infer<typeof resolveIssueSchema>;

/* ── overview, board, me ──────────────────────────────────────────────── */

export const overviewQuerySchema = z
  .object({
    projectId: id.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { message: '`to` is before `from`', path: ['to'] });
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export const boardQuerySchema = z.object({
  projectId: id.optional(),
  assigneeUserId: userId.optional(),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/** `reviewing=true` (AB-B) swaps the assigned list for the tasks awaiting the caller's review mark; `status` applies to the assigned list only. */
export const myTasksQuerySchema = z.object({ status: csv(TASK_STATUSES), reviewing: bool });
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;
