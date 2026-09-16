import { feature } from '../../shared/features';

/**
 * Features of `work` — Lot AA (Q70 "PMO: minimal, essentials only", and
 * the owner's "there was a Tasks section in DR 10 — where is it?").
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so `work.tasks` on the root is the safety net.
 */

feature('work.projects', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description: "A department's or a city's project: the frame a set of tasks and issues sit in, with counts and an archive.",
  routes: ['/api/v1/work/projects'],
});

feature('work.tasks', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The DR 10 Tasks section on real tables: tasks with sub-tasks, people, reviewers, prerequisites, comments and hours; the status rules, the board, the overview and the daily due notices.',
  routes: ['/api/v1/work'],
  jobs: ['work-due'],
});

feature('work.issues', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description: 'Issues raised on a project or a task, by severity; an OPEN CRITICAL one flags the task as blocked on read.',
  routes: ['/api/v1/work/issues'],
});

feature('work.my-tasks', {
  surfaces: ['CONSOLE', 'APP_AGENT'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description: "A person's own tasks — assigned or reviewing — with their own moves: start, submit for review, block with a reason, comment, log hours, review.",
  routes: ['/api/v1/work/me'],
});
