import { prisma, Prisma, type WorkIssue, type WorkIssueStatus, type WorkProject, type WorkTask, type WorkTaskStatus, type WorkTimeLog } from '../../shared/database';
import type {
  IssueFilter,
  IssueRow,
  PersonRow,
  ProjectFilter,
  ProjectRow,
  Recurrence,
  TaskFilter,
  TaskGraph,
  TaskListRow,
  TaskOrder,
  TaskPage,
  TaskRow,
  TimeLogFilter,
  TimeLogRow,
  WorkRepository,
} from './work.repository';
import { FINISHED_STATUSES, OPEN_ISSUE_STATUSES, type LinkedKind, type PersonKind } from './work.schema';

const OPEN_ISSUES: WorkIssueStatus[] = [...OPEN_ISSUE_STATUSES];
const FINISHED: WorkTaskStatus[] = [...FINISHED_STATUSES];

/**
 * The Prisma `WorkRepository` — Lot AA. The work tables are this module's;
 * the people and the linked records are read from their owners' tables and
 * never written.
 */

const toProject = (row: WorkProject): ProjectRow => ({ ...row });

const toTask = (row: WorkTask): TaskRow => ({
  ...row,
  linkedKind: row.linkedKind as TaskRow['linkedKind'],
  effortEstimateH: row.effortEstimateH === null ? null : Number(row.effortEstimateH),
  recurrence: (row.recurrence as Recurrence | null) ?? null,
});

const toTimeLog = (row: WorkTimeLog): TimeLogRow => ({ ...row, hours: Number(row.hours) });
const toIssue = (row: WorkIssue): IssueRow => ({ ...row });

const PROJECT_LITE = { select: { id: true, displayId: true, name: true, kind: true } } satisfies Prisma.WorkProjectDefaultArgs;
const TASK_REF = { select: { id: true, displayId: true, title: true, status: true } } satisfies Prisma.WorkTaskDefaultArgs;
const LIST_INCLUDE = {
  project: PROJECT_LITE,
  assignees: true,
  reviewers: true,
  _count: { select: { children: true, issues: { where: { status: { in: OPEN_ISSUES } } } } },
} satisfies Prisma.WorkTaskInclude;

type ListRow = Prisma.WorkTaskGetPayload<{ include: typeof LIST_INCLUDE }>;

const toListRow = (row: ListRow): TaskListRow => {
  const { project, assignees, reviewers, _count, ...task } = row;
  return { ...toTask(task), project, assignees, reviewers, openIssues: _count.issues, childCount: _count.children };
};

function projectWhere(filter: ProjectFilter): Prisma.WorkProjectWhereInput {
  return {
    ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.cityId ? { cityId: filter.cityId } : {}),
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { displayId: { contains: filter.q, mode: 'insensitive' } }] } : {}),
  };
}

function taskWhere(filter: TaskFilter): Prisma.WorkTaskWhereInput {
  const and: Prisma.WorkTaskWhereInput[] = [];
  if (filter.statuses) and.push({ status: { in: [...filter.statuses] } });
  else if (filter.excludeArchived) and.push({ status: { not: 'ARCHIVED' } });
  if (filter.priority) and.push({ priority: filter.priority });
  if (filter.projectId) and.push({ projectId: filter.projectId });
  if (filter.parentTaskId) and.push({ parentTaskId: filter.parentTaskId });
  if (filter.linkedKind) and.push({ linkedKind: filter.linkedKind });
  if (filter.linkedId) and.push({ linkedId: filter.linkedId });
  if (filter.tag) and.push({ tags: { has: filter.tag } });
  if (filter.assigneeUserId) and.push({ assignees: { some: { userId: filter.assigneeUserId } } });
  if (filter.reviewerUserId) and.push({ reviewers: { some: { userId: filter.reviewerUserId } } });
  if (filter.q) and.push({ OR: [{ title: { contains: filter.q, mode: 'insensitive' } }, { displayId: { contains: filter.q, mode: 'insensitive' } }] });
  if (filter.dueFrom) and.push({ deadline: { gte: filter.dueFrom } });
  if (filter.dueTo) and.push({ deadline: { lte: filter.dueTo } });
  if (filter.overdueAt) and.push({ deadline: { lt: filter.overdueAt }, status: { notIn: FINISHED } });
  return and.length === 0 ? {} : { AND: and };
}

function taskOrder(order: TaskOrder): Prisma.WorkTaskOrderByWithRelationInput[] {
  switch (order.sort) {
    case 'DEADLINE':
      return [{ deadline: { sort: order.dir, nulls: 'last' } }, { createdAt: 'desc' }];
    case 'PRIORITY':
      // The enum is declared HIGH, MEDIUM, LOW, so ascending is most urgent first.
      return [{ priority: order.dir }, { deadline: { sort: 'asc', nulls: 'last' } }];
    case 'CREATED':
      return [{ createdAt: order.dir }];
    default:
      return [{ updatedAt: order.dir }];
  }
}

