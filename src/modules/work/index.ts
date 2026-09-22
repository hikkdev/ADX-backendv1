/**
 * Work — Lot AA: the DR 10 Tasks section on real tables, essentials only
 * (Q70). Projects, tasks, people, reviewers, prerequisites, comments, hours
 * and issues; the overview, the board and a person's own list. Nothing
 * imports this module but bootstrap and the due job: it reads the sibling
 * tables for people and linked records and writes only its own.
 */
export { workRouter } from './work.routes';
/** The daily due sweep (`src/jobs/work-due.job.ts`): due tomorrow and overdue, once per task per day. */
export { sweepDueTasks } from './work.service';
/** LH6: tasks the platform raises on its own (a callback a lead asked for), and their reads and closes by tag. */
export { completeTaggedTasks, createSystemTask, openTaggedTasks } from './work.service';
export type { Actor, Board, Overview, PersonView, ProjectDetail, ProjectView, TaskCard, TaskDetail } from './work.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
