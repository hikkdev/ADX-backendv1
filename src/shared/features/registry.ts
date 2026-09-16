/**
 * The feature registry — Lot G (answers 144-146).
 *
 * A feature is declared where it is built: every backend module carries a
 * `features.ts` beside its routes that calls `feature(key, {...})` once per
 * user-facing capability, and the console and the two apps each ship a
 * `features.manifest.json` at their package root for the surfaces the backend
 * cannot see at runtime. The declarations land in this process-wide registry
 * as the modules load; `ensureFeatureRegistry()` (modules/feature-flags) then
 * upserts every one of them into `FeatureFlag` at boot, which is how a new
 * feature is listed on Settings -> Feature flags the moment it exists in the
 * codebase — nobody creates a flag by hand.
 *
 * It lives under `shared/` rather than inside `modules/feature-flags` because
 * every module's `features.ts` imports it, and a test that mocks
 * `modules/feature-flags` (ten of them do, to pin `isFeatureEnabled`) must
 * not take the declarations down with the mock. `shared/` is the bottom of
 * the graph, and a Map with a few pure reads over it belongs there the way
 * the permission catalogue does.
 *
 * `tests/architecture/feature-registry.test.ts` fails the build when a
 * mounted route or a job under `src/jobs` belongs to no feature. Coverage is
 * declared either by `requireFeature('key')` on the router or the route, or
 * by naming route prefixes here; the longest declared prefix wins, so a
 * module's root prefix (`/api/v1/campaigns`) is the safety net under its more
 * specific capabilities (`/api/v1/campaigns/:id/landing-page`).
 *
 * No I/O here: the registry is a Map and a few pure reads over it, so it can
 * be inspected by a script (`npm run features:sync`) and by the architecture
 * test without a database.
 */

export const FEATURE_SURFACES = ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND', 'WEBSITE'] as const;
export type FeatureSurface = (typeof FEATURE_SURFACES)[number];

