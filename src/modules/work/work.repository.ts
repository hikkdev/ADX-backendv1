import type { IssueSeverity, IssueStatus, LinkedKind, PersonKind, Priority, ProjectKind, RecurrenceInput, TaskSort, TaskStatus } from './work.schema';

/**
 * The work module's repository — Lot AA.
 *
 * Plain rows, so the in-memory fake beside the tests is the same contract
 * the Prisma one keeps: Decimals arrive as numbers, JSON as the recurrence
 * shape, and the people and linked-record lookups are reads over the
 * sibling tables (employees, agents, departments, cities, orders …) this
 * module never writes.
 */

export type Recurrence = RecurrenceInput & {
  /** How many copies have been spawned so far, the original counted as 1. */
  occurrence?: number;
};

export type ProjectRow = {
  id: string;
  displayId: string | null;
  name: string;
  description: string | null;
  kind: ProjectKind;
  departmentId: string | null;
  cityId: string | null;
  ownerUserId: string;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectLite = Pick<ProjectRow, 'id' | 'displayId' | 'name' | 'kind'>;

export type NewProject = Omit<ProjectRow, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
export type ProjectPatch = Partial<Pick<ProjectRow, 'name' | 'description' | 'ownerUserId' | 'departmentId' | 'cityId' | 'startsAt' | 'endsAt' | 'status'>>;

export type ProjectFilter = {
  q?: string | undefined;
  statuses?: readonly string[] | undefined;
  kind?: ProjectKind | undefined;
  cityId?: string | undefined;
  departmentId?: string | undefined;
};

export type TaskRow = {
  id: string;
  displayId: string | null;
  projectId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  progress: number;
  startDate: Date | null;
  deadline: Date | null;
  actualStartDate: Date | null;
  revisedEndDate: Date | null;
  completedAt: Date | null;
  effortEstimateH: number | null;
  linkedKind: LinkedKind | null;
  linkedId: string | null;
  recurrence: Recurrence | null;
  tags: string[];
  createdById: string;
  assignedById: string | null;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskLite = Pick<TaskRow, 'id' | 'displayId' | 'title' | 'status' | 'progress' | 'deadline'>;

export type NewTask = Omit<TaskRow, 'id' | 'createdAt' | 'updatedAt' | 'actualStartDate' | 'revisedEndDate' | 'completedAt' | 'blockedReason' | 'progress'> & {
  progress?: number;
};
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'title'
    | 'description'
    | 'priority'
    | 'status'
    | 'progress'
    | 'startDate'
    | 'deadline'
    | 'actualStartDate'
    | 'revisedEndDate'
    | 'completedAt'
    | 'effortEstimateH'
    | 'linkedKind'
    | 'linkedId'
    | 'recurrence'
    | 'tags'
    | 'projectId'
    | 'blockedReason'
    | 'assignedById'
  >
>;

export type AssigneeRow = { taskId: string; userId: string; assignedAt: Date };
export type ReviewerRow = { taskId: string; userId: string; approver: boolean; approvedAt: Date | null; rejectedAt: Date | null; note: string | null };
export type DependencyRow = { taskId: string; prerequisiteId: string };
export type CommentRow = { id: string; taskId: string; authorId: string; body: string; createdAt: Date };
export type TimeLogRow = { id: string; taskId: string; userId: string; forDate: Date; hours: number; billable: boolean; note: string | null; loggedAt: Date };
export type NewTimeLog = Omit<TimeLogRow, 'id' | 'loggedAt'>;
/** A time log as the week read answers it — the task named beside it. */
export type TimeLogWithTask = TimeLogRow & { task: Pick<TaskRow, 'id' | 'displayId' | 'title' | 'projectId'> };

/** A task as the lists read it: the project beside it, the people, the counts. */
export type TaskListRow = TaskRow & {
  project: ProjectLite | null;
  assignees: AssigneeRow[];
  reviewers: ReviewerRow[];
  openIssues: number;
  childCount: number;
};

export type TaskFilter = {
  q?: string | undefined;
  statuses?: readonly TaskStatus[] | undefined;
  priority?: Priority | undefined;
  projectId?: string | undefined;
  assigneeUserId?: string | undefined;
  reviewerUserId?: string | undefined;
  dueFrom?: Date | undefined;
  dueTo?: Date | undefined;
  /** Deadline before this instant and the task not finished. */
  overdueAt?: Date | undefined;
  linkedKind?: LinkedKind | undefined;
  linkedId?: string | undefined;
  parentTaskId?: string | undefined;
  tag?: string | undefined;
  /** Hide ARCHIVED unless the status facet names it — the lists' default. */
  excludeArchived?: boolean | undefined;
};

export type TaskPage = { skip: number; take: number };
export type TaskOrder = { sort: TaskSort; dir: 'asc' | 'desc' };

/** The whole record, for the detail screen. */
export type TaskGraph = {
  task: TaskRow;
  project: ProjectLite | null;
  parent: Pick<TaskRow, 'id' | 'displayId' | 'title'> | null;
  children: TaskLite[];
  assignees: AssigneeRow[];
  reviewers: ReviewerRow[];
  prerequisites: Pick<TaskRow, 'id' | 'displayId' | 'title' | 'status'>[];
  dependents: Pick<TaskRow, 'id' | 'displayId' | 'title' | 'status'>[];
  comments: CommentRow[];
  timeLogs: TimeLogRow[];
  issues: IssueRow[];
};

export type IssueRow = {
  id: string;
  displayId: string | null;
  projectId: string | null;
  taskId: string | null;
  title: string;
  description: string | null;
  severity: IssueSeverity;
  status: IssueStatus;
  raisedById: string;
  assigneeId: string | null;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type NewIssue = Omit<IssueRow, 'id' | 'status' | 'resolution' | 'resolvedAt' | 'createdAt' | 'updatedAt'>;
export type IssuePatch = Partial<Pick<IssueRow, 'title' | 'description' | 'severity' | 'status' | 'assigneeId' | 'resolution' | 'resolvedAt'>>;
export type IssueFilter = {
  q?: string | undefined;
  statuses?: readonly IssueStatus[] | undefined;
  severity?: IssueSeverity | undefined;
  projectId?: string | undefined;
  taskId?: string | undefined;
  assigneeId?: string | undefined;
};

export type TimeLogFilter = {
  userId?: string | undefined;
  taskId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  projectId?: string | undefined;
};

/** A person as the sibling tables know them — employees first, then agents. */
export type PersonRow = {
  userId: string;
  name: string | null;
  kind: PersonKind;
  /** The designation, or "Field agent". */
  role: string;
  departmentName: string | null;
  active: boolean;
};

export interface WorkRepository {
  /* people and references, read over the sibling tables */
  findPeople(userIds: readonly string[]): Promise<PersonRow[]>;
  searchPeople(q: string | undefined, kind: PersonKind | undefined, limit: number): Promise<PersonRow[]>;
  findDepartment(id: string): Promise<{ id: string; name: string } | null>;
  findCity(id: string): Promise<{ id: string; name: string } | null>;
  /** The display name of the row a task is linked to, or null when there is no such row. */
  linkedLabel(kind: LinkedKind, id: string): Promise<string | null>;

  /* projects */
  findProjects(filter: ProjectFilter, page: TaskPage, sort: 'newest' | 'name'): Promise<{ rows: ProjectRow[]; total: number }>;
  countProjectsByStatus(filter: ProjectFilter): Promise<Record<string, number>>;
  findProject(id: string): Promise<ProjectRow | null>;
  createProject(data: NewProject): Promise<ProjectRow>;
  updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow>;

  /* tasks */
  findTasks(filter: TaskFilter, page: TaskPage, order: TaskOrder): Promise<{ rows: TaskListRow[]; total: number }>;
  countTasksByStatus(filter: TaskFilter): Promise<Record<string, number>>;
  findTask(id: string): Promise<TaskRow | null>;
  findTaskGraph(id: string): Promise<TaskGraph | null>;
  createTask(data: NewTask): Promise<TaskRow>;
  updateTask(id: string, patch: TaskPatch): Promise<TaskRow>;
  deleteTask(id: string): Promise<void>;
  findChildren(parentTaskId: string): Promise<TaskRow[]>;

  findAssignees(taskId: string): Promise<AssigneeRow[]>;
  setAssignees(taskId: string, userIds: readonly string[], at: Date): Promise<AssigneeRow[]>;
  findReviewers(taskId: string): Promise<ReviewerRow[]>;
  setReviewers(taskId: string, reviewers: readonly { userId: string; approver: boolean }[]): Promise<ReviewerRow[]>;
  updateReviewer(taskId: string, userId: string, patch: Partial<Pick<ReviewerRow, 'approvedAt' | 'rejectedAt' | 'note'>>): Promise<ReviewerRow>;
  /** `{ taskId, prerequisiteId }` edges where `taskId` is one of the ids given — one step up the graph. */
  findPrerequisiteEdges(taskIds: readonly string[]): Promise<DependencyRow[]>;
  findPrerequisites(taskId: string): Promise<Pick<TaskRow, 'id' | 'displayId' | 'title' | 'status'>[]>;
  setPrerequisites(taskId: string, prerequisiteIds: readonly string[]): Promise<void>;

  createComment(data: Omit<CommentRow, 'id' | 'createdAt'>): Promise<CommentRow>;
  createTimeLog(data: NewTimeLog): Promise<TimeLogRow>;
  findTimeLog(id: string): Promise<TimeLogRow | null>;
  deleteTimeLog(id: string): Promise<void>;
  findTimeLogs(filter: TimeLogFilter): Promise<TimeLogWithTask[]>;

  /* issues */
  findIssues(filter: IssueFilter, page: TaskPage, sort: 'newest' | 'severity'): Promise<{ rows: IssueRow[]; total: number }>;
  countIssuesByStatus(filter: IssueFilter): Promise<Record<string, number>>;
  findIssue(id: string): Promise<IssueRow | null>;
  createIssue(data: NewIssue): Promise<IssueRow>;
  updateIssue(id: string, patch: IssuePatch): Promise<IssueRow>;
  /** Every open issue on the project or on any task — for the overview. */
  findOpenIssues(projectId: string | undefined): Promise<IssueRow[]>;
}
