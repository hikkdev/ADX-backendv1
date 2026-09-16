import type { Request } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { toListPage, type ListPage } from '../../shared/pagination';
import { dayWindowIST, dayWindowISTFor, monthWindowIST } from '../../shared/time';
import { allocateIdentifier } from '../identifiers';
import { prismaWorkRepository } from './prisma-work.repository';
import type {
  CommentRow,
  IssueRow,
  PersonRow,
  ProjectLite,
  ProjectRow,
  Recurrence,
  ReviewerRow,
  TaskFilter,
  TaskListRow,
  TaskPatch,
  TaskRow,
  TimeLogRow,
  WorkRepository,
} from './work.repository';
import { notifyAssigned, notifyComment, notifyDueTomorrow, notifyOverdue, notifyRejected, notifyReviewRequested } from './work.notify';
import {
  BOARD_STATUSES,
  FINISHED_STATUSES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  OPEN_ISSUE_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  dateColumn,
  isoDateOf,
  type BoardQuery,
  type CommentInput,
  type CreateIssueInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type IssuesQuery,
  type MyStatusChangeInput,
  type MyTasksQuery,
  type OverviewQuery,
  type PatchIssueInput,
  type PatchProjectInput,
  type PatchTaskInput,
  type PeopleQuery,
  type PersonKind,
  type ProjectsQuery,
  type ResolveIssueInput,
  type ReviewInput,
  type StatusChangeInput,
  type TaskStatus,
  type TasksQuery,
  type TimeLogInput,
  type TimeLogsQuery,
} from './work.schema';

/**
 * Work — Lot AA: the DR 10 Tasks section on real tables, essentials only
 * (Q70). Projects, tasks with sub-tasks, people, reviewers, prerequisites,
 * comments, hours and issues; the overview, the board and a person's own
 * list. Coordination only: a task assigned to an agent never pays — paid
 * field work stays in orders, milestones and visits.
 */

let repository: WorkRepository = prismaWorkRepository;

/** Tests only: swap the repository. */
export function setWorkRepository(next: WorkRepository | null): void {
  repository = next ?? prismaWorkRepository;
}

/** Who is acting, what they may do, and the request their audit rows hang off. */
export type Actor = {
  userId: string;
  req?: Request | undefined;
  can: (permission: string) => boolean;
};

const MODULE = 'work';
const DAY_MS = 24 * 60 * 60 * 1000;
const BOARD_CAP = 100;

async function audit(actor: Actor, action: string, targetType: string, targetId: string, extra: { diff?: ReturnType<typeof auditDiff>; metadata?: Record<string, unknown> } = {}): Promise<void> {
  await logActivity(actor.userId, action, { req: actor.req, module: MODULE, targetType, targetId, diff: extra.diff, metadata: extra.metadata });
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const isFinished = (status: TaskStatus): boolean => (FINISHED_STATUSES as readonly string[]).includes(status);
const isOverdue = (task: Pick<TaskRow, 'deadline' | 'status'>, now: Date): boolean => task.deadline !== null && task.deadline.getTime() < now.getTime() && !isFinished(task.status);

/* ── people ─────────────────────────────────────────────────────────── */

export type PersonView = {
  userId: string;
  name: string | null;
  /** null when the person has left both registries — a name is still owed to the row. */
  kind: PersonKind | null;
  role: string | null;
  departmentName: string | null;
};

const toPersonView = (row: PersonRow): PersonView => ({ userId: row.userId, name: row.name, kind: row.kind, role: row.role, departmentName: row.departmentName });
const unknownPerson = (userId: string): PersonView => ({ userId, name: null, kind: null, role: null, departmentName: null });

/** Every id named, resolved — active or not, so a task against someone who has left still says who. */
async function peopleMap(ids: readonly string[]): Promise<Map<string, PersonView>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const rows = unique.length === 0 ? [] : await repository.findPeople(unique);
  return new Map(rows.map((row) => [row.userId, toPersonView(row)]));
}
const personOf = (people: Map<string, PersonView>, id: string): PersonView => people.get(id) ?? unknownPerson(id);

/**
 * The people rule: a task's people are employees and agents. Assigning
 * anyone else — or someone no longer active — is 422, naming the ids.
 */
export async function resolvePeople(userIds: readonly string[]): Promise<PersonView[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const rows = await repository.findPeople(unique);
  const active = new Map(rows.filter((row) => row.active).map((row) => [row.userId, row]));
  const rejected = unique.filter((id) => !active.has(id));
  if (rejected.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only an active employee or agent can be put on a task', { userIds: rejected });
  }
  return unique.map((id) => toPersonView(active.get(id)!));
}

export async function searchPeople(query: PeopleQuery): Promise<PersonView[]> {
  return (await repository.searchPeople(query.q, query.kind, 50)).map(toPersonView);
}

/* ── projects ───────────────────────────────────────────────────────── */

