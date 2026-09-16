import type { Request, Response } from 'express';
import { hasPermission } from '../../shared/auth';
import { ApiError } from '../../shared/errors';
import {
  assigneesSchema,
  boardQuerySchema,
  commentSchema,
  createIssueSchema,
  createProjectSchema,
  createTaskSchema,
  issuesQuerySchema,
  myStatusChangeSchema,
  myTasksQuerySchema,
  overviewQuerySchema,
  patchIssueSchema,
  patchProjectSchema,
  patchTaskSchema,
  peopleQuerySchema,
  prerequisitesSchema,
  projectsQuerySchema,
  resolveIssueSchema,
  reviewSchema,
  reviewersSchema,
  statusChangeSchema,
  tasksQuerySchema,
  timeLogSchema,
  timeLogsQuerySchema,
} from './work.schema';
import {
  addComment,
  archiveProject,
  board,
  changeStatus,
  createIssue,
  createProject,
  createTask,
  deleteTask,
  deleteTimeLog,
  getIssue,
  getProject,
  getTask,
  listIssues,
  listProjects,
  listTasks,
  listTimeLogs,
  logTime,
  myComment,
  myReview,
  myStatusChange,
  mySummary,
  myTask,
  myTasks,
  myTimeLog,
  overview,
  patchIssue,
  patchProject,
  patchTask,
  reopenIssue,
  resolveIssue,
  reviewTask,
  searchPeople,
  selfActor,
  setAssignees,
  setPrerequisites,
  setReviewers,
  type Actor,
} from './work.service';

const parse = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const param = (req: Request, name: string) => req.params[name] as string;
const ok = (res: Response, data: unknown) => res.json({ success: true, data });
const created = (res: Response, data: unknown) => res.status(201).json({ success: true, data });

/** The console's actor: the session, its permissions and the request its audit rows hang off. */
const consoleActor = (req: Request): Actor => ({ userId: req.user!.sub, req, can: (permission) => hasPermission(req.user, permission) });

/* ── people ─────────────────────────────────────────────────────────── */

export async function peopleHandler(req: Request, res: Response): Promise<void> {
  ok(res, await searchPeople(parse(peopleQuerySchema, req.query)));
}

/* ── projects ───────────────────────────────────────────────────────── */

export async function listProjectsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listProjects(parse(projectsQuerySchema, req.query)));
}
export async function createProjectHandler(req: Request, res: Response): Promise<void> {
  created(res, await createProject(parse(createProjectSchema, req.body), consoleActor(req)));
}
export async function getProjectHandler(req: Request, res: Response): Promise<void> {
  ok(res, await getProject(param(req, 'projectId')));
}
export async function patchProjectHandler(req: Request, res: Response): Promise<void> {
  ok(res, await patchProject(param(req, 'projectId'), parse(patchProjectSchema, req.body), consoleActor(req)));
}
export async function archiveProjectHandler(req: Request, res: Response): Promise<void> {
  ok(res, await archiveProject(param(req, 'projectId'), consoleActor(req)));
}

/* ── tasks ──────────────────────────────────────────────────────────── */

