import { feature } from '../../shared/features';

/**
 * Features of `qr` — Lot G (answer 144).
 *
 * The QR codes a claim, a grant and a scan run on.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('qr.desk', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'K-B1: the console\'s QR desk — every code with what it names and its scans, one person\'s scans, regenerate and deactivate with a reason.',
  routes: ['/api/v1/qr/scans', '/api/v1/qr/:qrId/scans', '/api/v1/qr/:qrId/regenerate'],
});

feature('onboarding.qr-claim', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Mint, render, resolve and delete QR codes; the scan log behind them.',
  routes: ['/api/v1/qr'],
});
