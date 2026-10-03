import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — `GET /publishers/:id/public`, the website's storefront
 * header: `{ id, name, avatarUrl, verified, liveListings }` for a visitor.
 * No contact data, no KYC detail; by id or display id; a publisher blocked
 * from new business is 404. The route sits above the router-wide
 * authenticate and nothing else on the router opened with it.
 */

const { prisma } = vi.hoisted(() => ({ prisma: { publisher: { findFirst: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), prisma }));

import type { Router } from 'express';
import { publicPublisherCard } from '../publishers.service';
import { publisherRouter } from '../publishers.routes';

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  name: 'Sharma Media',
  kycStatus: 'VERIFIED',
  suspensionScopes: [],
  user: { avatarUrl: 'https://cdn.adx.in/a.jpg' },
  _count: { listings: 7 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisher.findFirst.mockResolvedValue(stored());
});

describe('the public publisher card', () => {
  it('answers the five fields and nothing else', async () => {
    await expect(publicPublisherCard('pub_1')).resolves.toEqual({ id: 'pub_1', name: 'Sharma Media', avatarUrl: 'https://cdn.adx.in/a.jpg', verified: true, liveListings: 7 });
    const args = prisma.publisher.findFirst.mock.calls[0]![0];
    expect(args.where).toEqual({ OR: [{ id: 'pub_1' }, { displayId: 'pub_1' }] });
    // Only live spots in force are counted; no contact column is read.
    expect(args.select._count.select.listings.where).toEqual({ status: 'ACTIVE', rightsLapsedAt: null });
    expect(Object.keys(args.select)).not.toEqual(expect.arrayContaining(['mobile']));
    expect(args.select).not.toHaveProperty('mobile');
    expect(args.select).not.toHaveProperty('email');
  });

  it('an unverified publisher reads unverified', async () => {
    prisma.publisher.findFirst.mockResolvedValue(stored({ kycStatus: 'PENDING', user: null }));
    await expect(publicPublisherCard('pub_1')).resolves.toMatchObject({ verified: false, avatarUrl: null });
  });

  it('404 for none, and for a publisher blocked from new business', async () => {
    prisma.publisher.findFirst.mockResolvedValue(null);
    await expect(publicPublisherCard('nope')).rejects.toMatchObject({ statusCode: 404 });
    prisma.publisher.findFirst.mockResolvedValue(stored({ suspensionScopes: ['BLOCK_NEW'] }));
    await expect(publicPublisherCard('pub_1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the route', () => {
  type Layer = { name: string; route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } };
  const stack = (publisherRouter as unknown as Router).stack as unknown as Layer[];
  const wall = stack.findIndex((l) => !l.route && l.name === 'authenticate');

  it('is the only route above the router-wide authenticate, with the optional session and the limiter', () => {
    const above = stack.slice(0, wall).filter((l) => l.route);
    expect(above.map((l) => l.route!.path)).toEqual(['/:publisherId/public']);
    expect(above[0]!.route!.stack.map((h) => h.name)).toEqual(expect.arrayContaining(['authenticateOptional']));
    expect(above[0]!.route!.stack.map((h) => h.name)).not.toContain('authenticate');
  });
});
