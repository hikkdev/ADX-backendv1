/**
 * The feature registry, as this module reads it — Lot G (answers 144-146).
 *
 * The registry itself is `shared/features`: a process-wide Map of
 * `feature(key, {...})` declarations and the pure reads over it. It sits in
 * `shared/` rather than here because every module's `features.ts` calls
 * `feature()`, and a test that mocks this module (ten of them do, to pin
 * `isFeatureEnabled`) must not erase the declarations along with it. This
 * file is the module's door to it, so nothing here names `shared/features`
 * twice and the README can point at one place.
 */
export {
  FEATURE_KEY,
  FEATURE_KINDS,
  FEATURE_SURFACES,
  LEGACY_FLAG_KEYS,
  canonicalKey,
  declaredFeatures,
  feature,
  featureForPath,
  findDeclaration,
  jobCoverage,
  knownAliases,
  routeCoverage,
} from '../../shared/features';
export type { FeatureDeclaration, FeatureKind, FeatureOptions, FeatureSurface } from '../../shared/features';
