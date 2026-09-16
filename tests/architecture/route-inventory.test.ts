import { beforeAll, describe, expect, it } from 'vitest';
import { collectRoutes, type RouteEntry } from '../../scripts/collect-routes';
import baseline from '../../docs/route-inventory.json';

/**
 * The primary regression gate for the modular refactor.
 *
 * Moving a controller between files must not change which URL reaches it, what
 * guards it, or in what order routes are registered. Registration order is
 * load-bearing here in two places, so this compares the full ordered list
 * rather than a set:
 *
 *   - GET /api/v1/listings/:id/similar is registered ahead of the
 *     authenticated listing router and is deliberately public.
 *   - /api/v1/orders/:orderId/milestones is registered behind the order
 *     router, so requests pass through its authenticate layer first.
 */
describe('route inventory', () => {
  let live: RouteEntry[];

  beforeAll(async () => {
    live = await collectRoutes();
  });

  it('matches the committed snapshot exactly, in order', () => {
    expect(live).toEqual(baseline.routes);
  });

  it('exposes the recorded number of routes', () => {
    expect(live).toHaveLength(baseline.routeCount);
  });

  it('keeps GET /api/v1/listings/:id/similar public and ahead of the listing router', () => {
    const similar = live.findIndex((r) => r.path === '/api/v1/listings/:id/similar');
    const listingRoot = live.findIndex((r) => r.path === '/api/v1/listings' && r.method === 'GET');

    expect(similar).toBeGreaterThanOrEqual(0);
    expect(listingRoot).toBeGreaterThanOrEqual(0);
    expect(similar).toBeLessThan(listingRoot);
    expect(live[similar]?.chain).not.toContain('authenticate');
    expect(live[listingRoot]?.chain).toContain('authenticate');
  });

  it('keeps the QR image endpoints public and ahead of the authenticated QR routes', () => {
    const png = live.find((r) => r.path === '/api/v1/qr/:qrId/image.png');
    const resolve = live.find((r) => r.path === '/api/v1/qr/resolve');

    expect(png?.chain).not.toContain('authenticate');
    expect(resolve?.chain).toContain('authenticate');
  });

  it('keeps the Digio webhook unauthenticated', () => {
    const webhook = live.find((r) => r.path === '/api/v1/webhooks/digio');
    expect(webhook?.method).toBe('POST');
    expect(webhook?.chain).not.toContain('authenticate');
  });

  /**
   * Nine routes are deliberately outside the API prefix, and exactly nine.
   *
   * `/t/:code` is the campaign scan redirect, printed on hoardings and encoded
   * into QR codes. `/p/:token` is the package payment link, sent by SMS. Both
   * go to a person rather than to an API client, and both are read off a screen
   * or a wall and sometimes typed — `/api/v1/campaigns/track/:code` would be
   * worse at the only job either has. `/t/:code/e` (Lot D, Q7) is the landing
   * page reporting an interaction back to the code that brought the visitor —
   * written by that page's script, beside the redirect it followed.
   *
   * `/p/:slug` (Lot E, Q106) is the campaign landing page the scan redirect
   * lands on — the same person, one hop later — and shares the `/p` prefix
   * with the payment link because both are short by design; the landing
   * handler calls `next()` on a slug nothing PUBLISHED answers to, so a
   * token still reaches the payment link mounted after it.
   *
   * `/s/:displayId` (E11-2) is the public spot page a shared link opens —
   * sent by an advertiser to somebody who may have neither an account nor
   * the app, so it is short, public and metered by IP, mounted after the
   * payment link.
   *
   * `/status` and its three links (Lot G, Q130) are the public status page:
   * read during an outage by people with no account, with subscribe /
   * confirm / unsubscribe links that arrive by email and are opened from a
   * mail client. Mounted after the spot page, metered by IP inside the router
   * (`statusPageLimiter`, `statusSubscribeLimiter`).
   *
   * The allowlist is exact rather than a prefix rule, so a route that escapes
   * the API surface by accident still fails here.
   */
  const ROOT_MOUNTED = [
    '/t/:code',
    '/t/:code/e',
    '/p/:slug',
    '/p/:token',
    '/s/:displayId',
    '/status',
    '/status/subscribe',
    '/status/confirm/:token',
    '/status/unsubscribe/:token',
  ];

  it('mounts every route under /api/v1, bar the documented exceptions', () => {
    const escaped = live
      .filter((route) => !route.path.startsWith('/api/v1'))
      .map((route) => route.path);

    expect(escaped).toEqual(ROOT_MOUNTED);
  });

  it('keeps the scan redirect public — it is a phone camera, not an API client', () => {
    const scan = live.find((route) => route.path === '/t/:code');
    expect(scan?.method).toBe('GET');
    expect(scan?.chain).not.toContain('authenticate');
  });

  it('keeps the interaction report public but metered — a browser on the landing page, not a client', () => {
    const event = live.find((route) => route.path === '/t/:code/e');
    expect(event?.method).toBe('POST');
    expect(event?.chain).not.toContain('authenticate');
    // express-rate-limit's handler is anonymous; it shows in the chain as
    // `<anon>` ahead of the handler, exactly as the package-link limiter does.
    expect(event?.chain.slice(-2)).toEqual(['<anon>', 'interactionHandler']);
  });

  it('keeps the landing page public, and ahead of the payment link it falls through to', () => {
    const page = live.find((route) => route.path === '/p/:slug');
    expect(page?.method).toBe('GET');
    expect(page?.chain).not.toContain('authenticate');
    expect(page?.chain[page.chain.length - 1]).toBe('landingPageHandler');
    expect(live.findIndex((route) => route.path === '/p/:slug')).toBeLessThan(
      live.findIndex((route) => route.path === '/p/:token')
    );
  });

  it('keeps the package payment link public — it arrives in an SMS', () => {
    const link = live.find((route) => route.path === '/p/:token');
    expect(link?.method).toBe('GET');
    expect(link?.chain).not.toContain('authenticate');
  });

  it("keeps the spot page public but metered — a shared link on a stranger's phone", () => {
    const page = live.find((route) => route.path === '/s/:displayId');
    expect(page?.method).toBe('GET');
    expect(page?.chain).not.toContain('authenticate');
    expect(page?.chain.slice(-2)).toEqual(['<anon>', 'spotPageHandler']);
  });
});
