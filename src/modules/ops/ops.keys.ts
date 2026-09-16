/**
 * The `AppConfig` rows this module keeps — Lot E. Read and written through
 * `app-config`'s `getConfigObject` / `saveConfigObject`, never directly.
 */

/** The last restore drill: when, which dump, whether the ledger verified. */
export const LAST_DRILL_KEY = 'ops:last-drill';
/** The erased people whose financial rows have outlived their retention — a report, never an action. */
export const RETENTION_DUE_KEY = 'ops:retention-due';
/** Which past-due erasure requests the admins have already been told about. */
export const ERASURE_DUE_KEY = 'ops:erasure-due';

/** How ops are told — every ADMIN account until a rota exists (decision 95). */
export const OPS_NOTIFICATION_TYPE = 'SYSTEM' as const;
