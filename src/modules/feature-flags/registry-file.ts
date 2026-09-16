import fs from 'node:fs';
import path from 'node:path';
import { isRegistryDocument, type RegistryDocument } from '../../shared/features';
import { logger } from '../../shared/logging';

/**
 * `docs/feature-registry.json` — Lot G (answer 144).
 *
 * Written by `npm run features:sync` from the backend declarations and the
 * three package manifests (console, user app, agent app), committed, and
 * read here for the surfaces the backend cannot see at runtime: a console
 * screen or an app feature folder is a feature too, and it gets a row and a
 * kill switch the same way a route does.
 *
 * Resolved relative to this file, not the working directory, so it is found
 * whether the process runs from `src` (tsx) or `dist` (node) — both sit one
 * level under the package root beside `docs/`.
 */
export const REGISTRY_FILE = path.resolve(__dirname, '../../../docs/feature-registry.json');

let cached: RegistryDocument | null | undefined;

/** The committed document, or null when it is missing or unreadable (logged once). */
export function readRegistryDocument(): RegistryDocument | null {
  if (cached !== undefined) return cached;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    cached = isRegistryDocument(parsed) ? parsed : null;
    if (!cached) logger.warn('feature registry document has an unexpected shape', { file: REGISTRY_FILE });
  } catch (err) {
    cached = null;
    logger.warn('feature registry document not read; manifest-only features will not be listed', {
      file: REGISTRY_FILE,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return cached;
}

/** Test-only: forget the cached read. */
export function resetRegistryDocumentForTests(document?: RegistryDocument | null): void {
  cached = document;
}
