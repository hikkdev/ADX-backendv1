/**
 * Reports — Lot G (Q129/Q143).
 *
 * Twelve report kinds defined in code (`catalogue.ts`), rendered on demand
 * as CSV or PDF into a private file, listed as runs, and scheduled daily /
 * weekly / monthly at 06:00 IST with a time-limited link mailed to each
 * recipient. Reads across the other modules' tables through its own
 * repository, read-only; owns `ReportRun` and `ReportSchedule`.
 */
export { reportsRouter } from './reports.routes';

/** For `jobs/report-schedule.job.ts`: every enabled schedule whose time has come. */
export { runDueSchedules } from './reports.service';
export type { DueScheduleOutcome } from './reports.service';

/** The kinds, for anything that wants to name one (a settings screen, a test). */
export { REPORT_KINDS } from './catalogue';
export type { ReportKindName } from './catalogue';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
