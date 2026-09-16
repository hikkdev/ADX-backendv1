import { feature } from '../../shared/features';

/**
 * Features of `campaigns` — Lot G (answer 144).
 *
 * The booking flow and everything that hangs off a campaign: creatives,
 * tracking, landing pages, analytics, refunds.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('campaigns.booking', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Campaigns: draft, inventory, spots, review, submit for payment, authorise, cancel; the lifecycle job that moves them SCHEDULED → LIVE → ENDED.',
  routes: ['/api/v1/campaigns'],
  jobs: ['campaign-lifecycle'],
});

feature('campaigns.multi-market', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'dark',
  description:
    'A campaign may target more than one market (Q8): allowed, warned against. Off: a second market is refused 409 FEATURE_OFF.',
  aliases: ['multi-market-campaigns'],
  // G12-B: the app's two renderings — `default` warns before a second
  // market, `unwarned` does not. Declared here so the console can set either
  // before the app manifest is synced.
  variants: ['default', 'unwarned'],
});

feature('campaigns.creative-moderation', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot D (Q44/Q120/Q138): creatives in review, the desk, the ADX-design tap-accept, the hard gate on print.',
  routes: ['/api/v1/campaigns/creatives', '/api/v1/campaigns/:id/creatives'],
});

feature('campaigns.tracking', {
  surfaces: ['APP_USER', 'APP_AGENT', 'WEBSITE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Tracking codes and their QR images (QR-1: drawn by the QR engine, hosted on GenQR in front of /t/, the SVG for print, the sync for codes issued while the engine was down), the scan redirect on the hoarding, redemptions.',
  routes: [
    '/t/:code',
    '/api/v1/campaigns/:id/tracking-codes',
    '/api/v1/campaigns/:id/redemptions',
  ],
});

feature('campaigns.landing-pages', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot E (Q7/Q106): the AI-drafted landing page, its builder, the review list, the public page and its beacon.',
  routes: [
    '/api/v1/campaigns/:id/landing-page',
    '/api/v1/campaigns/landing-pages',
    '/p/:slug',
    '/t/:code/e',
  ],
});

feature('campaigns.analytics', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Campaign analytics: digital interactions per campaign and across the book (Q109).',
  routes: ['/api/v1/campaigns/analytics', '/api/v1/campaigns/:id/analytics'],
});

feature('campaigns.refunds', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot B (Q41): a cancelled campaign\'s refund, released or rejected by finance.',
  routes: ['/api/v1/finance/campaign-refunds'],
});

feature('publisher.spot-insights', {
  surfaces: ['APP_USER', 'BACKEND'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'dark',
  description:
    'Publishers see the advertiser\'s per-spot figures on their bookings (Q9): kept present, off until there is data.',
  aliases: ['publisher-spot-insights'],
});
