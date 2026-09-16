import {
  FEATURE_KEY,
  FEATURE_KINDS,
  FEATURE_LAUNCHES,
  FEATURE_SURFACES,
  type FeatureDeclaration,
  type FeatureKind,
  type FeatureLaunch,
  type FeatureSurface,
} from './registry';

/**
 * The surfaces the backend cannot see at runtime — Lot G (answer 144).
 *
 * The console and the two apps each ship a `features.manifest.json` at their
 * package root. `scripts/features-sync.ts` folds the three manifests and the
 * backend declarations into `docs/feature-registry.json`, which is committed
 * and read back at boot (`ensureFeatureRegistry`) and by
 * `GET /flags/registry`. Pure parsing here — no file system — so the sync
 * script, the boot loader and the architecture test all read a manifest the
 * same way.
 *
 * A manifest entry keyed on a feature the backend also declares only has to
 * name its `paths`: the kind, owner, launch and description come from the
 * declaration, and the surface is added to it. An entry for a feature the
 * backend does not know (a console-only screen, a website page) must carry
 * all four, because it is the only place they are written.
 */

/** Which manifest a surface's package ships. */
export const MANIFEST_SURFACES = ['CONSOLE', 'APP_USER', 'APP_AGENT', 'WEBSITE'] as const;
export type ManifestSurface = (typeof MANIFEST_SURFACES)[number];

export interface ManifestEntry {
  /** Route groups (console: `settings/flags`), feature folders (apps: `advertiser/campaigns`) or pages (website). */
  paths: string[];
  owner?: string;
  kind?: FeatureKind;
  launch?: FeatureLaunch;
  description?: string;
  variants?: string[];
}

export interface FeatureManifest {
  surface: ManifestSurface;
  features: Record<string, ManifestEntry>;
}

/** One feature as `docs/feature-registry.json` records it — every surface folded in. */
export interface RegistryEntry {
  key: string;
  surfaces: FeatureSurface[];
  kind: FeatureKind;
  owner: string;
  launch: FeatureLaunch;
  description: string;
  variants: string[];
  aliases: string[];
  /** Backend route prefixes and jobs, as declared. */
  routes: string[];
  jobs: string[];
  /** Per manifest surface, the paths that surface maps to the feature. */
  paths: Partial<Record<ManifestSurface, string[]>>;
  /** Where the feature is declared: `backend`, and each manifest surface that names it. */
  declaredIn: ('backend' | ManifestSurface)[];
}

export interface RegistryDocument {
  generatedBy: string;
  featureCount: number;
  features: RegistryEntry[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validates a parsed manifest. Throws with the offending key in the message:
 * a manifest is hand-written, and a typo in it must fail the sync and the
 * check script, not vanish into an unregistered feature.
 */
export function parseManifest(raw: unknown, where: string): FeatureManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  const doc = raw as Record<string, unknown>;
  if (!MANIFEST_SURFACES.includes(doc['surface'] as ManifestSurface)) {
    throw new Error(`${where}: "surface" must be one of ${MANIFEST_SURFACES.join(', ')}`);
  }
  const features = doc['features'];
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new Error(`${where}: "features" must be an object keyed on feature key`);
  }
  const parsed: Record<string, ManifestEntry> = {};
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (!FEATURE_KEY.test(key)) throw new Error(`${where}: "${key}" is not <area>.<capability>`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: "${key}" must be an object`);
    const entry = value as Record<string, unknown>;
    if (!isStringArray(entry['paths']) || entry['paths'].length === 0) {
      throw new Error(`${where}: "${key}" must name at least one path`);
    }
    const out: ManifestEntry = { paths: [...new Set(entry['paths'])] };
    if (entry['owner'] !== undefined) {
      if (typeof entry['owner'] !== 'string' || !entry['owner'].trim()) throw new Error(`${where}: "${key}" owner must be a string`);
      out.owner = entry['owner'];
    }
    if (entry['kind'] !== undefined) {
      if (!FEATURE_KINDS.includes(entry['kind'] as FeatureKind)) throw new Error(`${where}: "${key}" kind must be one of ${FEATURE_KINDS.join(', ')}`);
      out.kind = entry['kind'] as FeatureKind;
    }
    if (entry['launch'] !== undefined) {
      if (!FEATURE_LAUNCHES.includes(entry['launch'] as FeatureLaunch)) throw new Error(`${where}: "${key}" launch must be 'on' or 'dark'`);
      out.launch = entry['launch'] as FeatureLaunch;
    }
    if (entry['description'] !== undefined) {
      if (typeof entry['description'] !== 'string' || !entry['description'].trim()) throw new Error(`${where}: "${key}" description must be a string`);
      out.description = entry['description'];
    }
    if (entry['variants'] !== undefined) {
      if (!isStringArray(entry['variants'])) throw new Error(`${where}: "${key}" variants must be strings`);
      out.variants = [...new Set(entry['variants'])];
    }
    parsed[key] = out;
  }
  return { surface: doc['surface'] as ManifestSurface, features: parsed };
}

/**
 * Folds the backend declarations and every manifest into one document. Pure
 * and deterministic (sorted by key, no timestamp), so the architecture test
 * can compare the committed file against a fresh fold and fail when
 * `npm run features:sync` was not run.
 */
export function buildRegistryDocument(
  declarations: readonly FeatureDeclaration[],
  manifests: readonly FeatureManifest[],
  generatedBy = 'scripts/features-sync.ts',
): RegistryDocument {
  const entries = new Map<string, RegistryEntry>();
  for (const declaration of declarations) {
    entries.set(declaration.key, {
      key: declaration.key,
      surfaces: [...declaration.surfaces],
      kind: declaration.kind,
      owner: declaration.owner,
      launch: declaration.launch,
      description: declaration.description,
      variants: [...declaration.variants],
      aliases: [...declaration.aliases],
      routes: [...declaration.routes],
      jobs: [...declaration.jobs],
      paths: {},
      declaredIn: ['backend'],
    });
  }
  for (const manifest of manifests) {
    for (const [key, entry] of Object.entries(manifest.features)) {
      const existing = entries.get(key);
      if (existing) {
        if (!existing.surfaces.includes(manifest.surface)) existing.surfaces.push(manifest.surface);
        existing.paths[manifest.surface] = [...entry.paths];
        existing.declaredIn.push(manifest.surface);
        for (const variant of entry.variants ?? []) {
          if (!existing.variants.includes(variant)) existing.variants.push(variant);
        }
        continue;
      }
      if (!entry.owner || !entry.kind || !entry.launch || !entry.description) {
        throw new Error(
          `${manifest.surface} manifest: "${key}" is not declared by the backend, so it must carry owner, kind, launch and description`,
        );
      }
      entries.set(key, {
        key,
        surfaces: [manifest.surface],
        kind: entry.kind,
        owner: entry.owner,
        launch: entry.launch,
        description: entry.description,
        variants: [...(entry.variants ?? [])],
        aliases: [],
        routes: [],
        jobs: [],
        paths: { [manifest.surface]: [...entry.paths] },
        declaredIn: [manifest.surface],
      });
    }
  }
  const features = [...entries.values()]
    .map((entry) => ({
      ...entry,
      surfaces: FEATURE_SURFACES.filter((surface) => entry.surfaces.includes(surface)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { generatedBy, featureCount: features.length, features };
}

/** Whether a parsed object is a registry document this code can read. */
export function isRegistryDocument(raw: unknown): raw is RegistryDocument {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as RegistryDocument).features) &&
    (raw as RegistryDocument).features.every((entry) => typeof entry?.key === 'string' && Array.isArray(entry.surfaces))
  );
}
