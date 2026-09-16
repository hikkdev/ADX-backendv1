/**
 * Account lifecycle -- closing an account (Q21) and erasing the person behind
 * it (Q60).
 *
 * Separate from `users` on purpose. A closure review asks eleven questions of
 * nine other modules -- wallets, payouts, orders, campaigns, listings, visits,
 * order-milestones, agreements, support -- and the act itself calls
 * `suspension` and `auth` as well. `users` is imported BY six modules, so
 * giving it those dependencies would close a cycle the first time any of them
 * needed a closure. Here the arrows all point outward and nothing points back.
 *
 * What it owns: `AccountClosureCase`, `ErasureRequest`, `MobileTombstone`, the
 * three closure columns on `User`, and the PII columns an erasure blanks
 * across `User`, `Publisher`, `Advertiser`, `AgentProfile` and the four KYC
 * records. The last two are the `suspension` arrangement -- one act, one
 * writer -- and the reasoning is in the repository header.
 */
export { accountLifecycleRouter } from './account-lifecycle.routes';

/**
 * Called by `users`' deletion guard and by the console: everything standing
 * between this account and closure, as a list of blockers with counts.
 */
export { closureReview } from './closure/closure-review';
export type { Blocker, BlockerKind, ClosureReview, WalletLine } from './closure/closure-review';

/** The act itself, for a caller that already holds the decision. */
export { closeAccount } from './closure/closure.service';
export type { ClosureCaseView, ClosureOutcome, ClosurePayout } from './closure/closure.service';

/**
 * Supplies auth's `MobileTombstonePort` -- whether a number was erased before
 * this registration. Registered from bootstrap/register-modules, because
 * `auth` must not import this module: this one imports `revokeSessions` from
 * it to close an account.
 */
export { wasMobileErased } from './erasure/erasure.service';

/**
 * Lot E: the two reads the daily retention sweep in `ops` makes -- requests
 * past their thirty days, and completed ones past their retention date.
 */
export { erasuresDue, erasuresPastRetention } from './erasure/erasure.service';
export type { ErasureView } from './erasure/erasure.service';

/**
 * G6 (Q104): the data export. `processPendingDataExports` is
 * `jobs/data-export.job.ts`'s tick; `purgeExpiredDataExports` is the read-
 * and-remove the daily retention sweep in `ops` makes — the one destruction
 * it performs, of a copy the person already has.
 */
export { processPendingDataExports, purgeExpiredDataExports, buildDataExport, DATA_EXPORT_TTL_DAYS } from './data-export/data-export.service';
export type { DataExportView } from './data-export/data-export.service';

/**
 * The retention arithmetic, exported because it is the number somebody will be
 * asked to justify years from now and it should be checkable from outside.
 */
export { financialYearEnd, retainUntilFor, hashMobile, DEFAULT_RETENTION_YEARS } from './erasure/retention';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
