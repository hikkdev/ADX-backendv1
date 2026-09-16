/**
 * `npm run features:sync` — Lot G (answer 144).
 *
 * Folds every backend declaration (`src/modules/<m>/features.ts`,
 * `src/bootstrap/features.ts`) and the three package manifests (console,
 * user app, agent app) into `docs/feature-registry.json`, which is committed:
 * `ensureFeatureRegistry()` reads it at boot so a console screen or an app
 * folder gets a row and a kill switch too, and `GET /flags/registry` serves it
 * so the console can show surfaces the backend cannot see at runtime.
 *
 * `--check` writes nothing and exits 1 when the committed document is behind,
 * per surface, through `modules/feature-flags/registry-check` — the same
 * verdict `GET /flags/registry` carries as `check` (G11-2); the architecture
 * test makes the strict whole-document comparison on top.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isRegistryDocument, type RegistryDocument } from '../src/shared/features';
import { compareRegistryDocuments } from '../src/modules/feature-flags/registry-check';
import { collectFeatures, REGISTRY_DOCUMENT } from './collect-features';

/** The committed document as parsed, or null when it is missing or not a registry document. */
function readCommitted(): RegistryDocument | null {
  if (!fs.existsSync(REGISTRY_DOCUMENT)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(REGISTRY_DOCUMENT, 'utf8'));
    return isRegistryDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const { document, missingManifests, missingSurfaces } = await collectFeatures();
  for (const file of missingManifests) console.warn(`features-sync: manifest not found, surface skipped: ${file}`);

  const next = `${JSON.stringify(document, null, 2)}\n`;
  const relative = path.relative(process.cwd(), REGISTRY_DOCUMENT);

  if (check) {
    // G11-2: the same verdict GET /flags/registry carries as `check` — one
    // checker, per surface, so the console and the terminal agree.
    const verdict = compareRegistryDocuments(readCommitted(), document, { missingSurfaces });
    for (const surface of verdict.surfaces) {
      for (const reason of surface.reasons) (surface.behind ? console.error : console.warn)(`features-sync: ${surface.surface}: ${reason}`);
    }
    if (verdict.current) {
      console.log(`features-sync: ${relative} is current (${document.featureCount} features).`);
      return;
    }
    const behind = verdict.surfaces.filter((surface) => surface.behind).map((surface) => surface.surface);
    console.error(`features-sync: ${relative} is behind the code on ${behind.join(', ')} — run npm run features:sync and commit it.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(REGISTRY_DOCUMENT), { recursive: true });
  fs.writeFileSync(REGISTRY_DOCUMENT, next);
  const surfaces = document.features.reduce<Record<string, number>>((acc, entry) => {
    for (const surface of entry.surfaces) acc[surface] = (acc[surface] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `features-sync: wrote ${relative} — ${document.featureCount} features (${Object.entries(surfaces)
      .map(([surface, count]) => `${surface} ${count}`)
      .join(', ')}).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
