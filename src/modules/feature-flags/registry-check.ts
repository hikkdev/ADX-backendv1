import fs from 'node:fs';
import path from 'node:path';
import {
  FEATURE_SURFACES,
  buildRegistryDocument,
  declaredFeatures,
  parseManifest,
  type FeatureDeclaration,
  type FeatureManifest,
  type FeatureSurface,
  type ManifestSurface,
  type RegistryDocument,
  type RegistryEntry,
} from '../../shared/features';

/**
 * Is `docs/feature-registry.json` current? — G11-2.
 *
 * One checker, two callers: `npm run features:check` (scripts/features-sync.ts
 * with `--check`) and `GET /flags/registry`, whose `check` field carries the
 * same verdict so the console can say "the committed registry is behind the
 * code" without anyone opening a terminal. Both compare the committed
 * document against a fresh fold of the backend declarations and the three
 * package manifests — the script after loading every `features.ts`, the
 * read over the declarations the running process already loaded.
 *
 * The verdict is per surface, because the fix is per surface: a BACKEND
 * drift means a module's `features.ts` changed and nobody re-ran the sync;
 * a CONSOLE drift means the console's manifest moved. Each surface is
 * compared on the fields that surface contributes — the backend's routes,
 * jobs, kind, owner, launch and description; a manifest's paths and, for a
 * feature only that manifest knows, its metadata — so a manifest that is
 * not on disk (the backend checked out alone) leaves the other surfaces'
 * verdicts intact and its own marked "not compared", the way the
 * architecture test treats it, rather than reporting every feature behind.
 *
 * No Prisma, no cache: the document is a file and the declarations are a
 * Map. Reading three small manifests per request is cheaper than caching
 * a verdict that must change the moment somebody edits a file.
 */

/** The package root — one level above `src/`, beside `docs/`; found from this file so `dist/` resolves the same. */
export const PACKAGE_ROOT = path.resolve(__dirname, '../../..');

/** Where each surface's manifest lives, relative to the monorepo root. */
export const MANIFEST_FILES: Readonly<Record<Exclude<ManifestSurface, 'WEBSITE'>, string>> = {
  CONSOLE: path.resolve(PACKAGE_ROOT, '..', 'adx-adminUI-sai', 'features.manifest.json'),
  APP_USER: path.resolve(PACKAGE_ROOT, '..', 'mobile', 'user-app', 'features.manifest.json'),
  APP_AGENT: path.resolve(PACKAGE_ROOT, '..', 'mobile', 'agent-app', 'features.manifest.json'),
};

export interface ManifestRead {
  manifests: FeatureManifest[];
  /** Files not on disk, absolute. */
  missing: string[];
  /** The surfaces those files would have declared. */
  missingSurfaces: ManifestSurface[];
  /** Files on disk that did not parse — a hand-written manifest with a typo. */
  invalid: { surface: ManifestSurface; file: string; error: string }[];
}

