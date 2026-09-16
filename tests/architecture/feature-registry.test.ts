import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectRoutes, type RouteEntry } from '../../scripts/collect-routes';
import {
  BACKEND_ROOT,
  MANIFEST_FILES,
  REGISTRY_DOCUMENT,
  collectFeatures,
  featureFiles,
  modulesWithoutFeatures,
  type CollectedFeatures,
} from '../../scripts/collect-features';
import {
  FEATURE_KEY,
  declaredFeatures,
  featureForPath,
  jobCoverage,
  knownAliases,
  pathUnder,
  routeCoverage,
} from '../../src/shared/features';

/**
 * Every feature is registered where it is built — Lot G (answer 144).
 *
 * The owner's requirement is that Settings -> Feature flags lists a new
 * feature the moment it is added anywhere in the codebase. The registry
 * makes that true only if nothing can be mounted without a declaration, so
 * this fails the build when:
 *
 *   - a mounted route is covered by no feature — neither `requireFeature()`
 *     in its chain nor a route prefix in some module's `features.ts`;
 *   - a job under src/jobs is mapped to no feature;
 *   - a module directory ships no `features.ts`, or ships one its `index.ts`
 *     does not import (declared, but never loaded at boot);
 *   - a declared route prefix or job matches nothing (the code moved and
 *     the declaration did not follow);
 *   - the committed docs/feature-registry.json is behind the declarations
 *     and the manifests (run `npm run features:sync`).
 *
 * The console's and the apps' manifests are checked by their own
 * `scripts/check-features.mjs`; here they are only parsed and folded.
 */

const REQUIRE_FEATURE = /^requireFeature\((.+)\)$/;

/** The feature a route's chain declares through `requireFeature(key)`, or null. */
function chainFeature(route: RouteEntry): string | null {
  for (const entry of route.chain) {
    const match = REQUIRE_FEATURE.exec(entry);
    if (match?.[1]) return match[1];
  }
  return null;
}

function jobFiles(): string[] {
  return fs
    .readdirSync(path.join(BACKEND_ROOT, 'src', 'jobs'))
    .filter((file) => file.endsWith('.job.ts'))
    .map((file) => file.replace(/\.job\.ts$/, ''))
    .sort();
}

describe('the feature registry', () => {
  let live: RouteEntry[];
  let collected: CollectedFeatures;

  beforeAll(async () => {
    live = await collectRoutes();
    collected = await collectFeatures();
  });

  it('has a declaration file in every module, imported by the module index so it loads at boot', () => {
    expect(modulesWithoutFeatures()).toEqual([]);
    const notLoaded: string[] = [];
    for (const file of featureFiles()) {
      const dir = path.dirname(file);
      if (path.basename(dir) === 'bootstrap') continue;
      const index = path.join(dir, 'index.ts');
      const source = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
      if (!/import\s+['"]\.\/features['"]/.test(source)) notLoaded.push(path.relative(BACKEND_ROOT, index));
    }
    expect(notLoaded, 'index.ts files that never import ./features').toEqual([]);
  });

  it('declares at least as many features as there are modules, every key well-formed', () => {
    const declared = declaredFeatures();
    expect(declared.length).toBeGreaterThanOrEqual(featureFiles().length);
    for (const declaration of declared) expect(declaration.key).toMatch(FEATURE_KEY);
  });

  it('covers every mounted route — by requireFeature on the chain or by a declared prefix', () => {
    const uncovered = live
      .filter((route) => !chainFeature(route) && !featureForPath(route.path))
      .map((route) => `${route.method} ${route.path}`);
    expect(
      uncovered,
      'routes no feature claims — add requireFeature(key) to the route, or its prefix to the owning module\'s features.ts',
    ).toEqual([]);
  });

  it('names only features that exist in requireFeature()', () => {
    const keys = new Set(declaredFeatures().map((declaration) => declaration.key));
    const unknown = live.map(chainFeature).filter((key): key is string => !!key && !keys.has(key));
    expect(unknown).toEqual([]);
  });

  it('claims no route prefix that matches nothing — a declaration that outlived its routes', () => {
    const stale = routeCoverage()
      .filter(([prefix]) => !live.some((route) => pathUnder(route.path, prefix)))
      .map(([prefix, key]) => `${key}: ${prefix}`);
    expect(stale).toEqual([]);
  });

  it('maps every job under src/jobs to a feature, and no job that does not exist', () => {
    const mapped = jobCoverage();
    const jobs = jobFiles();
    expect(jobs.filter((job) => !mapped[job]), 'jobs no feature claims').toEqual([]);
    expect(Object.keys(mapped).filter((job) => !jobs.includes(job)), 'declared jobs with no file').toEqual([]);
  });

  it('keeps the three Lot A keys answering as aliases of their registry features', () => {
    const declared = new Set(declaredFeatures().map((declaration) => declaration.key));
    const aliases = knownAliases();
    expect(aliases['instant-booking']).toBe('marketplace.instant-booking');
    expect(aliases['multi-market-campaigns']).toBe('campaigns.multi-market');
    expect(aliases['publisher-spot-insights']).toBe('publisher.spot-insights');
    for (const canonical of Object.values(aliases)) expect(declared.has(canonical)).toBe(true);
  });

  it('folds the three package manifests without a surface or key conflict', () => {
    for (const manifest of collected.manifests) {
      for (const key of Object.keys(manifest.features)) expect(key).toMatch(FEATURE_KEY);
    }
    // Each present manifest contributed its surface to at least one feature.
    for (const manifest of collected.manifests) {
      expect(collected.document.features.some((entry) => entry.surfaces.includes(manifest.surface))).toBe(true);
    }
  });

  it('is committed and current in docs/feature-registry.json (run npm run features:sync)', () => {
    if (collected.missingManifests.length > 0) {
      // The backend checked out alone: the fold is partial, so it is not
      // compared. The monorepo verifier sees every manifest.
      console.warn(`feature-registry: manifests not found, document not compared: ${collected.missingManifests.join(', ')}`);
      return;
    }
    expect(fs.existsSync(REGISTRY_DOCUMENT)).toBe(true);
    const committed = JSON.parse(fs.readFileSync(REGISTRY_DOCUMENT, 'utf8'));
    expect(committed).toEqual(collected.document);
    expect(Object.values(MANIFEST_FILES).every((file) => fs.existsSync(file))).toBe(true);
  });
});