export async function listTasksHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listTasks(parse(tasksQuerySchema, req.query)));
}
export async function createTaskHandler(req: Request, res: Response): Promise<void> {
  created(res, await createTask(parse(createTaskSchema, req.body), consoleActor(req)));
}
export async function getTaskHandler(req: Request, res: Response): Promise<void> {
  ok(res, await getTask(param(req, 'taskId')));
}
export async function patchTaskHandler(req: Request, res: Response): Promise<void> {
  ok(res, await patchTask(param(req, 'taskId'), parse(patchTaskSchema, req.body), consoleActor(req)));
}
export async function deleteTaskHandler(req: Request, res: Response): Promise<void> {
  const { deleted } = await deleteTask(param(req, 'taskId'), consoleActor(req));
  if (deleted) res.status(204).end();
  else ok(res, { archived: true });
}
export async function statusHandler(req: Request, res: Response): Promise<void> {
  ok(res, await changeStatus(param(req, 'taskId'), parse(statusChangeSchema, req.body), consoleActor(req)));
}
export async function reviewHandler(req: Request, res: Response): Promise<void> {
  ok(res, await reviewTask(param(req, 'taskId'), parse(reviewSchema, req.body), consoleActor(req)));
}
export async function assigneesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await setAssignees(param(req, 'taskId'), parse(assigneesSchema, req.body).userIds, consoleActor(req)));
}
export async function reviewersHandler(req: Request, res: Response): Promise<void> {
  ok(res, await setReviewers(param(req, 'taskId'), parse(reviewersSchema, req.body).reviewers, consoleActor(req)));
}
export async function prerequisitesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await setPrerequisites(param(req, 'taskId'), parse(prerequisitesSchema, req.body).ids, consoleActor(req)));
}
export async function commentHandler(req: Request, res: Response): Promise<void> {
  created(res, await addComment(param(req, 'taskId'), parse(commentSchema, req.body), consoleActor(req)));
}
export async function timeLogHandler(req: Request, res: Response): Promise<void> {
  created(res, await logTime(param(req, 'taskId'), parse(timeLogSchema, req.body), consoleActor(req)));
}
export async function deleteTimeLogHandler(req: Request, res: Response): Promise<void> {
  await deleteTimeLog(param(req, 'taskId'), param(req, 'logId'), consoleActor(req));
  res.status(204).end();
}
export async function timeLogsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listTimeLogs(parse(timeLogsQuerySchema, req.query)));
}

/* ── issues ─────────────────────────────────────────────────────────── */

export async function listIssuesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listIssues(parse(issuesQuerySchema, req.query)));
}
export async function createIssueHandler(req: Request, res: Response): Promise<void> {
  created(res, await createIssue(parse(createIssueSchema, req.body), consoleActor(req)));
}
export async function getIssueHandler(req: Request, res: Response): Promise<void> {
  ok(res, await getIssue(param(req, 'issueId')));
}
export async function patchIssueHandler(req: Request, res: Response): Promise<void> {
  ok(res, await patchIssue(param(req, 'issueId'), parse(patchIssueSchema, req.body), consoleActor(req)));
}
export async function resolveIssueHandler(req: Request, res: Response): Promise<void> {
  ok(res, await resolveIssue(param(req, 'issueId'), parse(resolveIssueSchema, req.body), consoleActor(req)));
}
export async function reopenIssueHandler(req: Request, res: Response): Promise<void> {
  ok(res, await reopenIssue(param(req, 'issueId'), consoleActor(req)));
}

/* ── overview, board ────────────────────────────────────────────────── */

export async function overviewHandler(req: Request, res: Response): Promise<void> {
  ok(res, await overview(parse(overviewQuerySchema, req.query)));
}
export async function boardHandler(req: Request, res: Response): Promise<void> {
  ok(res, await board(parse(boardQuerySchema, req.query)));
}

/* ── me ─────────────────────────────────────────────────────────────── */

export async function myTasksHandler(req: Request, res: Response): Promise<void> {
  ok(res, await myTasks(req.user!.sub, parse(myTasksQuerySchema, req.query)));
}
export async function mySummaryHandler(req: Request, res: Response): Promise<void> {
  ok(res, await mySummary(req.user!.sub));
}
export async function myTaskHandler(req: Request, res: Response): Promise<void> {
  ok(res, await myTask(param(req, 'taskId'), req.user!.sub));
}
export async function myStatusHandler(req: Request, res: Response): Promise<void> {
  ok(res, await myStatusChange(param(req, 'taskId'), parse(myStatusChangeSchema, req.body), selfActor(req.user!.sub, req)));
}
export async function myCommentHandler(req: Request, res: Response): Promise<void> {
  created(res, await myComment(param(req, 'taskId'), parse(commentSchema, req.body), selfActor(req.user!.sub, req)));
}
export async function myTimeLogHandler(req: Request, res: Response): Promise<void> {
  created(res, await myTimeLog(param(req, 'taskId'), parse(timeLogSchema, req.body), selfActor(req.user!.sub, req)));
}
export async function myReviewHandler(req: Request, res: Response): Promise<void> {
  ok(res, await myReview(param(req, 'taskId'), parse(reviewSchema, req.body), selfActor(req.user!.sub, req)));
}
