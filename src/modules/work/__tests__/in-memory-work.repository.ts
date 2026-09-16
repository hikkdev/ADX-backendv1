import type {
  AssigneeRow,
  CommentRow,
  DependencyRow,
  IssueFilter,
  IssuePatch,
  IssueRow,
  NewIssue,
  NewProject,
  NewTask,
  NewTimeLog,
  PersonRow,
  ProjectFilter,
  ProjectPatch,
  ProjectRow,
  ReviewerRow,
  TaskFilter,
  TaskGraph,
  TaskListRow,
  TaskOrder,
  TaskPage,
  TaskPatch,
  TaskRow,
  TimeLogFilter,
  TimeLogRow,
  TimeLogWithTask,
  WorkRepository,
} from '../work.repository';
import { FINISHED_STATUSES, OPEN_ISSUE_STATUSES, type LinkedKind, type PersonKind } from '../work.schema';

/**
 * The `WorkRepository` over arrays — the same contract the Prisma one keeps
 * (the filters, the sorts, the page, the counts), so the rules are pinned
 * without a database. `people` and `linked` are what the sibling tables
 * would say; a test seeds them.
 */
export class InMemoryWorkRepository implements WorkRepository {
  projects: ProjectRow[] = [];
  tasks: TaskRow[] = [];
  assignees: AssigneeRow[] = [];
  reviewers: ReviewerRow[] = [];
  dependencies: DependencyRow[] = [];
  comments: CommentRow[] = [];
  timeLogs: TimeLogRow[] = [];
  issues: IssueRow[] = [];
  people: PersonRow[] = [];
  departments: { id: string; name: string }[] = [];
  cities: { id: string; name: string }[] = [];
  linked = new Map<string, string>();
  clock = new Date('2026-09-15T06:00:00.000Z');
  private seq = 0;

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  person(row: Partial<PersonRow> & { userId: string }): PersonRow {
    const person: PersonRow = { name: row.userId, kind: 'EMPLOYEE', role: 'Ops', departmentName: null, active: true, ...row };
    this.people.push(person);
    return person;
  }

  /* ── people and references ─────────────────────────────────────── */

  async findPeople(userIds: readonly string[]): Promise<PersonRow[]> {
    return this.people.filter((p) => userIds.includes(p.userId));
  }
  async searchPeople(q: string | undefined, kind: PersonKind | undefined, limit: number): Promise<PersonRow[]> {
    return this.people
      .filter((p) => p.active && (!kind || p.kind === kind) && (!q || (p.name ?? '').toLowerCase().includes(q.toLowerCase()) || p.role.toLowerCase().includes(q.toLowerCase())))
      .slice(0, limit);
  }
  async findDepartment(id: string) {
    return this.departments.find((d) => d.id === id) ?? null;
  }
  async findCity(id: string) {
    return this.cities.find((c) => c.id === id) ?? null;
  }
  async linkedLabel(kind: LinkedKind, id: string): Promise<string | null> {
    return this.linked.get(`${kind}:${id}`) ?? null;
  }

  /* ── projects ──────────────────────────────────────────────────── */

