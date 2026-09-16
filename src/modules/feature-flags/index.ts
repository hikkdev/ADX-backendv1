/**
 * Feature flags — Lot A (Q31), rebuilt around the registry in Lot G
 * (answers 144-146).
 *
 * The ops surface (/flags), the per-caller evaluation (/app/flags), the
 * kill-switch middleware, and the boot upsert that turns every declaration
 * in the codebase into a row.
 */
export { appFlagsRouter, flagRouter } from './feature-flags.routes';

/** The evaluator. Unknown key -> false; declared-but-unwritten key -> its launch default; 30s cache; deterministic bucket. */
export { isFeatureEnabled, featureAnswer, ensureFeatureRegistry } from './feature-flags.service';
export type { FlagAnswer, FlagState, FlagSubject, Rollout } from './feature-flags.types';

/** 503 FEATURE_OFF { key } when the flag is off for the caller; also declares route coverage for the architecture test. */
export { requireFeature } from './require-feature';
/** G10: the same switch on a route that only sometimes asks for the feature — evaluated when the predicate holds. */
export { requireFeatureWhen } from './require-feature';

/**
 * The registry reads, for scripts and the architecture test. Declaring a
 * feature is `import { feature } from '../../shared/features'` in a module's
 * own `features.ts` — never through this index, so a mocked feature-flags
 * module cannot erase a declaration.
 */
export { declaredFeatures, featureForPath, jobCoverage, knownAliases, canonicalKey } from './registry';

/**
 * G11-2: is `docs/feature-registry.json` behind the code? The one checker
 * `npm run features:check` and `GET /flags/registry`'s `check` share.
 */
export { checkRegistry, compareRegistryDocuments } from './registry-check';
export type { RegistryCheck, SurfaceVerdict } from './registry-check';

/**
 * E6: the name lookup behind `byUser` on the change history. Filled by
 * bootstrap from `users.findUserLabels`; unregistered, names are null.
 */
export { registerFlagUserLabelPort } from './user-labels.port';

/** Lot G (answer 146): the caller's city for a rollout by city. Filled by bootstrap from the three profile reads. */
export { registerFlagSubjectCityPort } from './subject.port';

/** Lot G: what happens after a flag moves — G6 registers the push to the apps here. */
export { registerFlagChangePort } from './flag-change.port';
export type { FlagChangeEvent, FlagChangePort } from './flag-change.port';

// Lot G (answer 144): the module's own feature declaration, loaded with the module.
import './features';
