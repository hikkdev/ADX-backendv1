import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: GET /listings/:id (ADMIN) says whether the spot carries a loop —
 * `carriesLoop`, by the one rule `slots.service` refuses a slot count with
 * (the sub-type or the media type names a screen) — and prints the media
 * type it was filed under as `{ name, formatGroup } | null`, joined on the
 * same read rather than looked up again.
 */

const repository = vi.hoisted(() => ({ findOneForAdmin: vi.fn(), mediaTypeLoopHint: vi.fn() }));
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => ({ classifySpot: vi.fn(), activeSurge: vi.fn(), assertCityAllows: vi.fn() }));
vi.mock('../../rate-cards', () => ({ belowFloorFlags: vi.fn(), assertPublishable: vi.fn(), checkGate: vi.fn() }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(), ...passThroughFeatureGates() }));

import { getListingForAdmin } from '../listings.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'Andheri East hoarding',
  status: 'ACTIVE',
  subType: null,
  mediaTypeId: null,
  mediaType: null,
  slotsTotal: 1,
  publisher: { id: 'pub_1', name: 'Metro Gym', displayId: 'PUB-1', city: 'Mumbai' },
  agent: null,
  photos: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /listings/:id — carriesLoop and mediaType', () => {
  it('a static wall with no media type carries no loop, mediaType null', async () => {
    repository.findOneForAdmin.mockResolvedValue(listing());
    expect(await getListingForAdmin('lst_1')).toMatchObject({ id: 'lst_1', carriesLoop: false, mediaType: null });
    // The join answers; the loop hint is not looked up again.
    expect(repository.mediaTypeLoopHint).not.toHaveBeenCalled();
  });

  it('a screen named by the media type carries a loop, and the media type is printed', async () => {
    repository.findOneForAdmin.mockResolvedValue(listing({ mediaTypeId: 'mt_1', mediaType: { name: 'LED wall', formatGroup: 'Digital' } }));
    expect(await getListingForAdmin('lst_1')).toMatchObject({ carriesLoop: true, mediaType: { name: 'LED wall', formatGroup: 'Digital' } });
  });

  it('a screen named by the sub-type carries a loop whatever the media type says', async () => {
    repository.findOneForAdmin.mockResolvedValue(listing({ subType: 'Digital screen', mediaType: { name: 'Vinyl', formatGroup: null } }));
    expect(await getListingForAdmin('lst_1')).toMatchObject({ carriesLoop: true, mediaType: { name: 'Vinyl', formatGroup: null } });
    // "Screen-printed" is not a screen.
    repository.findOneForAdmin.mockResolvedValue(listing({ subType: 'Screen-printed vinyl', mediaType: { name: 'Vinyl', formatGroup: 'Print' } }));
    expect(await getListingForAdmin('lst_1')).toMatchObject({ carriesLoop: false });
  });

  it('404s a spot that does not exist', async () => {
    repository.findOneForAdmin.mockResolvedValue(null);
    await expect(getListingForAdmin('lst_missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