  private projectMatches(filter: ProjectFilter) {
    return (p: ProjectRow) =>
      (!filter.statuses || filter.statuses.includes(p.status)) &&
      (!filter.kind || p.kind === filter.kind) &&
      (!filter.cityId || p.cityId === filter.cityId) &&
      (!filter.departmentId || p.departmentId === filter.departmentId) &&
      (!filter.q || p.name.toLowerCase().includes(filter.q.toLowerCase()) || (p.displayId ?? '').toLowerCase().includes(filter.q.toLowerCase()));
  }
  async findProjects(filter: ProjectFilter, page: TaskPage, sort: 'newest' | 'name') {
    const rows = this.projects.filter(this.projectMatches(filter)).sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.createdAt.getTime() - a.createdAt.getTime()));
    return { rows: rows.slice(page.skip, page.skip + page.take), total: rows.length };
  }
  async countProjectsByStatus(filter: ProjectFilter) {
    const out: Record<string, number> = {};
    for (const p of this.projects.filter(this.projectMatches(filter))) out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  }
  private copy<T extends object>(row: T | undefined): T | null {
    return row ? { ...row } : null;
  }
  async findProject(id: string) {
    return this.copy(this.projects.find((p) => p.id === id));
  }
  async createProject(data: NewProject): Promise<ProjectRow> {
    const row: ProjectRow = { id: this.id('prj'), status: 'ACTIVE', createdAt: this.clock, updatedAt: this.clock, ...data };
    this.projects.push(row);
    return row;
  }
  async updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow> {
    const row = this.projects.find((p) => p.id === id)!;
    Object.assign(row, patch, { updatedAt: this.clock });
    return { ...row };
  }

  /* ── tasks ─────────────────────────────────────────────────────── */

  private taskMatches(filter: TaskFilter) {
    return (t: TaskRow) => {
      if (filter.statuses) {
        if (!filter.statuses.includes(t.status)) return false;
      } else if (filter.excludeArchived && t.status === 'ARCHIVED') return false;
      if (filter.priority && t.priority !== filter.priority) return false;
      if (filter.projectId && t.projectId !== filter.projectId) return false;
      if (filter.parentTaskId && t.parentTaskId !== filter.parentTaskId) return false;
      if (filter.linkedKind && t.linkedKind !== filter.linkedKind) return false;
      if (filter.linkedId && t.linkedId !== filter.linkedId) return false;
      if (filter.tag && !t.tags.includes(filter.tag)) return false;
      if (filter.assigneeUserId && !this.assignees.some((a) => a.taskId === t.id && a.userId === filter.assigneeUserId)) return false;
      if (filter.reviewerUserId && !this.reviewers.some((r) => r.taskId === t.id && r.userId === filter.reviewerUserId)) return false;
      if (filter.q) {
        const q = filter.q.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !(t.displayId ?? '').toLowerCase().includes(q)) return false;
      }
      if (filter.dueFrom && (!t.deadline || t.deadline.getTime() < filter.dueFrom.getTime())) return false;
      if (filter.dueTo && (!t.deadline || t.deadline.getTime() > filter.dueTo.getTime())) return false;
      if (filter.overdueAt && (!t.deadline || t.deadline.getTime() >= filter.overdueAt.getTime() || (FINISHED_STATUSES as readonly string[]).includes(t.status))) return false;
      return true;
    };
  }
  private order(order: TaskOrder) {
    const sign = order.dir === 'asc' ? 1 : -1;
    const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (a: TaskRow, b: TaskRow): number => {
      switch (order.sort) {
        case 'DEADLINE': {
          if (a.deadline === null && b.deadline === null) return b.createdAt.getTime() - a.createdAt.getTime();
          if (a.deadline === null) return 1;
          if (b.deadline === null) return -1;
          return sign * (a.deadline.getTime() - b.deadline.getTime());
        }
        case 'PRIORITY':
          return sign * (rank[a.priority]! - rank[b.priority]!) || (a.deadline?.getTime() ?? Infinity) - (b.deadline?.getTime() ?? Infinity);
        case 'CREATED':
          return sign * (a.createdAt.getTime() - b.createdAt.getTime());
        default:
          return sign * (a.updatedAt.getTime() - b.updatedAt.getTime()) || sign * (this.tasks.indexOf(a) - this.tasks.indexOf(b));
      }
    };
  }
  private listRow(t: TaskRow): TaskListRow {
    const project = t.projectId ? this.projects.find((p) => p.id === t.projectId) : null;
    return {
      ...t,
      project: project ? { id: project.id, displayId: project.displayId, name: project.name, kind: project.kind } : null,
      assignees: this.assignees.filter((a) => a.taskId === t.id),
      reviewers: this.reviewers.filter((r) => r.taskId === t.id),
      openIssues: this.issues.filter((i) => i.taskId === t.id && (OPEN_ISSUE_STATUSES as readonly string[]).includes(i.status)).length,
      childCount: this.tasks.filter((c) => c.parentTaskId === t.id).length,
    };
  }
  async findTasks(filter: TaskFilter, page: TaskPage, order: TaskOrder) {
    const rows = this.tasks.filter(this.taskMatches(filter)).sort(this.order(order));
    return { rows: rows.slice(page.skip, page.skip + page.take).map((t) => this.listRow(t)), total: rows.length };
  }
  async countTasksByStatus(filter: TaskFilter) {
    const out: Record<string, number> = {};
    for (const t of this.tasks.filter(this.taskMatches(filter))) out[t.status] = (out[t.status] ?? 0) + 1;
    return out;
  }
  async findTask(id: string) {
    return this.copy(this.tasks.find((t) => t.id === id));
  }
  private ref(id: string) {
    const t = this.tasks.find((x) => x.id === id)!;
    return { id: t.id, displayId: t.displayId, title: t.title, status: t.status };
  }
  async findTaskGraph(id: string): Promise<TaskGraph | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    const project = task.projectId ? this.projects.find((p) => p.id === task.projectId) : null;
    const parent = task.parentTaskId ? this.tasks.find((p) => p.id === task.parentTaskId) : null;
    return {
      task,
      project: project ? { id: project.id, displayId: project.displayId, name: project.name, kind: project.kind } : null,
      parent: parent ? { id: parent.id, displayId: parent.displayId, title: parent.title } : null,
      children: this.tasks.filter((c) => c.parentTaskId === id).map((c) => ({ id: c.id, displayId: c.displayId, title: c.title, status: c.status, progress: c.progress, deadline: c.deadline })),
      assignees: this.assignees.filter((a) => a.taskId === id),
      reviewers: this.reviewers.filter((r) => r.taskId === id),
      prerequisites: this.dependencies.filter((d) => d.taskId === id).map((d) => this.ref(d.prerequisiteId)),
      dependents: this.dependencies.filter((d) => d.prerequisiteId === id).map((d) => this.ref(d.taskId)),
      comments: this.comments.filter((c) => c.taskId === id),
      timeLogs: this.timeLogs.filter((l) => l.taskId === id),
      issues: this.issues.filter((i) => i.taskId === id),
    };
  }
  async createTask(data: NewTask): Promise<TaskRow> {
    const row: TaskRow = {
      id: this.id('tsk'),
      progress: 0,
      actualStartDate: null,
      revisedEndDate: null,
      completedAt: null,
      blockedReason: null,
      createdAt: this.clock,
      updatedAt: this.clock,
      ...data,
    };
    this.tasks.push(row);
    return row;
  }
  async updateTask(id: string, patch: TaskPatch): Promise<TaskRow> {
    const row = this.tasks.find((t) => t.id === id)!;
    Object.assign(row, patch, { updatedAt: this.clock });
    return { ...row };
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.assignees = this.assignees.filter((a) => a.taskId !== id);
    this.reviewers = this.reviewers.filter((r) => r.taskId !== id);
    this.dependencies = this.dependencies.filter((d) => d.taskId !== id && d.prerequisiteId !== id);
  }
  async findChildren(parentTaskId: string) {
    return this.tasks.filter((t) => t.parentTaskId === parentTaskId);
  }

  async findAssignees(taskId: string) {
    return this.assignees.filter((a) => a.taskId === taskId);
  }
  async setAssignees(taskId: string, userIds: readonly string[], at: Date) {
    const kept = this.assignees.filter((a) => a.taskId === taskId && userIds.includes(a.userId));
    const fresh = userIds.filter((u) => !kept.some((a) => a.userId === u)).map((userId) => ({ taskId, userId, assignedAt: at }));
    this.assignees = [...this.assignees.filter((a) => a.taskId !== taskId), ...kept, ...fresh];
    return this.assignees.filter((a) => a.taskId === taskId);
  }
  async findReviewers(taskId: string) {
    return this.reviewers.filter((r) => r.taskId === taskId);
  }
  async setReviewers(taskId: string, reviewers: readonly { userId: string; approver: boolean }[]) {
    const kept = this.reviewers.filter((r) => r.taskId === taskId && reviewers.some((x) => x.userId === r.userId));
    for (const r of kept) r.approver = reviewers.find((x) => x.userId === r.userId)!.approver;
    const fresh = reviewers.filter((x) => !kept.some((r) => r.userId === x.userId)).map((x) => ({ taskId, userId: x.userId, approver: x.approver, approvedAt: null, rejectedAt: null, note: null }));
    this.reviewers = [...this.reviewers.filter((r) => r.taskId !== taskId), ...kept, ...fresh];
    return this.reviewers.filter((r) => r.taskId === taskId);
  }
  async updateReviewer(taskId: string, userId: string, patch: Partial<Pick<ReviewerRow, 'approvedAt' | 'rejectedAt' | 'note'>>) {
    const row = this.reviewers.find((r) => r.taskId === taskId && r.userId === userId)!;
    Object.assign(row, patch);
    return row;
  }
  async findPrerequisiteEdges(taskIds: readonly string[]) {
    return this.dependencies.filter((d) => taskIds.includes(d.taskId));
  }
  async findPrerequisites(taskId: string) {
    return this.dependencies.filter((d) => d.taskId === taskId).map((d) => this.ref(d.prerequisiteId));
  }
  async setPrerequisites(taskId: string, prerequisiteIds: readonly string[]) {
    this.dependencies = [...this.dependencies.filter((d) => d.taskId !== taskId), ...prerequisiteIds.map((prerequisiteId) => ({ taskId, prerequisiteId }))];
  }

  async createComment(data: Omit<CommentRow, 'id' | 'createdAt'>) {
    const row: CommentRow = { id: this.id('cmt'), createdAt: this.clock, ...data };
    this.comments.push(row);
    return row;
  }
  async createTimeLog(data: NewTimeLog) {
    const row: TimeLogRow = { id: this.id('log'), loggedAt: this.clock, ...data };
    this.timeLogs.push(row);
    return row;
  }
  async findTimeLog(id: string) {
    return this.timeLogs.find((l) => l.id === id) ?? null;
  }
  async deleteTimeLog(id: string) {
    this.timeLogs = this.timeLogs.filter((l) => l.id !== id);
  }
  async findTimeLogs(filter: TimeLogFilter): Promise<TimeLogWithTask[]> {
    return this.timeLogs
      .filter((l) => {
        const task = this.tasks.find((t) => t.id === l.taskId)!;
        return (
          (!filter.userId || l.userId === filter.userId) &&
          (!filter.taskId || l.taskId === filter.taskId) &&
          (!filter.from || l.forDate.getTime() >= filter.from.getTime()) &&
          (!filter.to || l.forDate.getTime() <= filter.to.getTime()) &&
          (!filter.projectId || task.projectId === filter.projectId)
        );
      })
      .sort((a, b) => b.forDate.getTime() - a.forDate.getTime() || b.loggedAt.getTime() - a.loggedAt.getTime())
      .map((l) => {
        const task = this.tasks.find((t) => t.id === l.taskId)!;
        return { ...l, task: { id: task.id, displayId: task.displayId, title: task.title, projectId: task.projectId } };
      });
  }

  /* ── issues ────────────────────────────────────────────────────── */

  private issueMatches(filter: IssueFilter) {
    return (i: IssueRow) =>
      (!filter.statuses || filter.statuses.includes(i.status)) &&
      (!filter.severity || i.severity === filter.severity) &&
      (!filter.projectId || i.projectId === filter.projectId) &&
      (!filter.taskId || i.taskId === filter.taskId) &&
      (!filter.assigneeId || i.assigneeId === filter.assigneeId) &&
      (!filter.q || i.title.toLowerCase().includes(filter.q.toLowerCase()) || (i.displayId ?? '').toLowerCase().includes(filter.q.toLowerCase()));
  }
  async findIssues(filter: IssueFilter, page: TaskPage, sort: 'newest' | 'severity') {
    const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const rows = this.issues
      .filter(this.issueMatches(filter))
      .sort((a, b) => (sort === 'severity' ? rank[a.severity]! - rank[b.severity]! : 0) || b.createdAt.getTime() - a.createdAt.getTime());
    return { rows: rows.slice(page.skip, page.skip + page.take), total: rows.length };
  }
  async countIssuesByStatus(filter: IssueFilter) {
    const out: Record<string, number> = {};
    for (const i of this.issues.filter(this.issueMatches(filter))) out[i.status] = (out[i.status] ?? 0) + 1;
    return out;
  }
  async findIssue(id: string) {
    return this.copy(this.issues.find((i) => i.id === id));
  }
  async createIssue(data: NewIssue): Promise<IssueRow> {
    const row: IssueRow = { id: this.id('iss'), status: 'OPEN', resolution: null, resolvedAt: null, createdAt: this.clock, updatedAt: this.clock, ...data };
    this.issues.push(row);
    return row;
  }
  async updateIssue(id: string, patch: IssuePatch): Promise<IssueRow> {
    const row = this.issues.find((i) => i.id === id)!;
    Object.assign(row, patch, { updatedAt: this.clock });
    return { ...row };
  }
  async findOpenIssues(projectId: string | undefined) {
    return this.issues.filter((i) => {
      if (!(OPEN_ISSUE_STATUSES as readonly string[]).includes(i.status)) return false;
      if (!projectId) return true;
      const task = i.taskId ? this.tasks.find((t) => t.id === i.taskId) : null;
      return i.projectId === projectId || task?.projectId === projectId;
    });
  }
}
