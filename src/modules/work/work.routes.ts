import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  archiveProjectHandler,
  assigneesHandler,
  boardHandler,
  commentHandler,
  createIssueHandler,
  createProjectHandler,
  createTaskHandler,
  deleteTaskHandler,
  deleteTimeLogHandler,
  getIssueHandler,
  getProjectHandler,
  getTaskHandler,
  listIssuesHandler,
  listProjectsHandler,
  listTasksHandler,
  myCommentHandler,
  myReviewHandler,
  myStatusHandler,
  mySummaryHandler,
  myTaskHandler,
  myTasksHandler,
  myTimeLogHandler,
  overviewHandler,
  patchIssueHandler,
  patchProjectHandler,
  patchTaskHandler,
  peopleHandler,
  prerequisitesHandler,
  reopenIssueHandler,
  resolveIssueHandler,
  reviewHandler,
  reviewersHandler,
  statusHandler,
  timeLogHandler,
  timeLogsHandler,
} from './work.controller';

/**
 * Work — Lot AA. `authenticate` at the router; the `/me` paths are any
 * EMPLOYEE (an ADMIN session) or AGENT session, scoped to the caller's own
 * tasks in the service; everything else is ADMIN + `work.view`, the writes
 * `work.edit`. Approving as an approver is a reviewer's mark, or
 * `work.approve` — checked in the service, because who reviews is a fact
 * of the task, not of the route.
 */
export const workRouter = Router();
workRouter.use(authenticate);

/* ── the person's own list — mounted ahead of the ADMIN guard ──────── */
const meRouter = Router();
meRouter.use(requireRole('ADMIN', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'));
meRouter.get('/tasks', asyncHandler(myTasksHandler));
meRouter.get('/summary', asyncHandler(mySummaryHandler));
meRouter.get('/tasks/:taskId', asyncHandler(myTaskHandler));
meRouter.post('/tasks/:taskId/status', asyncHandler(myStatusHandler));
meRouter.post('/tasks/:taskId/comments', asyncHandler(myCommentHandler));
meRouter.post('/tasks/:taskId/time-logs', asyncHandler(myTimeLogHandler));
meRouter.post('/tasks/:taskId/review', asyncHandler(myReviewHandler));
workRouter.use('/me', meRouter);

/* ── the desk ──────────────────────────────────────────────────────── */
workRouter.use(requireRole('ADMIN'), requirePermission('work.view'));
const edit = requirePermission('work.edit');

workRouter.get('/people', asyncHandler(peopleHandler));
workRouter.get('/overview', asyncHandler(overviewHandler));
workRouter.get('/board', asyncHandler(boardHandler));
workRouter.get('/time-logs', asyncHandler(timeLogsHandler));

workRouter.get('/projects', asyncHandler(listProjectsHandler));
workRouter.post('/projects', edit, asyncHandler(createProjectHandler));
workRouter.get('/projects/:projectId', asyncHandler(getProjectHandler));
workRouter.patch('/projects/:projectId', edit, asyncHandler(patchProjectHandler));
workRouter.post('/projects/:projectId/archive', edit, asyncHandler(archiveProjectHandler));

workRouter.get('/tasks', asyncHandler(listTasksHandler));
workRouter.post('/tasks', edit, asyncHandler(createTaskHandler));
workRouter.get('/tasks/:taskId', asyncHandler(getTaskHandler));
workRouter.patch('/tasks/:taskId', edit, asyncHandler(patchTaskHandler));
workRouter.delete('/tasks/:taskId', edit, asyncHandler(deleteTaskHandler));
workRouter.post('/tasks/:taskId/status', edit, asyncHandler(statusHandler));
workRouter.post('/tasks/:taskId/review', asyncHandler(reviewHandler));
workRouter.put('/tasks/:taskId/assignees', edit, asyncHandler(assigneesHandler));
workRouter.put('/tasks/:taskId/reviewers', edit, asyncHandler(reviewersHandler));
workRouter.put('/tasks/:taskId/prerequisites', edit, asyncHandler(prerequisitesHandler));
workRouter.post('/tasks/:taskId/comments', asyncHandler(commentHandler));
workRouter.post('/tasks/:taskId/time-logs', asyncHandler(timeLogHandler));
workRouter.delete('/tasks/:taskId/time-logs/:logId', asyncHandler(deleteTimeLogHandler));

workRouter.get('/issues', asyncHandler(listIssuesHandler));
workRouter.post('/issues', edit, asyncHandler(createIssueHandler));
workRouter.get('/issues/:issueId', asyncHandler(getIssueHandler));
workRouter.patch('/issues/:issueId', edit, asyncHandler(patchIssueHandler));
workRouter.post('/issues/:issueId/resolve', edit, asyncHandler(resolveIssueHandler));
workRouter.post('/issues/:issueId/reopen', edit, asyncHandler(reopenIssueHandler));
