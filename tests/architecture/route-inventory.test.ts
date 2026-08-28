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

  it('mounts every route under /api/v1', () => {
    for (const route of live) {
      expect(route.path.startsWith('/api/v1')).toBe(true);
    }
  });
});