export type ProjectView = {
  id: string;
  displayId: string | null;
  name: string;
  description: string | null;
  kind: ProjectRow['kind'];
  departmentId: string | null;
  cityId: string | null;
  ownerUserId: string;
  owner: PersonView;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDetail = ProjectView & {
  counts: { tasks: Record<string, number>; openIssues: number; hoursLogged: number };
};

const toProjectView = (row: ProjectRow, people: Map<string, PersonView>): ProjectView => ({
  id: row.id,
  displayId: row.displayId,
  name: row.name,
  description: row.description,
  kind: row.kind,
  departmentId: row.departmentId,
  cityId: row.cityId,
  ownerUserId: row.ownerUserId,
  owner: personOf(people, row.ownerUserId),
  status: row.status,
  startsAt: iso(row.startsAt),
  endsAt: iso(row.endsAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const PROJECT_AUDIT_FIELDS = ['name', 'description', 'ownerUserId', 'departmentId', 'cityId', 'startsAt', 'endsAt', 'status'] as const;

export async function listProjects(query: ProjectsQuery): Promise<ListPage<ProjectView>> {
  const filter = { q: query.q, statuses: query.status, kind: query.kind, cityId: query.cityId, departmentId: query.departmentId };
  const [{ rows, total }, counts] = await Promise.all([
    repository.findProjects(filter, { skip: (query.page - 1) * query.pageSize, take: query.pageSize }, query.sort),
    repository.countProjectsByStatus({ ...filter, statuses: undefined }),
  ]);
  const people = await peopleMap(rows.map((row) => row.ownerUserId));
  return toListPage(rows.map((row) => toProjectView(row, people)), total, fill(counts, PROJECT_STATUSES), query);
}

async function requireDepartment(id: string): Promise<void> {
  if (!(await repository.findDepartment(id))) throw new ApiError(404, 'NOT_FOUND', 'Department not found', { departmentId: id });
}
async function requireCity(id: string): Promise<void> {
  if (!(await repository.findCity(id))) throw new ApiError(404, 'NOT_FOUND', 'City not found', { cityId: id });
}

export async function createProject(input: CreateProjectInput, actor: Actor): Promise<ProjectView> {
  if (input.kind === 'DEPARTMENT') await requireDepartment(input.departmentId!);
  if (input.kind === 'REGION') await requireCity(input.cityId!);
  const [owner] = await resolvePeople([input.ownerUserId]);
  const displayId = await allocateIdentifier('PROJECT');
  const row = await repository.createProject({
    displayId,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    departmentId: input.kind === 'DEPARTMENT' ? input.departmentId! : null,
    cityId: input.kind === 'REGION' ? input.cityId! : null,
    ownerUserId: input.ownerUserId,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  });
  await audit(actor, 'WORK_PROJECT_CREATED', 'WorkProject', row.id, { metadata: { displayId, name: row.name, kind: row.kind } });
  return toProjectView(row, new Map([[owner!.userId, owner!]]));
}

async function requireProject(id: string): Promise<ProjectRow> {
  const row = await repository.findProject(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Project not found');
  return row;
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const row = await requireProject(id);
  const [people, tasks, issues, logs] = await Promise.all([
    peopleMap([row.ownerUserId]),
    repository.countTasksByStatus({ projectId: id }),
    repository.countIssuesByStatus({ projectId: id }),
    repository.findTimeLogs({ projectId: id }),
  ]);
  const openIssues = OPEN_ISSUE_STATUSES.reduce((n, status) => n + (issues[status] ?? 0), 0);
  const hoursLogged = round2(logs.reduce((n, log) => n + log.hours, 0));
  return { ...toProjectView(row, people), counts: { tasks: fill(tasks, TASK_STATUSES), openIssues, hoursLogged } };
}

export async function patchProject(id: string, patch: PatchProjectInput, actor: Actor): Promise<ProjectView> {
  const before = await requireProject(id);
  if (patch.departmentId !== undefined) {
    if (before.kind !== 'DEPARTMENT') throw new ApiError(409, 'CONFLICT', 'Only a DEPARTMENT project has a department');
    await requireDepartment(patch.departmentId);
  }
  if (patch.cityId !== undefined) {
    if (before.kind !== 'REGION') throw new ApiError(409, 'CONFLICT', 'Only a REGION project has a city');
    await requireCity(patch.cityId);
  }
  if (patch.ownerUserId !== undefined) await resolvePeople([patch.ownerUserId]);
  const after = await repository.updateProject(id, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
    ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
    ...(patch.cityId !== undefined ? { cityId: patch.cityId } : {}),
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
  });
  await audit(actor, 'WORK_PROJECT_UPDATED', 'WorkProject', id, { diff: auditDiff(before, after, PROJECT_AUDIT_FIELDS), metadata: { fields: Object.keys(patch) } });
  return toProjectView(after, await peopleMap([after.ownerUserId]));
}

export async function archiveProject(id: string, actor: Actor): Promise<ProjectView> {
  const before = await requireProject(id);
  if (before.status === 'ARCHIVED') throw new ApiError(409, 'CONFLICT', 'The project is already archived');
  const after = await repository.updateProject(id, { status: 'ARCHIVED' });
  await audit(actor, 'WORK_PROJECT_ARCHIVED', 'WorkProject', id, { diff: auditDiff(before, after, ['status']) });
  return toProjectView(after, await peopleMap([after.ownerUserId]));
}

/* ── tasks: the views ───────────────────────────────────────────────── */

/** The card: what a list row, a board card and a `/me` row carry. */
export type TaskCard = {
  id: string;
  displayId: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskRow['priority'];
  progress: number;
  deadline: string | null;
  startDate: string | null;
  project: ProjectLite | null;
  assignees: PersonView[];
  openIssues: number;
  childCount: number;
  overdue: boolean;
  tags: string[];
  parentTaskId: string | null;
  updatedAt: string;
};

export type ReviewerView = PersonView & { approver: boolean; approvedAt: string | null; rejectedAt: string | null; note: string | null };

export type TaskDetail = {
  id: string;
  displayId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskRow['priority'];
  progress: number;
  startDate: string | null;
  deadline: string | null;
  actualStartDate: string | null;
  revisedEndDate: string | null;
  completedAt: string | null;
  effortEstimateH: number | null;
  recurrence: Recurrence | null;
  tags: string[];
  blockedReason: string | null;
  overdue: boolean;
  /** An OPEN CRITICAL issue sits on the task — a read-time flag, never a status. */
  blockedByIssue: boolean;
  /** Every child is VERIFIED: the parent is offered VERIFIED, never moved there. */
  childrenAllVerified: boolean;
  createdBy: PersonView;
  assignedBy: PersonView | null;
  project: ProjectLite | null;
  parent: { id: string; displayId: string | null; title: string } | null;
  children: { id: string; displayId: string | null; title: string; status: TaskStatus; progress: number; deadline: string | null }[];
  assignees: PersonView[];
  reviewers: ReviewerView[];
  prerequisites: { id: string; displayId: string | null; title: string; status: TaskStatus }[];
  dependents: { id: string; displayId: string | null; title: string; status: TaskStatus }[];
  comments: { id: string; author: PersonView; body: string; createdAt: string }[];
  timeLogs: { rows: TimeLogView[]; totals: { hours: number; billableHours: number } };
  issues: IssueView[];
  linked: { kind: TaskRow['linkedKind']; id: string; label: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

export type TimeLogView = {
  id: string;
  taskId: string;
  task?: { id: string; displayId: string | null; title: string } | undefined;
  person: PersonView;
  forDate: string;
  hours: number;
  billable: boolean;
  note: string | null;
  loggedAt: string;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function toCard(row: TaskListRow, people: Map<string, PersonView>, now: Date): TaskCard {
  return {
    id: row.id,
    displayId: row.displayId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    deadline: iso(row.deadline),
    startDate: iso(row.startDate),
    project: row.project,
    assignees: row.assignees.map((a) => personOf(people, a.userId)),
    openIssues: row.openIssues,
    childCount: row.childCount,
    overdue: isOverdue(row, now),
    tags: row.tags,
    parentTaskId: row.parentTaskId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toTimeLogView = (row: TimeLogRow, people: Map<string, PersonView>, task?: { id: string; displayId: string | null; title: string }): TimeLogView => ({
  id: row.id,
  taskId: row.taskId,
  task,
  person: personOf(people, row.userId),
  forDate: isoDateOf(row.forDate),
  hours: row.hours,
  billable: row.billable,
  note: row.note,
  loggedAt: row.loggedAt.toISOString(),
});

const totalsOf = (rows: readonly { hours: number; billable: boolean }[]) => ({
  hours: round2(rows.reduce((n, r) => n + r.hours, 0)),
  billableHours: round2(rows.filter((r) => r.billable).reduce((n, r) => n + r.hours, 0)),
});

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const isOpenIssue = (issue: IssueRow): boolean => (OPEN_ISSUE_STATUSES as readonly string[]).includes(issue.status);

function fill(counts: Record<string, number>, keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = counts[key] ?? 0;
  return out;
}

export async function listTasks(query: TasksQuery, now = new Date()): Promise<ListPage<TaskCard>> {
  const filter: TaskFilter = {
    q: query.q,
    statuses: query.status,
    priority: query.priority,
    projectId: query.projectId,
    assigneeUserId: query.assigneeUserId,
    reviewerUserId: query.reviewerUserId,
    dueFrom: query.dueFrom,
    dueTo: query.dueTo,
    overdueAt: query.overdue ? now : undefined,
    linkedKind: query.linkedKind,
    linkedId: query.linkedId,
    parentTaskId: query.parentTaskId,
    tag: query.tag,
    excludeArchived: !query.status,
  };
  const dir = query.dir ?? (query.sort === 'UPDATED' || query.sort === 'CREATED' ? 'desc' : 'asc');
  const [{ rows, total }, counts] = await Promise.all([
    repository.findTasks(filter, { skip: (query.page - 1) * query.pageSize, take: query.pageSize }, { sort: query.sort, dir }),
    repository.countTasksByStatus({ ...filter, statuses: undefined, excludeArchived: false }),
  ]);
  const people = await peopleMap(rows.flatMap((row) => row.assignees.map((a) => a.userId)));
  return toListPage(rows.map((row) => toCard(row, people, now)), total, fill(counts, TASK_STATUSES), query);
}

async function requireTask(id: string): Promise<TaskRow> {
  const row = await repository.findTask(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
  return row;
}

async function requireLinked(kind: TaskRow['linkedKind'], id: string | null): Promise<void> {
  if (!kind || !id) return;
  if ((await repository.linkedLabel(kind, id)) === null) throw new ApiError(404, 'NOT_FOUND', `${kind} ${id} not found`, { linkedKind: kind, linkedId: id });
}

/** The desk's name for the notices; null when the actor is nobody the registry knows. */
async function actorName(actor: Actor): Promise<string | null> {
  const rows = await repository.findPeople([actor.userId]);
  return rows[0]?.name ?? null;
}

export async function createTask(input: CreateTaskInput, actor: Actor, now = new Date()): Promise<TaskDetail> {
  let projectId = input.projectId ?? null;
  if (input.parentTaskId) {
    const parent = await requireTask(input.parentTaskId);
    // A sub-task inherits the parent's project; a different one is a mistake.
    if (projectId && parent.projectId && projectId !== parent.projectId) {
      throw new ApiError(409, 'CONFLICT', "A sub-task belongs to its parent's project", { parentProjectId: parent.projectId });
    }
    projectId = parent.projectId;
  } else if (projectId) {
    await requireProject(projectId);
  }
  await requireLinked(input.linkedKind ?? null, input.linkedId ?? null);
  const reviewerIds = input.reviewers.map((r) => r.userId);
  await resolvePeople([...input.assigneeUserIds, ...reviewerIds]);
  for (const id of input.prerequisiteIds) await requireTask(id);

  const displayId = await allocateIdentifier('TASK');
  const row = await repository.createTask({
    displayId,
    projectId,
    parentTaskId: input.parentTaskId ?? null,
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    startDate: input.startDate ?? null,
    deadline: input.deadline ?? null,
    effortEstimateH: input.effortEstimateH ?? null,
    linkedKind: input.linkedKind ?? null,
    linkedId: input.linkedId ?? null,
    recurrence: input.recurrence ? { ...input.recurrence, occurrence: 1 } : null,
    tags: input.tags,
    createdById: actor.userId,
    assignedById: input.assigneeUserIds.length > 0 ? actor.userId : null,
  });
  if (input.assigneeUserIds.length > 0) await repository.setAssignees(row.id, [...new Set(input.assigneeUserIds)], now);
  if (input.reviewers.length > 0) await repository.setReviewers(row.id, dedupeReviewers(input.reviewers));
  if (input.prerequisiteIds.length > 0) await repository.setPrerequisites(row.id, [...new Set(input.prerequisiteIds)].filter((id) => id !== row.id));
  if (row.parentTaskId) await rollUp(row.parentTaskId);

  await audit(actor, 'WORK_TASK_CREATED', 'WorkTask', row.id, { metadata: { displayId, title: row.title, projectId, parentTaskId: row.parentTaskId, assigneeUserIds: input.assigneeUserIds } });
  const by = input.assigneeUserIds.length > 0 ? await actorName(actor) : null;
  for (const userId of new Set(input.assigneeUserIds)) await notifyAssigned(row, userId, by);
  return getTask(row.id, now);
}

const dedupeReviewers = (reviewers: readonly { userId: string; approver: boolean }[]) => {
  const map = new Map<string, boolean>();
  for (const r of reviewers) map.set(r.userId, (map.get(r.userId) ?? false) || r.approver);
  return [...map].map(([userId, approver]) => ({ userId, approver }));
};

export async function getTask(id: string, now = new Date()): Promise<TaskDetail> {
  const graph = await repository.findTaskGraph(id);
  if (!graph) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
  const { task } = graph;
  const people = await peopleMap([
    task.createdById,
    task.assignedById ?? '',
    ...graph.assignees.map((a) => a.userId),
    ...graph.reviewers.map((r) => r.userId),
    ...graph.comments.map((c) => c.authorId),
    ...graph.timeLogs.map((l) => l.userId),
  ]);
  const linkedLabel = task.linkedKind && task.linkedId ? await repository.linkedLabel(task.linkedKind, task.linkedId) : null;
  const issues = [...graph.issues].sort((a, b) => Number(isOpenIssue(b)) - Number(isOpenIssue(a)) || SEVERITY_RANK[a.severity]! - SEVERITY_RANK[b.severity]! || b.createdAt.getTime() - a.createdAt.getTime());
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    startDate: iso(task.startDate),
    deadline: iso(task.deadline),
    actualStartDate: iso(task.actualStartDate),
    revisedEndDate: iso(task.revisedEndDate),
    completedAt: iso(task.completedAt),
    effortEstimateH: task.effortEstimateH,
    recurrence: task.recurrence,
    tags: task.tags,
    blockedReason: task.blockedReason,
    overdue: isOverdue(task, now),
    blockedByIssue: graph.issues.some((issue) => issue.status === 'OPEN' && issue.severity === 'CRITICAL'),
    childrenAllVerified: graph.children.length > 0 && graph.children.every((child) => child.status === 'VERIFIED'),
    createdBy: personOf(people, task.createdById),
    assignedBy: task.assignedById ? personOf(people, task.assignedById) : null,
    project: graph.project,
    parent: graph.parent,
    children: graph.children.map((child) => ({ id: child.id, displayId: child.displayId, title: child.title, status: child.status, progress: child.progress, deadline: iso(child.deadline) })),
    assignees: graph.assignees.map((a) => personOf(people, a.userId)),
    reviewers: graph.reviewers.map((r) => ({ ...personOf(people, r.userId), approver: r.approver, approvedAt: iso(r.approvedAt), rejectedAt: iso(r.rejectedAt), note: r.note })),
    prerequisites: graph.prerequisites,
    dependents: graph.dependents,
    comments: graph.comments.map((c) => ({ id: c.id, author: personOf(people, c.authorId), body: c.body, createdAt: c.createdAt.toISOString() })),
    timeLogs: { rows: graph.timeLogs.map((log) => toTimeLogView(log, people)), totals: totalsOf(graph.timeLogs) },
    issues: issues.map(toIssueView),
    linked: task.linkedKind && task.linkedId ? { kind: task.linkedKind, id: task.linkedId, label: linkedLabel } : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

const TASK_AUDIT_FIELDS = [
  'title',
  'description',
  'priority',
  'startDate',
  'deadline',
  'revisedEndDate',
  'effortEstimateH',
  'progress',
  'linkedKind',
  'linkedId',
  'recurrence',
  'tags',
  'projectId',
  'blockedReason',
] as const;

export async function patchTask(id: string, patch: PatchTaskInput, actor: Actor, now = new Date()): Promise<TaskDetail> {
  const before = await requireTask(id);
  const children = await repository.findChildren(id);
  if (patch.progress !== undefined && children.length > 0) {
    throw new ApiError(409, 'CONFLICT', "A parent's progress is the mean of its sub-tasks' — set theirs");
  }
  if (patch.projectId !== undefined) {
    if (before.parentTaskId) {
      const parent = await requireTask(before.parentTaskId);
      if ((patch.projectId ?? null) !== (parent.projectId ?? null)) {
        throw new ApiError(409, 'CONFLICT', "A sub-task follows its parent's project", { parentProjectId: parent.projectId });
      }
    } else if (patch.projectId) {
      await requireProject(patch.projectId);
    }
  }
  const linkedKind = patch.linkedKind !== undefined ? patch.linkedKind : before.linkedKind;
  const linkedId = patch.linkedId !== undefined ? patch.linkedId : before.linkedId;
  if (patch.linkedKind !== undefined || patch.linkedId !== undefined) await requireLinked(linkedKind, linkedId);

  const update: TaskPatch = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
    ...(patch.revisedEndDate !== undefined ? { revisedEndDate: patch.revisedEndDate } : {}),
    ...(patch.effortEstimateH !== undefined ? { effortEstimateH: patch.effortEstimateH } : {}),
    ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
    ...(patch.linkedKind !== undefined || patch.linkedId !== undefined ? { linkedKind, linkedId } : {}),
    ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence ? { ...patch.recurrence, occurrence: before.recurrence?.occurrence ?? 1 } : null } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
  };
  const after = await repository.updateTask(id, update);
  // A project change carries the sub-tasks along: they follow their parent.
  if (patch.projectId !== undefined && children.length > 0) {
    for (const child of children) await repository.updateTask(child.id, { projectId: patch.projectId });
  }
  if (patch.progress !== undefined && after.parentTaskId) await rollUp(after.parentTaskId);
  await audit(actor, 'WORK_TASK_UPDATED', 'WorkTask', id, { diff: auditDiff(before, after, TASK_AUDIT_FIELDS), metadata: { fields: Object.keys(patch) } });
  return getTask(id, now);
}

/** DRAFT with no children is deleted outright; anything else is archived. */
export async function deleteTask(id: string, actor: Actor): Promise<{ deleted: boolean }> {
  const task = await requireTask(id);
  const children = await repository.findChildren(id);
  if (task.status === 'DRAFT' && children.length === 0) {
    await repository.deleteTask(id);
    if (task.parentTaskId) await rollUp(task.parentTaskId);
    await audit(actor, 'WORK_TASK_DELETED', 'WorkTask', id, { metadata: { displayId: task.displayId, title: task.title } });
    return { deleted: true };
  }
  await changeStatus(id, { status: 'ARCHIVED' }, actor);
  return { deleted: false };
}

/* ── the status rules ───────────────────────────────────────────────── */

const STATUS_AUDIT_FIELDS = ['status', 'blockedReason', 'actualStartDate', 'completedAt', 'progress'] as const;

/** What each status may move to through the status door; VERIFIED is reached only through the review. */
const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  DRAFT: ['TODO', 'ARCHIVED'],
  TODO: ['IN_PROGRESS', 'BLOCKED', 'ARCHIVED'],
  IN_PROGRESS: ['PENDING_REVIEW', 'BLOCKED', 'ARCHIVED'],
  PENDING_REVIEW: ['VERIFIED', 'ARCHIVED'],
  BLOCKED: ['TODO', 'IN_PROGRESS', 'ARCHIVED'],
  VERIFIED: ['ARCHIVED'],
  ARCHIVED: [],
};

type StatusOptions = {
  /** The review endpoint speaking: PENDING_REVIEW → VERIFIED or → IN_PROGRESS is its to make. */
  viaReview?: boolean;
  reason?: string | undefined;
};

export async function changeStatus(id: string, input: StatusChangeInput, actor: Actor, now = new Date()): Promise<TaskDetail> {
  const task = await requireTask(id);
  await transition(task, input.status, actor, { reason: input.reason }, now);
  return getTask(id, now);
}

async function transition(task: TaskRow, to: TaskStatus, actor: Actor, opts: StatusOptions, now: Date): Promise<TaskRow> {
  const from = task.status;
  const allowed = MOVES[from].includes(to) || (opts.viaReview && from === 'PENDING_REVIEW' && to === 'IN_PROGRESS');
  if (!allowed) {
    throw new ApiError(409, 'CONFLICT', from === 'VERIFIED' ? 'A verified task can only be archived' : `A ${from} task cannot move to ${to}`, { from, to, allowed: MOVES[from] });
  }
  if (to === 'ARCHIVED' && !actor.can('work.edit')) throw new ApiError(403, 'FORBIDDEN', 'Archiving a task needs work.edit', { missing: ['work.edit'] });
  if (to === 'VERIFIED' && !opts.viaReview && !actor.can('work.approve')) {
    throw new ApiError(409, 'CONFLICT', 'A task under review is verified through its review, or by someone holding work.approve');
  }
  if (to === 'BLOCKED' && !opts.reason) throw new ApiError(400, 'VALIDATION_ERROR', 'Blocking a task needs a reason', { field: 'reason' });
  // From TODO or BLOCKED alike — BLOCKED is no side door past the prerequisites; a review's REJECT (from PENDING_REVIEW) is the review's to make.
  if (to === 'IN_PROGRESS' && (from === 'TODO' || from === 'BLOCKED')) {
    const unfinished = (await repository.findPrerequisites(task.id)).filter((p) => !isFinished(p.status));
    if (unfinished.length > 0) throw new ApiError(409, 'CONFLICT', 'A prerequisite is not finished', { prerequisites: unfinished });
  }

  // Q70: review is optional — a task with nobody to review it is verified on completion.
  let target = to;
  let reviewers: ReviewerRow[] = [];
  if (to === 'PENDING_REVIEW') {
    reviewers = await repository.findReviewers(task.id);
    if (reviewers.length === 0) target = 'VERIFIED';
  }

  const patch: TaskPatch = { status: target };
  if (from === 'BLOCKED') patch.blockedReason = null;
  if (target === 'BLOCKED') patch.blockedReason = opts.reason ?? null;
  if (target === 'IN_PROGRESS' && !task.actualStartDate) patch.actualStartDate = now;
  if (target === 'VERIFIED') {
    patch.completedAt = now;
    patch.progress = 100;
  }
  if (target === 'PENDING_REVIEW') {
    // A fresh review round: the marks of the last one are cleared.
    for (const r of reviewers) {
      if (r.approvedAt || r.rejectedAt) await repository.updateReviewer(task.id, r.userId, { approvedAt: null, rejectedAt: null, note: null });
    }
  }
  const after = await repository.updateTask(task.id, patch);
  await audit(actor, 'WORK_TASK_STATUS_CHANGED', 'WorkTask', task.id, {
    diff: auditDiff(task, after, STATUS_AUDIT_FIELDS),
    metadata: { from, to: target, requested: to, reason: opts.reason ?? null, via: opts.viaReview ? 'review' : 'status' },
  });

  if (after.parentTaskId) await rollUp(after.parentTaskId);
  if (target === 'PENDING_REVIEW') for (const r of reviewers) await notifyReviewRequested(after, r.userId);
  if (target === 'VERIFIED') await spawnRecurrence(after, actor, now);
  return after;
}

/** A parent's progress is the mean of its children's, all the way up. */
async function rollUp(parentId: string): Promise<void> {
  const parent = await repository.findTask(parentId);
  if (!parent) return;
  const children = await repository.findChildren(parentId);
  if (children.length === 0) return;
  const progress = Math.round(children.reduce((n, c) => n + c.progress, 0) / children.length);
  if (progress !== parent.progress) await repository.updateTask(parentId, { progress });
  if (parent.parentTaskId) await rollUp(parent.parentTaskId);
}

/* ── recurrence ─────────────────────────────────────────────────────── */

const advance = (date: Date, frequency: Recurrence['frequency']): Date => {
  if (frequency === 'DAILY') return new Date(date.getTime() + DAY_MS);
  if (frequency === 'WEEKLY') return new Date(date.getTime() + 7 * DAY_MS);
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

/**
 * A recurring task verified spawns its next TODO copy — same title, project,
 * people, priority; the dates advanced — until `endDate` or
 * `totalOccurrences`. In the service, no cron: the occasion is the
 * verification itself.
 */
async function spawnRecurrence(task: TaskRow, actor: Actor, now: Date): Promise<TaskRow | null> {
  const rule = task.recurrence;
  if (!rule) return null;
  const occurrence = (rule.occurrence ?? 1) + 1;
  if (rule.totalOccurrences !== undefined && occurrence > rule.totalOccurrences) return null;
  const deadline = task.deadline ? advance(task.deadline, rule.frequency) : null;
  if (rule.endDate && deadline && deadline.getTime() >= dayWindowISTFor(rule.endDate).end.getTime()) return null;
  const startDate = task.startDate ? advance(task.startDate, rule.frequency) : null;
  const [assignees, reviewers] = await Promise.all([repository.findAssignees(task.id), repository.findReviewers(task.id)]);
  const displayId = await allocateIdentifier('TASK');
  const next = await repository.createTask({
    displayId,
    projectId: task.projectId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    description: task.description,
    status: 'TODO',
    priority: task.priority,
    startDate,
    deadline,
    effortEstimateH: task.effortEstimateH,
    linkedKind: task.linkedKind,
    linkedId: task.linkedId,
    recurrence: { ...rule, occurrence },
    tags: task.tags,
    createdById: task.createdById,
    assignedById: task.assignedById,
  });
  if (assignees.length > 0) await repository.setAssignees(next.id, assignees.map((a) => a.userId), now);
  if (reviewers.length > 0) await repository.setReviewers(next.id, reviewers.map((r) => ({ userId: r.userId, approver: r.approver })));
  await audit(actor, 'WORK_TASK_RECURRED', 'WorkTask', next.id, { metadata: { displayId, fromTaskId: task.id, occurrence, frequency: rule.frequency } });
  for (const a of assignees) await notifyAssigned(next, a.userId, null);
  return next;
}

/* ── review, people, prerequisites ──────────────────────────────────── */

export async function reviewTask(id: string, input: ReviewInput, actor: Actor, now = new Date()): Promise<TaskDetail> {
  const task = await requireTask(id);
  if (task.status !== 'PENDING_REVIEW') throw new ApiError(409, 'CONFLICT', 'The task is not under review', { status: task.status });
  const reviewers = await repository.findReviewers(id);
  const mine = reviewers.find((r) => r.userId === actor.userId);
  if (!mine && !actor.can('work.approve')) throw new ApiError(404, 'NOT_FOUND', 'You are not a reviewer of this task');

  if (input.decision === 'REJECT') {
    if (mine) await repository.updateReviewer(id, actor.userId, { rejectedAt: now, note: input.note ?? null });
    await audit(actor, 'WORK_TASK_REVIEWED', 'WorkTask', id, { metadata: { decision: 'REJECT', note: input.note ?? null } });
    // The note is the conversation: it lands as a comment, and the assignees hear it.
    if (input.note) await repository.createComment({ taskId: id, authorId: actor.userId, body: input.note });
    await transition(task, 'IN_PROGRESS', actor, { viaReview: true, reason: input.note }, now);
    const assignees = await repository.findAssignees(id);
    for (const a of assignees) await notifyRejected(task, a.userId, input.note ?? null);
    return getTask(id, now);
  }

  const marked: ReviewerRow[] = mine ? reviewers.map((r) => (r.userId === actor.userId ? { ...r, approvedAt: now, rejectedAt: null, note: input.note ?? null } : r)) : reviewers;
  if (mine) await repository.updateReviewer(id, actor.userId, { approvedAt: now, rejectedAt: null, note: input.note ?? null });
  await audit(actor, 'WORK_TASK_REVIEWED', 'WorkTask', id, { metadata: { decision: 'APPROVE', note: input.note ?? null } });

  // Every approver row signed → VERIFIED; with no approver rows, any reviewer's
  // approval verifies; work.approve verifies outright.
  const approvers = marked.filter((r) => r.approver);
  const verified = !mine ? true : approvers.length > 0 ? approvers.every((r) => r.approvedAt !== null) : true;
  if (verified) await transition(task, 'VERIFIED', actor, { viaReview: true }, now);
  return getTask(id, now);
}

export async function setAssignees(id: string, userIds: readonly string[], actor: Actor, now = new Date()): Promise<TaskDetail> {
  const task = await requireTask(id);
  const unique = [...new Set(userIds)];
  await resolvePeople(unique);
  const before = await repository.findAssignees(id);
  const after = await repository.setAssignees(id, unique, now);
  await repository.updateTask(id, { assignedById: actor.userId });
  await audit(actor, 'WORK_TASK_ASSIGNEES_SET', 'WorkTask', id, {
    diff: auditDiff({ assignees: before.map((a) => a.userId) }, { assignees: after.map((a) => a.userId) }),
  });
  const had = new Set(before.map((a) => a.userId));
  const added = after.filter((a) => !had.has(a.userId));
  const by = added.length > 0 ? await actorName(actor) : null;
  for (const a of added) await notifyAssigned(task, a.userId, by);
  return getTask(id, now);
}

export async function setReviewers(id: string, reviewers: readonly { userId: string; approver: boolean }[], actor: Actor, now = new Date()): Promise<TaskDetail> {
  const task = await requireTask(id);
  const list = dedupeReviewers(reviewers);
  await resolvePeople(list.map((r) => r.userId));
  const before = await repository.findReviewers(id);
  const after = await repository.setReviewers(id, list);
  await audit(actor, 'WORK_TASK_REVIEWERS_SET', 'WorkTask', id, {
    diff: auditDiff({ reviewers: before.map((r) => `${r.userId}${r.approver ? ':approver' : ''}`) }, { reviewers: after.map((r) => `${r.userId}${r.approver ? ':approver' : ''}`) }),
  });
  if (task.status === 'PENDING_REVIEW') {
    const had = new Set(before.map((r) => r.userId));
    for (const r of after) if (!had.has(r.userId)) await notifyReviewRequested(task, r.userId);
  }
  return getTask(id, now);
}

/**
 * Prerequisites, with the cycle check: walking up from the proposed
 * prerequisites must never reach the task itself. The 409 names the path.
 */
export async function setPrerequisites(id: string, ids: readonly string[], actor: Actor, now = new Date()): Promise<TaskDetail> {
  await requireTask(id);
  const unique = [...new Set(ids)];
  if (unique.includes(id)) throw new ApiError(409, 'CONFLICT', 'A task cannot be its own prerequisite', { cycle: [id, id] });
  for (const prerequisiteId of unique) await requireTask(prerequisiteId);
  const cycle = await findCycle(id, unique);
  if (cycle) throw new ApiError(409, 'CONFLICT', 'That would make a cycle of prerequisites', { cycle });
  const before = (await repository.findPrerequisites(id)).map((p) => p.id);
  await repository.setPrerequisites(id, unique);
  await audit(actor, 'WORK_TASK_PREREQUISITES_SET', 'WorkTask', id, { diff: auditDiff({ prerequisites: before }, { prerequisites: unique }) });
  return getTask(id, now);
}

/** The path `id ← … ← prerequisite` that closes on `id`, or null. Breadth-first over the stored edges. */
async function findCycle(id: string, prerequisiteIds: readonly string[]): Promise<string[] | null> {
  const parent = new Map<string, string>();
  let frontier = [...prerequisiteIds];
  for (const p of frontier) parent.set(p, id);
  while (frontier.length > 0) {
    const edges = await repository.findPrerequisiteEdges(frontier);
    const next: string[] = [];
    for (const edge of edges) {
      if (edge.prerequisiteId === id) {
        // Walk back up to the task: `id` needs …, which needs `edge.taskId`, which needs `id`.
        const chain: string[] = [];
        for (let at: string | undefined = edge.taskId; at && at !== id; at = parent.get(at)) chain.push(at);
        return [id, ...chain.reverse(), id];
      }
      if (!parent.has(edge.prerequisiteId)) {
        parent.set(edge.prerequisiteId, edge.taskId);
        next.push(edge.prerequisiteId);
      }
    }
    frontier = next;
  }
  return null;
}

/* ── comments and time ──────────────────────────────────────────────── */

/** Everyone on the task: assignees, reviewers and the creator. */
async function peopleOn(task: TaskRow): Promise<Set<string>> {
  const [assignees, reviewers] = await Promise.all([repository.findAssignees(task.id), repository.findReviewers(task.id)]);
  return new Set([task.createdById, ...assignees.map((a) => a.userId), ...reviewers.map((r) => r.userId)]);
}

export async function addComment(id: string, input: CommentInput, actor: Actor): Promise<{ id: string; author: PersonView; body: string; createdAt: string }> {
  const task = await requireTask(id);
  const row: CommentRow = await repository.createComment({ taskId: id, authorId: actor.userId, body: input.body });
  // The console's comment is an ADMIN write and leaves a row; an assignee's own, through `/me`, is theirs.
  if (actor.can('work.view')) await audit(actor, 'WORK_TASK_COMMENTED', 'WorkTask', id, { metadata: { commentId: row.id } });
  const people = await peopleMap([actor.userId]);
  const author = personOf(people, actor.userId);
  const audience = await peopleOn(task);
  audience.delete(actor.userId);
  const preview = input.body.length > 120 ? `${input.body.slice(0, 117)}…` : input.body;
  for (const userId of audience) await notifyComment(task, userId, author.name, preview);
  return { id: row.id, author, body: row.body, createdAt: row.createdAt.toISOString() };
}

/** By an assignee of the task, or `work.edit` for anyone; the hours are always the actor's own. */
export async function logTime(id: string, input: TimeLogInput, actor: Actor): Promise<TimeLogView> {
  await requireTask(id);
  const assignees = await repository.findAssignees(id);
  if (!assignees.some((a) => a.userId === actor.userId) && !actor.can('work.edit')) {
    throw new ApiError(403, 'FORBIDDEN', 'Only an assignee logs hours on a task', { missing: ['work.edit'] });
  }
  const row = await repository.createTimeLog({ taskId: id, userId: actor.userId, forDate: dateColumn(input.forDate), hours: input.hours, billable: input.billable, note: input.note ?? null });
  // `work.view` is the console door: a `/me` actor holds nothing, and their own hours are not an ADMIN write.
  if (actor.can('work.view')) await audit(actor, 'WORK_TIME_LOGGED', 'WorkTask', id, { metadata: { logId: row.id, forDate: input.forDate, hours: input.hours, billable: input.billable } });
  return toTimeLogView(row, await peopleMap([actor.userId]));
}

export async function deleteTimeLog(taskId: string, logId: string, actor: Actor): Promise<void> {
  const row = await repository.findTimeLog(logId);
  if (!row || row.taskId !== taskId) throw new ApiError(404, 'NOT_FOUND', 'Time log not found');
  if (row.userId !== actor.userId && !actor.can('work.edit')) throw new ApiError(403, 'FORBIDDEN', 'Only your own hours can be removed', { missing: ['work.edit'] });
  await repository.deleteTimeLog(logId);
  if (actor.can('work.view')) await audit(actor, 'WORK_TIME_LOG_DELETED', 'WorkTask', taskId, { metadata: { logId, userId: row.userId, hours: row.hours, forDate: isoDateOf(row.forDate) } });
}

export async function listTimeLogs(query: TimeLogsQuery): Promise<{ items: TimeLogView[]; totals: { hours: number; billableHours: number } }> {
  const rows = await repository.findTimeLogs({
    userId: query.userId,
    projectId: query.projectId,
    from: query.from ? dateColumn(query.from) : undefined,
    to: query.to ? dateColumn(query.to) : undefined,
  });
  const people = await peopleMap(rows.map((r) => r.userId));
  return { items: rows.map((row) => toTimeLogView(row, people, { id: row.task.id, displayId: row.task.displayId, title: row.task.title })), totals: totalsOf(rows) };
}

/* ── issues ─────────────────────────────────────────────────────────── */

export type IssueView = {
  id: string;
  displayId: string | null;
  projectId: string | null;
  taskId: string | null;
  title: string;
  description: string | null;
  severity: IssueRow['severity'];
  status: IssueRow['status'];
  raisedById: string;
  assigneeId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const toIssueView = (row: IssueRow): IssueView => ({
  id: row.id,
  displayId: row.displayId,
  projectId: row.projectId,
  taskId: row.taskId,
  title: row.title,
  description: row.description,
  severity: row.severity,
  status: row.status,
  raisedById: row.raisedById,
  assigneeId: row.assigneeId,
  resolution: row.resolution,
  resolvedAt: iso(row.resolvedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export type IssueDetail = IssueView & { raisedBy: PersonView; assignee: PersonView | null; task: { id: string; displayId: string | null; title: string } | null };

/** The detail every issue write and read answers — an explicit literal (no spread) so the console's contract audit can trace it. */
async function issueDetail(row: IssueRow): Promise<IssueDetail> {
  const [people, task] = await Promise.all([peopleMap([row.raisedById, row.assigneeId ?? '']), row.taskId ? repository.findTask(row.taskId) : Promise.resolve(null)]);
  return {
    id: row.id,
    displayId: row.displayId,
    projectId: row.projectId,
    taskId: row.taskId,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    raisedById: row.raisedById,
    assigneeId: row.assigneeId,
    resolution: row.resolution,
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    raisedBy: personOf(people, row.raisedById),
    assignee: row.assigneeId ? personOf(people, row.assigneeId) : null,
    task: task ? { id: task.id, displayId: task.displayId, title: task.title } : null,
  };
}

export async function listIssues(query: IssuesQuery): Promise<ListPage<IssueDetail>> {
  const filter = { q: query.q, statuses: query.status, severity: query.severity, projectId: query.projectId, taskId: query.taskId, assigneeId: query.assigneeId };
  const [{ rows, total }, counts] = await Promise.all([
    repository.findIssues(filter, { skip: (query.page - 1) * query.pageSize, take: query.pageSize }, query.sort),
    repository.countIssuesByStatus({ ...filter, statuses: undefined }),
  ]);
  const items = await Promise.all(rows.map(issueDetail));
  return toListPage(items, total, fill(counts, ISSUE_STATUSES), query);
}

export async function createIssue(input: CreateIssueInput, actor: Actor): Promise<IssueDetail> {
  let projectId = input.projectId ?? null;
  if (input.taskId) {
    const task = await requireTask(input.taskId);
    if (!projectId) projectId = task.projectId;
  }
  if (projectId) await requireProject(projectId);
  if (input.assigneeId) await resolvePeople([input.assigneeId]);
  const displayId = await allocateIdentifier('ISSUE');
  const row = await repository.createIssue({
    displayId,
    projectId,
    taskId: input.taskId ?? null,
    title: input.title,
    description: input.description ?? null,
    severity: input.severity,
    raisedById: actor.userId,
    assigneeId: input.assigneeId ?? null,
  });
  await audit(actor, 'WORK_ISSUE_CREATED', 'WorkIssue', row.id, { metadata: { displayId, title: row.title, severity: row.severity, taskId: row.taskId, projectId } });
  return issueDetail(row);
}

async function requireIssue(id: string): Promise<IssueRow> {
  const row = await repository.findIssue(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Issue not found');
  return row;
}

export async function getIssue(id: string): Promise<IssueDetail> {
  return issueDetail(await requireIssue(id));
}

const ISSUE_AUDIT_FIELDS = ['title', 'description', 'severity', 'status', 'assigneeId', 'resolution'] as const;

export async function patchIssue(id: string, patch: PatchIssueInput, actor: Actor): Promise<IssueDetail> {
  const before = await requireIssue(id);
  if (patch.assigneeId) await resolvePeople([patch.assigneeId]);
  if (patch.status !== undefined && !isOpenIssue(before)) throw new ApiError(409, 'CONFLICT', 'A closed issue is reopened through /reopen', { status: before.status });
  const after = await repository.updateIssue(id, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
    ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  });
  await audit(actor, 'WORK_ISSUE_UPDATED', 'WorkIssue', id, { diff: auditDiff(before, after, ISSUE_AUDIT_FIELDS), metadata: { fields: Object.keys(patch) } });
  return issueDetail(after);
}

export async function resolveIssue(id: string, input: ResolveIssueInput, actor: Actor, now = new Date()): Promise<IssueDetail> {
  const before = await requireIssue(id);
  if (!isOpenIssue(before)) throw new ApiError(409, 'CONFLICT', 'The issue is already closed', { status: before.status });
  const after = await repository.updateIssue(id, { status: input.status, resolution: input.resolution, resolvedAt: now });
  await audit(actor, 'WORK_ISSUE_RESOLVED', 'WorkIssue', id, { diff: auditDiff(before, after, ISSUE_AUDIT_FIELDS), metadata: { status: input.status } });
  return issueDetail(after);
}

export async function reopenIssue(id: string, actor: Actor): Promise<IssueDetail> {
  const before = await requireIssue(id);
  if (isOpenIssue(before)) throw new ApiError(409, 'CONFLICT', 'The issue is open', { status: before.status });
  const after = await repository.updateIssue(id, { status: 'OPEN', resolution: null, resolvedAt: null });
  await audit(actor, 'WORK_ISSUE_REOPENED', 'WorkIssue', id, { diff: auditDiff(before, after, ISSUE_AUDIT_FIELDS) });
  return issueDetail(after);
}

/* ── overview ───────────────────────────────────────────────────────── */

export type Overview = {
  window: { from: string; to: string };
  tasks: { total: number; byStatus: Record<string, number>; byPriority: Record<string, number>; overdue: number; dueThisWeek: number; verifiedInWindow: number };
  trend: { month: string; planned: number; completed: number }[];
  issues: { open: number; bySeverity: Record<string, number>; byStatus: Record<string, number> };
  workload: { person: PersonView; open: number; inProgress: number; overdue: number; hoursInWindow: number }[];
  overdueList: { id: string; displayId: string | null; title: string; deadline: string | null; assignees: PersonView[] }[];
  projects: { id: string; displayId: string | null; name: string; kind: ProjectRow['kind']; open: number; verified: number; progress: number }[];
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istParts = (at: Date) => {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};
const pad = (n: number) => String(n).padStart(2, '0');

/** The Indian months `from`..`to` touch, each as `YYYY-MM` with its instant window. */
function monthsBetween(from: string, to: string): { month: string; start: Date; end: Date }[] {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  const out: { month: string; start: Date; end: Date }[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const { start, end } = monthWindowIST(y, m);
    out.push({ month: `${y}-${pad(m)}`, start, end });
    if (out.length >= 24) break;
  }
  return out;
}

const within = (at: Date | null, start: Date, end: Date): boolean => at !== null && at.getTime() >= start.getTime() && at.getTime() < end.getTime();
const OVERVIEW_TAKE = 5000;

export async function overview(query: OverviewQuery, now = new Date()): Promise<Overview> {
  const { year, month } = istParts(now);
  const from = query.from ?? `${year}-${pad(month)}-01`;
  const to = query.to ?? isoDateOf(new Date(monthWindowIST(year, month).end.getTime() - 1 + IST_OFFSET_MS));
  const window = { start: dayWindowISTFor(from).start, end: dayWindowISTFor(to).end };
  const week = { start: now, end: new Date(now.getTime() + 7 * DAY_MS) };

  const [{ rows: tasks }, openIssues, issueCounts, logs, { rows: projects }] = await Promise.all([
    repository.findTasks({ projectId: query.projectId, excludeArchived: true }, { skip: 0, take: OVERVIEW_TAKE }, { sort: 'UPDATED', dir: 'desc' }),
    repository.findOpenIssues(query.projectId),
    repository.countIssuesByStatus({ projectId: query.projectId }),
    repository.findTimeLogs({ projectId: query.projectId, from: dateColumn(from), to: dateColumn(to) }),
    repository.findProjects({ statuses: ['ACTIVE'] }, { skip: 0, take: 100 }, 'name'),
  ]);

  const byStatus = fill({}, TASK_STATUSES);
  const byPriority = fill({}, PRIORITIES);
  let overdue = 0;
  let dueThisWeek = 0;
  let verifiedInWindow = 0;
  const load = new Map<string, { open: number; inProgress: number; overdue: number; hours: number }>();
  const loadOf = (userId: string) => {
    let entry = load.get(userId);
    if (!entry) load.set(userId, (entry = { open: 0, inProgress: 0, overdue: 0, hours: 0 }));
    return entry;
  };
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
    const late = isOverdue(task, now);
    if (late) overdue += 1;
    if (!isFinished(task.status) && within(task.deadline, week.start, week.end)) dueThisWeek += 1;
    if (task.status === 'VERIFIED' && within(task.completedAt, window.start, window.end)) verifiedInWindow += 1;
    const open = (OPEN_STATUSES as readonly string[]).includes(task.status);
    for (const a of task.assignees) {
      const entry = loadOf(a.userId);
      if (open) entry.open += 1;
      if (task.status === 'IN_PROGRESS') entry.inProgress += 1;
      if (late) entry.overdue += 1;
    }
  }
  for (const log of logs) loadOf(log.userId).hours += log.hours;

  const trend = monthsBetween(from, to).map(({ month: label, start, end }) => ({
    month: label,
    planned: tasks.filter((t) => within(t.deadline, start, end)).length,
    completed: tasks.filter((t) => within(t.completedAt, start, end)).length,
  }));

  const bySeverity = fill({}, ISSUE_SEVERITIES);
  for (const issue of openIssues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;

  const workloadIds = [...load.entries()].sort((a, b) => b[1].open - a[1].open || b[1].overdue - a[1].overdue || a[0].localeCompare(b[0])).slice(0, 12);
  const overdueRows = tasks.filter((t) => isOverdue(t, now)).sort((a, b) => a.deadline!.getTime() - b.deadline!.getTime()).slice(0, 8);
  const people = await peopleMap([...workloadIds.map(([id]) => id), ...overdueRows.flatMap((t) => t.assignees.map((a) => a.userId))]);

  const scoped = query.projectId ? projects.filter((p) => p.id === query.projectId) : projects;
  return {
    window: { from, to },
    tasks: { total: tasks.length, byStatus, byPriority, overdue, dueThisWeek, verifiedInWindow },
    trend,
    issues: { open: openIssues.length, bySeverity, byStatus: fill(issueCounts, ISSUE_STATUSES) },
    workload: workloadIds.map(([userId, entry]) => ({ person: personOf(people, userId), open: entry.open, inProgress: entry.inProgress, overdue: entry.overdue, hoursInWindow: round2(entry.hours) })),
    overdueList: overdueRows.map((t) => ({ id: t.id, displayId: t.displayId, title: t.title, deadline: iso(t.deadline), assignees: t.assignees.map((a) => personOf(people, a.userId)) })),
    projects: scoped.map((p) => {
      const own = tasks.filter((t) => t.projectId === p.id);
      return {
        id: p.id,
        displayId: p.displayId,
        name: p.name,
        kind: p.kind,
        open: own.filter((t) => (OPEN_STATUSES as readonly string[]).includes(t.status)).length,
        verified: own.filter((t) => t.status === 'VERIFIED').length,
        progress: own.length === 0 ? 0 : Math.round(own.reduce((n, t) => n + t.progress, 0) / own.length),
      };
    }),
  };
}

/* ── board ──────────────────────────────────────────────────────────── */

export type Board = { columns: { status: TaskStatus; count: number; more: number; tasks: TaskCard[] }[] };

export async function board(query: BoardQuery, now = new Date()): Promise<Board> {
  const columns = await Promise.all(
    BOARD_STATUSES.map(async (status) => {
      const { rows, total } = await repository.findTasks(
        { projectId: query.projectId, assigneeUserId: query.assigneeUserId, statuses: [status] },
        { skip: 0, take: BOARD_CAP },
        { sort: 'UPDATED', dir: 'desc' },
      );
      return { status, total, rows };
    }),
  );
  const people = await peopleMap(columns.flatMap((c) => c.rows.flatMap((r) => r.assignees.map((a) => a.userId))));
  return {
    columns: columns.map((c) => ({ status: c.status, count: c.total, more: Math.max(0, c.total - c.rows.length), tasks: c.rows.map((row) => toCard(row, people, now)) })),
  };
}

/* ── me ─────────────────────────────────────────────────────────────── */

const MY_TAKE = 200;

/**
 * AB-B: the tasks awaiting the caller's review — PENDING_REVIEW, the caller
 * a reviewer, and no mark of theirs yet (neither approved nor rejected),
 * deadline-sorted. `?reviewing=true` lists exactly these rows and the
 * summary's `awaitingMyReview` is their count: one read, two readers.
 */
async function awaitingMyReview(userId: string): Promise<TaskListRow[]> {
  const { rows } = await repository.findTasks({ reviewerUserId: userId, statuses: ['PENDING_REVIEW'] }, { skip: 0, take: MY_TAKE }, { sort: 'DEADLINE', dir: 'asc' });
  return rows.filter((t) => t.reviewers.some((r) => r.userId === userId && r.approvedAt === null && r.rejectedAt === null));
}

/** The caller's own tasks, deadline-sorted, the overdue ones first — or, under `reviewing=true`, the tasks awaiting their review. */
export async function myTasks(userId: string, query: MyTasksQuery, now = new Date()): Promise<{ items: TaskCard[]; total: number }> {
  const { rows, total } = query.reviewing
    ? await awaitingMyReview(userId).then((rows) => ({ rows, total: rows.length }))
    : await repository.findTasks({ assigneeUserId: userId, statuses: query.status ?? OPEN_STATUSES }, { skip: 0, take: MY_TAKE }, { sort: 'DEADLINE', dir: 'asc' });
  const people = await peopleMap(rows.flatMap((row) => row.assignees.map((a) => a.userId)));
  const cards = rows.map((row) => toCard(row, people, now)).sort((a, b) => Number(b.overdue) - Number(a.overdue));
  return { items: cards, total };
}

/** 404 unless the caller is assigned to the task or reviews it. */
async function requireMine(id: string, userId: string): Promise<{ task: TaskRow; assigned: boolean; reviewer: boolean }> {
  const task = await repository.findTask(id);
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
  const [assignees, reviewers] = await Promise.all([repository.findAssignees(id), repository.findReviewers(id)]);
  const assigned = assignees.some((a) => a.userId === userId);
  const reviewer = reviewers.some((r) => r.userId === userId);
  if (!assigned && !reviewer) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
  return { task, assigned, reviewer };
}

/** A `/me` actor holds no console permission, whatever the token says: the own-rules apply. */
export const selfActor = (userId: string, req?: Request): Actor => ({ userId, req, can: () => false });

export async function myTask(id: string, userId: string, now = new Date()): Promise<TaskDetail> {
  await requireMine(id, userId);
  return getTask(id, now);
}

export async function myStatusChange(id: string, input: MyStatusChangeInput, actor: Actor, now = new Date()): Promise<TaskDetail> {
  const { assigned } = await requireMine(id, actor.userId);
  if (!assigned) throw new ApiError(403, 'FORBIDDEN', 'Only an assignee moves the task');
  return changeStatus(id, input, actor, now);
}

export async function myComment(id: string, input: CommentInput, actor: Actor) {
  await requireMine(id, actor.userId);
  return addComment(id, input, actor);
}

export async function myTimeLog(id: string, input: TimeLogInput, actor: Actor) {
  const { assigned } = await requireMine(id, actor.userId);
  if (!assigned) throw new ApiError(403, 'FORBIDDEN', 'Only an assignee logs hours on a task');
  return logTime(id, input, actor);
}

export async function myReview(id: string, input: ReviewInput, actor: Actor, now = new Date()) {
  const { reviewer } = await requireMine(id, actor.userId);
  if (!reviewer) throw new ApiError(404, 'NOT_FOUND', 'You are not a reviewer of this task');
  return reviewTask(id, input, actor, now);
}

export async function mySummary(userId: string, now = new Date()): Promise<{ open: number; dueToday: number; overdue: number; awaitingMyReview: number }> {
  const today = dayWindowIST(now);
  const [{ rows: mine }, reviewing] = await Promise.all([
    repository.findTasks({ assigneeUserId: userId, statuses: OPEN_STATUSES }, { skip: 0, take: MY_TAKE }, { sort: 'DEADLINE', dir: 'asc' }),
    awaitingMyReview(userId),
  ]);
  return {
    open: mine.length,
    dueToday: mine.filter((t) => within(t.deadline, today.start, today.end)).length,
    overdue: mine.filter((t) => isOverdue(t, now)).length,
    awaitingMyReview: reviewing.length,
  };
}

/* ── the daily due sweep ────────────────────────────────────────────── */

const DUE_KEY = (kind: 'due' | 'overdue', taskId: string, day: string) => `work:${kind}:${taskId}:${day}`;
const DUE_TTL_SECONDS = 36 * 60 * 60;

/** True the first time this task is told today; the Redis key makes the sweep idempotent. */
async function firstToday(kind: 'due' | 'overdue', taskId: string, day: string): Promise<boolean> {
  try {
    return (await redis.set(DUE_KEY(kind, taskId, day), '1', 'EX', DUE_TTL_SECONDS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('Work due sweep could not mark a task; skipping it this tick', { tag: MODULE, taskId, reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Due tomorrow and overdue, once per task per Indian day, to every assignee.
 * The job under `src/jobs` calls this at 08:00 IST; the keys mean a second
 * tick the same day tells nobody twice.
 */
export async function sweepDueTasks(now = new Date()): Promise<{ dueTomorrow: number; overdue: number }> {
  const { year, month, day } = istParts(now);
  const today = `${year}-${pad(month)}-${pad(day)}`;
  const tomorrow = dayWindowIST(new Date(now.getTime() + DAY_MS));
  const [{ rows: due }, { rows: late }] = await Promise.all([
    repository.findTasks({ statuses: OPEN_STATUSES, dueFrom: tomorrow.start, dueTo: new Date(tomorrow.end.getTime() - 1) }, { skip: 0, take: OVERVIEW_TAKE }, { sort: 'DEADLINE', dir: 'asc' }),
    repository.findTasks({ statuses: OPEN_STATUSES, overdueAt: now }, { skip: 0, take: OVERVIEW_TAKE }, { sort: 'DEADLINE', dir: 'asc' }),
  ]);
  let dueTomorrow = 0;
  let overdue = 0;
  for (const task of due) {
    if (!(await firstToday('due', task.id, today))) continue;
    dueTomorrow += 1;
    for (const a of task.assignees) await notifyDueTomorrow(task, a.userId);
  }
  for (const task of late) {
    if (!(await firstToday('overdue', task.id, today))) continue;
    overdue += 1;
    for (const a of task.assignees) await notifyOverdue(task, a.userId);
  }
  return { dueTomorrow, overdue };
}
