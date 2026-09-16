/**
 * The feature registry (Lot G, answers 144-146): `feature(key, {...})`, the
 * pure reads over what was declared, and the manifest fold. Every module's
 * `features.ts` imports from here; `modules/feature-flags` is what turns the
 * declarations into `FeatureFlag` rows and answers for them.
 */
export * from './registry';
export * from './manifest';
