import { describe, expect, it } from 'vitest';
import type { Router } from 'express';

/**
 * W1 (24 Sep 2026) — discovery is public on the website.
 *
 * What is pinned: the four browse reads take `authenticateOptional` and sit
 * above the router-wide `authenticate`, so a visitor with no session gets
 * the same page the app's advertiser home gets; the heart — a write into an
 * advertiser's saved book — stays behind `authenticate`; and nothing else on
 * the listings router opened up with them.
 */
import { listingRouter } from '../../src/modules/listings';
import * as security from '../../src/shared/security';

type Layer = { name: string; route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } };

function guardsOf(router: Router, method: string, path: string): string[] {
  const layer = (router.stack as unknown as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} is not on the router`);
  return layer.route.stack.map((h) => h.name);
}

/** The position of a layer in the router — a public read must come before the router-wide authenticate. */
function indexOf(router: Router, predicate: (layer: Layer) => boolean): number {
  return (router.stack as unknown as Layer[]).findIndex(predicate);
}

describe('the browse reads answer without a session', () => {
  it.each([
    ['get', '/browse'],
    ['get', '/browse/categories'],
    ['get', '/browse/venues'],
    ['get', '/browse/:listingId'],
    // AV-1 (27 Sep 2026): the per-day picture of one space, public like the listing page.
    ['get', '/browse/:listingId/availability'],
  ])('%s %s carries authenticateOptional and sits above the router-wide authenticate', (method, path) => {
    expect(guardsOf(listingRouter, method, path)).toContain('authenticateOptional');
    expect(guardsOf(listingRouter, method, path)).not.toContain('authenticate');
    const read = indexOf(listingRouter, (l) => l.route?.path === path && !!l.route.methods[method]);
    const wall = indexOf(listingRouter, (l) => !l.route && l.name === 'authenticate');
    expect(wall).toBeGreaterThan(-1);
    expect(read).toBeLessThan(wall);
  });

  it('the heart stays a signed-in write, below the router-wide authenticate', () => {
    const save = indexOf(listingRouter, (l) => l.route?.path === '/browse/:listingId/save' && !!l.route.methods['put']);
    const wall = indexOf(listingRouter, (l) => !l.route && l.name === 'authenticate');
    expect(save).toBeGreaterThan(wall);
    expect(guardsOf(listingRouter, 'put', '/browse/:listingId/save')).not.toContain('authenticateOptional');
  });

  it('opens nothing else: every other layer above the wall is a browse read', () => {
    const wall = indexOf(listingRouter, (l) => !l.route && l.name === 'authenticate');
    const above = (listingRouter.stack as unknown as Layer[]).slice(0, wall).filter((l) => l.route);
    expect(above.map((l) => l.route!.path)).toEqual([
      '/browse',
      '/browse/categories',
      '/browse/venues',
      '/browse/:listingId',
      '/browse/:listingId/availability',
      // LD-1 (3 Oct 2026): the spot-page view count — the one public write, pinned below.
      '/:displayIdOrId/view',
    ]);
  });

  it('LD-1: the view count is a POST alone, metered and behind its kill switch, and opens no read of a listing', () => {
    const layer = (listingRouter.stack as unknown as Layer[]).find((l) => l.route?.path === '/:displayIdOrId/view');
    expect(Object.keys(layer!.route!.methods)).toEqual(['post']);
    // The limiter is express-rate-limit's anonymous middleware; its place is what is pinned.
    expect(guardsOf(listingRouter, 'post', '/:displayIdOrId/view')).toEqual([
      'authenticateOptional',
      expect.any(String),
      'requireFeature(listings.spot-views)',
      'listingViewHandler',
    ]);
    const handlers = layer!.route!.stack as unknown as { handle: unknown }[];
    const { spotViewLimiter } = security;
    expect(handlers[1]!.handle).toBe(spotViewLimiter);
  });
});
