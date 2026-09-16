/**
 * Fraud — Lot D (Q54/Q92/Q121): fraud as a case object. A case names a party,
 * gathers notes and evidence, and ends in a decision that applies (or lifts)
 * suspension scopes through the `suspension` module. Mounted at `/fraud`.
 */
export { fraudRouter } from './fraud.routes';

/**
 * Used by `disputes`: the open case citing a dispute, for the case card's
 * "Open fraud case" line. Read-only; disputes never writes a fraud case.
 */
export { findOpenFraudCasesForDisputes } from './fraud.service';
export type { OpenFraudCaseRef } from './fraud.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

/** Lot G (Q118/138): the nightly signal scan — `jobs/fraud-signal-scan.job.ts` runs it under the system user. */
export { runSignalScan } from './fraud-signals.service';
export type { ScanReport } from './fraud-signals.service';

/** G10: bootstrap registers the sharp decoder so DUPLICATE_LISTING_PHOTOS computes. */
export { installThumbnailDecoder } from './signals/thumbnail-decoder';
