/**
 * The feature fold — Lot G (answer 144).
 *
 * Loads every `src/modules/<module>/features.ts` and `src/bootstrap/features.ts`
 * (each calls `feature()` at import, and imports nothing but `shared/features`),
 * reads the three package manifests beside this package, and folds them into
 * the registry document. Used by scripts/features-sync.ts (the writer) and by
 * tests/architecture/feature-registry.test.ts (the gate that fails when the
 * committed document is behind), so both measure the codebase the same way.
 *
 * A manifest that is not on disk — the backend checked out alone — is
 * skipped and named in `missingManifests`, so the test can say why the
 * comparison was not made rather than fail on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRegistryDocument, declaredFeatures, type FeatureManifest, type ManifestSurface, type RegistryDocument } from '../src/shared/features';
// G11-2: the manifest locations and the reader live with the checker, so
// `npm run features:check` and `GET /flags/registry`'s `check` measure the
// same files the same way.
import { MANIFEST_FILES, readManifests as readManifestFiles } from '../src/modules/feature-flags/registry-check';

export const BACKEND_ROOT = path.resolve(__dirname, '..');
export const REGISTRY_DOCUMENT = path.join(BACKEND_ROOT, 'docs', 'feature-registry.json');

export { MANIFEST_FILES };

/** Every `features.ts` a module or the bootstrap ships, absolute. */
export function featureFiles(): string[] {
  const modules = path.join(BACKEND_ROOT, 'src', 'modules');
  const files = fs
    .readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(modules, entry.name, 'features.ts'))
    .filter((file) => fs.existsSync(file));
  const bootstrap = path.join(BACKEND_ROOT, 'src', 'bootstrap', 'features.ts');
  if (fs.existsSync(bootstrap)) files.push(bootstrap);
  return files.sort();
}

/** Module directories under src/modules that ship no features.ts. */
export function modulesWithoutFeatures(): string[] {
  const modules = path.join(BACKEND_ROOT, 'src', 'modules');
  return fs
    .readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !fs.existsSync(path.join(modules, entry.name, 'features.ts')))
    .map((entry) => entry.name)
    .sort();
}

/** Loads every declaration into the process-wide registry (idempotent: a file already loaded declares nothing twice). */
export async function loadDeclarations(): Promise<void> {
  // A file URL, not a bare path: on Windows an absolute path reads as a `f:` scheme.
  for (const file of featureFiles()) await import(pathToFileURL(file).href);
}

export interface CollectedFeatures {
  document: RegistryDocument;
  manifests: FeatureManifest[];
  missingManifests: string[];
  /** The surfaces the missing manifests would have declared — what the checker marks "not compared". */
  missingSurfaces: ManifestSurface[];
}

/** The manifests on disk. A manifest that does not parse throws here: a typo must fail the sync and the gate, not vanish. */
export function readManifests(): { manifests: FeatureManifest[]; missing: string[]; missingSurfaces: ManifestSurface[] } {
  const read = readManifestFiles();
  const [broken] = read.invalid;
  if (broken) throw new Error(broken.error);
  return { manifests: read.manifests, missing: read.missing, missingSurfaces: read.missingSurfaces };
}

export async function collectFeatures(): Promise<CollectedFeatures> {
  await loadDeclarations();
  const { manifests, missing, missingSurfaces } = readManifests();
  return {
    document: buildRegistryDocument(declaredFeatures(), manifests),
    manifests,
    missingManifests: missing,
    missingSurfaces,
  };
}
