/**
 * Ops — resilience and housekeeping, Lot E (decisions 95/126); system
 * health, Lot G (Q130).
 *
 * Keeps three `AppConfig` rows through `app-config` — the last restore
 * drill, the retention-due report, and which past-due erasure requests the
 * admins have heard about — and, since Lot G, owns the five-minute
 * `HealthSample`, the `Incident` log and the status page's subscribers.
 */
export { opsRouter, statusRouter } from './ops.routes';

/** For `jobs/health-sample.job.ts`: the five-minute probe; and for bootstrap, the Postgres ping it cannot import itself. */
export { sampleHealth, registerPostgresProbe } from './health-sample.service';
export type { HealthProbes, HealthSampleResult } from './health-sample.service';

/** For `jobs/restore-drill.job.ts`: the monthly drill and its real dependencies. */
export { runRestoreDrill, defaultDrillDeps } from './restore-drill.service';
export type { DrillDeps, DrillOutcome, DrillRecord } from './restore-drill.service';

/** For `jobs/retention.job.ts`: the daily sweep. */
export { retentionSweep } from './retention.service';
export type { RetentionSweepResult, RetentionDueReport } from './retention.service';

export { LAST_DRILL_KEY, RETENTION_DUE_KEY, ERASURE_DUE_KEY } from './ops.keys';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