function issueWhere(filter: IssueFilter): Prisma.WorkIssueWhereInput {
  return {
    ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
    ...(filter.severity ? { severity: filter.severity } : {}),
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.taskId ? { taskId: filter.taskId } : {}),
    ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
    ...(filter.q ? { OR: [{ title: { contains: filter.q, mode: 'insensitive' } }, { displayId: { contains: filter.q, mode: 'insensitive' } }] } : {}),
  };
}

const fold = (groups: readonly { status: string; _count: { _all: number } | null }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.status] = g._count?._all ?? 0;
  return out;
};

const byName = (a: PersonRow, b: PersonRow) => (a.name ?? '').localeCompare(b.name ?? '');

/** Employees first: a staffer who also carries an agent profile is an EMPLOYEE here. */
async function people(userIds: readonly string[] | null, q: string | undefined, kind: PersonKind | undefined, limit: number): Promise<PersonRow[]> {
  const byId = userIds ? { userId: { in: [...userIds] } } : {};
  const active = userIds ? {} : { isActive: true, user: { isActive: true } };
  const [employees, agents] = await Promise.all([
    kind === 'AGENT'
      ? Promise.resolve([])
      : prisma.employee.findMany({
          where: {
            ...byId,
            ...active,
            ...(q ? { OR: [{ user: { name: { contains: q, mode: 'insensitive' } } }, { designation: { contains: q, mode: 'insensitive' } }, { displayId: { contains: q, mode: 'insensitive' } }] } : {}),
          },
          select: { userId: true, designation: true, department: true, isActive: true, user: { select: { name: true, isActive: true } }, departmentRecord: { select: { name: true } } },
          orderBy: { user: { name: 'asc' } },
          take: limit,
        }),
    kind === 'EMPLOYEE'
      ? Promise.resolve([])
      : prisma.agentProfile.findMany({
          where: {
            ...byId,
            ...(userIds ? {} : { status: 'ACTIVE', user: { isActive: true } }),
            ...(q ? { user: { name: { contains: q, mode: 'insensitive' } } } : {}),
          },
          select: { userId: true, status: true, user: { select: { name: true, isActive: true } } },
          orderBy: { user: { name: 'asc' } },
          take: limit,
        }),
  ]);
  const rows: PersonRow[] = [
    ...employees.map<PersonRow>((e) => ({
      userId: e.userId,
      name: e.user.name,
      kind: 'EMPLOYEE',
      role: e.designation ?? 'Staff',
      departmentName: e.departmentRecord?.name ?? e.department,
      active: e.isActive && e.user.isActive,
    })),
    ...agents.map<PersonRow>((a) => ({ userId: a.userId, name: a.user.name, kind: 'AGENT', role: 'Field agent', departmentName: null, active: a.status === 'ACTIVE' && a.user.isActive })),
  ];
  const seen = new Set<string>();
  return rows
    .filter((row) => (seen.has(row.userId) ? false : (seen.add(row.userId), true)))
    .sort(byName)
    .slice(0, limit);
}

async function linkedLabel(kind: LinkedKind, id: string): Promise<string | null> {
  switch (kind) {
    case 'ORDER': {
      const row = await prisma.order.findUnique({ where: { id }, select: { id: true, campaignName: true } });
      return row ? (row.campaignName ?? row.id) : null;
    }
    case 'LISTING': {
      const row = await prisma.listing.findUnique({ where: { id }, select: { title: true } });
      return row?.title ?? null;
    }
    case 'LEAD': {
      const row = await prisma.lead.findUnique({ where: { id }, select: { displayId: true, businessName: true } });
      return row ? `${row.displayId ? `${row.displayId} · ` : ''}${row.businessName}` : null;
    }
    case 'VISIT': {
      const row = await prisma.fieldVisit.findUnique({ where: { id }, select: { id: true, displayId: true } });
      return row ? (row.displayId ?? row.id) : null;
    }
    case 'CITY': {
      const row = await prisma.city.findUnique({ where: { id }, select: { name: true } });
      return row?.name ?? null;
    }
    case 'PUBLISHER': {
      const row = await prisma.publisher.findUnique({ where: { id }, select: { name: true } });
      return row?.name ?? null;
    }
    case 'ADVERTISER': {
      const row = await prisma.advertiser.findUnique({ where: { id }, select: { name: true } });
      return row?.name ?? null;
    }
    case 'PRINT_PARTNER': {
      const row = await prisma.printPartner.findUnique({ where: { id }, select: { name: true } });
      return row?.name ?? null;
    }
    case 'CAMPAIGN': {
      const row = await prisma.campaign.findUnique({ where: { id }, select: { reference: true } });
      return row?.reference ?? null;
    }
    default:
      return null;
  }
}

