import { feature } from '../../shared/features';

/**
 * Features of `uploads` — Lot G (answer 144).
 *
 * Files in and files out (Lot D, Q61).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('platform.uploads', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Uploading a file and reading a private one back through the one door.',
  routes: ['/api/v1/upload', '/api/v1/files'],
});

feature('platform.gps-camera', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'GC (23 Sep 2026): the ADX camera stamps a photo with where and when it was taken — a band burned into the picture and the EXIF GPS block — when the person has the location stamp on, like a flash switch. Opt-in per photo; evidence flows open with it on, listing photos with it off.',
  routes: ['/api/v1/upload'],
});

feature('platform.document-reading', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "DR-1 (23 Sep 2026): the desk reads what is written on an uploaded document through the vision model — the kind named, the fields held to that kind's list with a confidence each, kept on the file and shown wherever it appears. It prefills and cross-checks; Accept and Flag stay the reviewer's. Aadhaar is never a kind.",
  routes: ['/api/v1/files'],
});

feature('settings.storage', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'ST-3 / ST-4 (28 Sep 2026): Settings › Storage — space per purpose (public and private apart), the largest files, the files nothing on the platform refers to, and the weekly sweep that marks them. Removal of a file unreferenced past the grace period is OFF by default and only the owner turns it on; the retention-governed purposes are never touched.',
  routes: ['/api/v1/storage'],
  jobs: ['storage-sweep'],
});