/** Reads the three package manifests. Never throws: what could not be read is named in `missing` / `invalid`. */
export function readManifests(): ManifestRead {
  const out: ManifestRead = { manifests: [], missing: [], missingSurfaces: [], invalid: [] };
  for (const [surface, file] of Object.entries(MANIFEST_FILES) as [ManifestSurface, string][]) {
    if (!fs.existsSync(file)) {
      out.missing.push(file);
      out.missingSurfaces.push(surface);
      continue;
    }
    try {
      const manifest = parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')), path.relative(PACKAGE_ROOT, file));
      if (manifest.surface !== surface) throw new Error(`${file}: surface is ${manifest.surface}, expected ${surface}`);
      out.manifests.push(manifest);
    } catch (err) {
      out.invalid.push({ surface, file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export interface SurfaceVerdict {
  surface: FeatureSurface;
  behind: boolean;
  /** Why, one line each — empty when the surface is current. A surface that could not be compared says so here with `behind: false`. */
  reasons: string[];
}

export interface RegistryCheck {
  /** No surface is behind. */
  current: boolean;
  surfaces: SurfaceVerdict[];
}

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

/**
 * The slice of an entry one surface answers for, or null when the entry is
 * not on that surface. `strict` widens the BACKEND slice to the merged
 * columns (surfaces, variants) that a missing manifest would otherwise
 * make look different.
 */
function slice(entry: RegistryEntry, surface: FeatureSurface, strict: boolean): Record<string, unknown> | null {
  if (surface === 'BACKEND') {
    if (!entry.declaredIn.includes('backend')) return null;
    return {
      kind: entry.kind,
      owner: entry.owner,
      launch: entry.launch,
      description: entry.description,
      aliases: sorted(entry.aliases),
      routes: sorted(entry.routes),
      jobs: sorted(entry.jobs),
      ...(strict ? { surfaces: sorted(entry.surfaces), variants: sorted(entry.variants) } : {}),
    };
  }
  if (!entry.surfaces.includes(surface)) return null;
  const manifestOnly = !entry.declaredIn.includes('backend');
  return {
    declared: entry.declaredIn.includes(surface),
    paths: sorted(entry.paths[surface]),
    ...(manifestOnly
      ? { kind: entry.kind, owner: entry.owner, launch: entry.launch, description: entry.description, variants: sorted(entry.variants) }
      : {}),
  };
}

function differingFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field])).sort();
}

/**
 * The verdict, pure: the committed document against a fresh fold. A
 * surface whose manifest is missing is reported not compared; one whose
 * manifest did not parse is behind, because the sync could not run either.
 */
export function compareRegistryDocuments(
  committed: RegistryDocument | null,
  fresh: RegistryDocument,
  options: { missingSurfaces?: readonly ManifestSurface[]; invalid?: readonly { surface: ManifestSurface; error: string }[] } = {},
): RegistryCheck {
  const missing = new Set<string>(options.missingSurfaces ?? []);
  const invalid = new Map<string, string>((options.invalid ?? []).map((entry) => [entry.surface, entry.error]));
  const strict = missing.size === 0 && invalid.size === 0;
  const surfaces: SurfaceVerdict[] = FEATURE_SURFACES.map((surface) => {
    const reasons: string[] = [];
    const broken = invalid.get(surface);
    if (broken) return { surface, behind: true, reasons: [`the ${surface} manifest could not be read: ${broken}`] };
    if (missing.has(surface)) return { surface, behind: false, reasons: [`the ${surface} manifest is not on disk; not compared`] };
    if (!committed) return { surface, behind: true, reasons: ['docs/feature-registry.json is missing or unreadable — run npm run features:sync'] };

    const before = new Map<string, Record<string, unknown>>();
    for (const entry of committed.features) {
      const view = slice(entry, surface, strict);
      if (view) before.set(entry.key, view);
    }
    const after = new Map<string, Record<string, unknown>>();
    for (const entry of fresh.features) {
      const view = slice(entry, surface, strict);
      if (view) after.set(entry.key, view);
    }
    for (const [key, next] of after) {
      const previous = before.get(key);
      if (!previous) {
        reasons.push(`${key} is in the code but not in the document`);
        continue;
      }
      const fields = differingFields(previous, next);
      if (fields.length > 0) reasons.push(`${key} differs (${fields.join(', ')})`);
    }
    for (const key of before.keys()) {
      if (!after.has(key)) reasons.push(`${key} is in the document but no longer in the code`);
    }
    reasons.sort();
    return { surface, behind: reasons.length > 0, reasons };
  });
  return { current: surfaces.every((verdict) => !verdict.behind), surfaces };
}

/**
 * The runtime read: the committed document (handed in — `registry-file`
 * caches it) against the declarations this process loaded and the
 * manifests on disk. What `GET /flags/registry` carries as `check`.
 */
export function checkRegistry(committed: RegistryDocument | null, declarations: readonly FeatureDeclaration[] = declaredFeatures()): RegistryCheck {
  const read = readManifests();
  // A manifest that names a key the backend no longer declares, without
  // the metadata a manifest-only feature must carry, cannot be folded: that
  // is that surface behind, not a 500 on the read.
  const foldable: FeatureManifest[] = [];
  const invalid = [...read.invalid];
  for (const manifest of read.manifests) {
    try {
      buildRegistryDocument(declarations, [manifest]);
      foldable.push(manifest);
    } catch (err) {
      invalid.push({ surface: manifest.surface, file: MANIFEST_FILES[manifest.surface as keyof typeof MANIFEST_FILES] ?? '', error: err instanceof Error ? err.message : String(err) });
    }
  }
  const fresh = buildRegistryDocument(declarations, foldable);
  return compareRegistryDocuments(committed, fresh, { missingSurfaces: read.missingSurfaces, invalid });
}