export const prismaWorkRepository: WorkRepository = {
  /* ── people and references ─────────────────────────────────────── */

  findPeople(userIds) {
    return userIds.length === 0 ? Promise.resolve([]) : people(userIds, undefined, undefined, userIds.length * 2);
  },
  searchPeople(q, kind, limit) {
    return people(null, q, kind, limit);
  },
  findDepartment(id) {
    return prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
  },
  findCity(id) {
    return prisma.city.findUnique({ where: { id }, select: { id: true, name: true } });
  },
  linkedLabel,

  /* ── projects ──────────────────────────────────────────────────── */

  async findProjects(filter, page, sort) {
    const where = projectWhere(filter);
    const [rows, total] = await Promise.all([
      prisma.workProject.findMany({ where, orderBy: sort === 'name' ? [{ name: 'asc' }] : [{ createdAt: 'desc' }], skip: page.skip, take: page.take }),
      prisma.workProject.count({ where }),
    ]);
    return { rows: rows.map(toProject), total };
  },
  async countProjectsByStatus(filter) {
    const groups = await prisma.workProject.groupBy({ by: ['status'], where: projectWhere(filter), _count: { _all: true } });
    return fold(groups);
  },
  async findProject(id) {
    const row = await prisma.workProject.findUnique({ where: { id } });
    return row ? toProject(row) : null;
  },
  async createProject(data) {
    return toProject(await prisma.workProject.create({ data }));
  },
  async updateProject(id, patch) {
    return toProject(await prisma.workProject.update({ where: { id }, data: patch }));
  },

  /* ── tasks ─────────────────────────────────────────────────────── */

  async findTasks(filter, page, order) {
    const where = taskWhere(filter);
    const [rows, total] = await Promise.all([
      prisma.workTask.findMany({ where, include: LIST_INCLUDE, orderBy: taskOrder(order), skip: page.skip, take: page.take }),
      prisma.workTask.count({ where }),
    ]);
    return { rows: rows.map(toListRow), total };
  },
  async countTasksByStatus(filter) {
    const groups = await prisma.workTask.groupBy({ by: ['status'], where: taskWhere(filter), _count: { _all: true } });
    return fold(groups);
  },
  async findTask(id) {
    const row = await prisma.workTask.findUnique({ where: { id } });
    return row ? toTask(row) : null;
  },
  async findTaskGraph(id): Promise<TaskGraph | null> {
    const row = await prisma.workTask.findUnique({
      where: { id },
      include: {
        project: PROJECT_LITE,
        parent: { select: { id: true, displayId: true, title: true } },
        children: { select: { id: true, displayId: true, title: true, status: true, progress: true, deadline: true }, orderBy: { createdAt: 'asc' } },
        assignees: { orderBy: { assignedAt: 'asc' } },
        reviewers: true,
        dependencies: { include: { prerequisite: TASK_REF } },
        dependents: { include: { task: TASK_REF } },
        comments: { orderBy: { createdAt: 'asc' } },
        timeLogs: { orderBy: [{ forDate: 'desc' }, { loggedAt: 'desc' }] },
        issues: true,
      },
    });
    if (!row) return null;
    const { project, parent, children, assignees, reviewers, dependencies, dependents, comments, timeLogs, issues, ...task } = row;
    return {
      task: toTask(task),
      project,
      parent,
      children,
      assignees,
      reviewers,
      prerequisites: dependencies.map((d) => d.prerequisite),
      dependents: dependents.map((d) => d.task),
      comments,
      timeLogs: timeLogs.map(toTimeLog),
      issues: issues.map(toIssue),
    };
  },
  async createTask(data) {
    const { recurrence, ...rest } = data;
    return toTask(await prisma.workTask.create({ data: { ...rest, recurrence: recurrence === null ? Prisma.JsonNull : (recurrence as Prisma.InputJsonValue) } }));
  },
  async updateTask(id, patch) {
    const { recurrence, ...rest } = patch;
    return toTask(
      await prisma.workTask.update({
        where: { id },
        data: { ...rest, ...(recurrence !== undefined ? { recurrence: recurrence === null ? Prisma.JsonNull : (recurrence as Prisma.InputJsonValue) } : {}) },
      }),
    );
  },
  async deleteTask(id) {
    await prisma.workTask.delete({ where: { id } });
  },
  async findChildren(parentTaskId) {
    return (await prisma.workTask.findMany({ where: { parentTaskId }, orderBy: { createdAt: 'asc' } })).map(toTask);
  },

  findAssignees(taskId) {
    return prisma.workTaskAssignee.findMany({ where: { taskId }, orderBy: { assignedAt: 'asc' } });
  },
  async setAssignees(taskId, userIds, at) {
    await prisma.$transaction([
      prisma.workTaskAssignee.deleteMany({ where: { taskId, userId: { notIn: [...userIds] } } }),
      ...userIds.map((userId) => prisma.workTaskAssignee.upsert({ where: { taskId_userId: { taskId, userId } }, create: { taskId, userId, assignedAt: at }, update: {} })),
    ]);
    return prisma.workTaskAssignee.findMany({ where: { taskId }, orderBy: { assignedAt: 'asc' } });
  },
  findReviewers(taskId) {
    return prisma.workTaskReviewer.findMany({ where: { taskId } });
  },
  async setReviewers(taskId, reviewers) {
    // A reviewer who stays keeps their mark; the approver flag follows the list.
    await prisma.$transaction([
      prisma.workTaskReviewer.deleteMany({ where: { taskId, userId: { notIn: reviewers.map((r) => r.userId) } } }),
      ...reviewers.map((r) =>
        prisma.workTaskReviewer.upsert({ where: { taskId_userId: { taskId, userId: r.userId } }, create: { taskId, userId: r.userId, approver: r.approver }, update: { approver: r.approver } }),
      ),
    ]);
    return prisma.workTaskReviewer.findMany({ where: { taskId } });
  },
  updateReviewer(taskId, userId, patch) {
    return prisma.workTaskReviewer.update({ where: { taskId_userId: { taskId, userId } }, data: patch });
  },
  findPrerequisiteEdges(taskIds) {
    return prisma.workTaskDependency.findMany({ where: { taskId: { in: [...taskIds] } } });
  },
  async findPrerequisites(taskId) {
    const rows = await prisma.workTaskDependency.findMany({ where: { taskId }, include: { prerequisite: TASK_REF } });
    return rows.map((r) => r.prerequisite);
  },
  async setPrerequisites(taskId, prerequisiteIds) {
    await prisma.$transaction([
      prisma.workTaskDependency.deleteMany({ where: { taskId } }),
      ...(prerequisiteIds.length > 0 ? [prisma.workTaskDependency.createMany({ data: prerequisiteIds.map((prerequisiteId) => ({ taskId, prerequisiteId })), skipDuplicates: true })] : []),
    ]);
  },

  createComment(data) {
    return prisma.workTaskComment.create({ data });
  },
  async createTimeLog(data) {
    return toTimeLog(await prisma.workTimeLog.create({ data }));
  },
  async findTimeLog(id) {
    const row = await prisma.workTimeLog.findUnique({ where: { id } });
    return row ? toTimeLog(row) : null;
  },
  async deleteTimeLog(id) {
    await prisma.workTimeLog.delete({ where: { id } });
  },
  async findTimeLogs(filter: TimeLogFilter) {
    const rows = await prisma.workTimeLog.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.taskId ? { taskId: filter.taskId } : {}),
        ...(filter.from || filter.to ? { forDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
        ...(filter.projectId ? { task: { projectId: filter.projectId } } : {}),
      },
      include: { task: { select: { id: true, displayId: true, title: true, projectId: true } } },
      orderBy: [{ forDate: 'desc' }, { loggedAt: 'desc' }],
      take: 5000,
    });
    return rows.map((row) => ({ ...toTimeLog(row), task: row.task }));
  },

  /* ── issues ────────────────────────────────────────────────────── */

  async findIssues(filter, page, sort) {
    const where = issueWhere(filter);
    const [rows, total] = await Promise.all([
      prisma.workIssue.findMany({
        where,
        orderBy: sort === 'severity' ? [{ severity: 'asc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      prisma.workIssue.count({ where }),
    ]);
    return { rows: rows.map(toIssue), total };
  },
  async countIssuesByStatus(filter) {
    const groups = await prisma.workIssue.groupBy({ by: ['status'], where: issueWhere(filter), _count: { _all: true } });
    return fold(groups);
  },
  async findIssue(id) {
    const row = await prisma.workIssue.findUnique({ where: { id } });
    return row ? toIssue(row) : null;
  },
  async createIssue(data) {
    return toIssue(await prisma.workIssue.create({ data }));
  },
  async updateIssue(id, patch) {
    return toIssue(await prisma.workIssue.update({ where: { id }, data: patch }));
  },
  async findOpenIssues(projectId) {
    const rows = await prisma.workIssue.findMany({
      where: {
        status: { in: OPEN_ISSUES },
        ...(projectId ? { OR: [{ projectId }, { task: { projectId } }] } : {}),
      },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 5000,
    });
    return rows.map(toIssue);
  },
};