export const FEATURE_KINDS = ['FEATURE', 'KILL_SWITCH', 'EXPERIMENT'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export const FEATURE_LAUNCHES = ['on', 'dark'] as const;
export type FeatureLaunch = (typeof FEATURE_LAUNCHES)[number];

/** `<area>.<capability>` — lower-case, dot-separated, hyphens allowed: `marketplace.instant-booking`. */
export const FEATURE_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

export interface FeatureOptions {
  /** Where the feature shows: the apps, the console, the website, or only the backend. */
  surfaces: readonly FeatureSurface[];
  /** The team that answers for it — `platform`, `finance`, `supply`, `demand`, `agent-experience`, `senior`. */
  owner: string;
  kind: FeatureKind;
  /**
   * `on`: the row is created enabled — a feature that already ships arrives
   * switched on, so registering it changes nothing for anyone. `dark`: the
   * row is created off, for a feature that is built but not launched.
   */
  launch: FeatureLaunch;
  description: string;
  /** Named variants for an EXPERIMENT (or a feature with two implementations); `variant` on the row must be one of them. */
  variants?: readonly string[];
  /** Keys this feature used to answer to; `isFeatureEnabled(alias)` resolves to this key. */
  aliases?: readonly string[];
  /** Route prefixes this feature covers, as the route inventory prints them (`/api/v1/campaigns/:id/landing-page`). */
  routes?: readonly string[];
  /** Jobs under `src/jobs` this feature covers, by file name without `.job.ts` (`earnings-accrual`). */
  jobs?: readonly string[];
}

export interface FeatureDeclaration extends FeatureOptions {
  key: string;
  variants: readonly string[];
  aliases: readonly string[];
  routes: readonly string[];
  jobs: readonly string[];
}

/**
 * The three flags Lot A seeded by migration, under the keys the registry
 * gives them. Kept here rather than only on the declarations so the alias
 * answers regardless of which module happens to have loaded — the
 * declarations repeat them, and `ensureFeatureRegistry` folds the old rows
 * into the new keys (state and history carried over) the first time it runs.
 */
export const LEGACY_FLAG_KEYS: Readonly<Record<string, string>> = {
  'instant-booking': 'marketplace.instant-booking',
  'multi-market-campaigns': 'campaigns.multi-market',
  'publisher-spot-insights': 'publisher.spot-insights',
};

const declarations = new Map<string, FeatureDeclaration>();
const aliases = new Map<string, string>(Object.entries(LEGACY_FLAG_KEYS));

function assertKey(key: string, what: string): void {
  if (!FEATURE_KEY.test(key)) {
    throw new Error(`Feature ${what} "${key}" must be <area>.<capability> in lower-case (hyphens allowed)`);
  }
}

/**
 * Declares a feature. Called at module load from a `features.ts`; throws on
 * a malformed key, a duplicate key or an alias that already names another
 * feature — each of those is a mistake in the code, and the process should
 * not boot around it.
 */
export function feature(key: string, options: FeatureOptions): FeatureDeclaration {
  assertKey(key, 'key');
  if (declarations.has(key)) throw new Error(`Feature "${key}" is declared twice`);
  if (aliases.has(key)) throw new Error(`Feature "${key}" is an alias of "${aliases.get(key)}"`);
  if (options.surfaces.length === 0) throw new Error(`Feature "${key}" names no surface`);
  for (const surface of options.surfaces) {
    if (!FEATURE_SURFACES.includes(surface)) throw new Error(`Feature "${key}" names an unknown surface "${surface}"`);
  }
  if (!FEATURE_KINDS.includes(options.kind)) throw new Error(`Feature "${key}" has an unknown kind "${options.kind}"`);
  if (!FEATURE_LAUNCHES.includes(options.launch)) throw new Error(`Feature "${key}" must launch 'on' or 'dark'`);
  if (!options.description.trim()) throw new Error(`Feature "${key}" has no description`);
  if (!options.owner.trim()) throw new Error(`Feature "${key}" has no owner`);

  const declaration: FeatureDeclaration = {
    ...options,
    key,
    surfaces: [...new Set(options.surfaces)],
    variants: [...new Set(options.variants ?? [])],
    aliases: [...new Set(options.aliases ?? [])],
    routes: [...new Set(options.routes ?? [])],
    jobs: [...new Set(options.jobs ?? [])],
  };
  for (const alias of declaration.aliases) {
    const taken = aliases.get(alias);
    if (taken && taken !== key) throw new Error(`Alias "${alias}" already resolves to "${taken}", not "${key}"`);
    if (declarations.has(alias)) throw new Error(`Alias "${alias}" is itself a declared feature`);
  }
  for (const alias of declaration.aliases) aliases.set(alias, key);
  declarations.set(key, declaration);
  return declaration;
}

/** Every declaration, in key order. */
export function declaredFeatures(): FeatureDeclaration[] {
  return [...declarations.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function findDeclaration(key: string): FeatureDeclaration | undefined {
  return declarations.get(canonicalKey(key));
}

/** The key a call site's key resolves to: an alias becomes the feature it was folded into, anything else is itself. */
export function canonicalKey(key: string): string {
  return aliases.get(key) ?? key;
}

/** `{ alias: canonical }` for every alias the registry knows, the legacy three included. */
export function knownAliases(): Record<string, string> {
  return Object.fromEntries([...aliases.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** `[prefix, key]` for every route prefix any feature claims, longest prefix first. */
export function routeCoverage(): [string, string][] {
  const out: [string, string][] = [];
  for (const declaration of declarations.values()) {
    for (const prefix of declaration.routes) out.push([prefix, declaration.key]);
  }
  return out.sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
}

/** `{ job: key }` for every job any feature claims. */
export function jobCoverage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of declarations.values()) {
    for (const job of declaration.jobs) out[job] = declaration.key;
  }
  return out;
}

/** Whether a route path sits under a prefix: equal, or one more segment down. */
export function pathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The feature covering a route path by prefix, or null — the longest declared prefix wins. */
export function featureForPath(path: string): string | null {
  for (const [prefix, key] of routeCoverage()) {
    if (pathUnder(path, prefix)) return key;
  }
  return null;
}

/** Test-only: forget every declaration. Production never calls it. */
export function resetRegistryForTests(): void {
  declarations.clear();
  aliases.clear();
  for (const [alias, key] of Object.entries(LEGACY_FLAG_KEYS)) aliases.set(alias, key);
}
