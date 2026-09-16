import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-B — a write answers the same view its read answers.
 *
 * `PATCH /listings/:listingId` (the console's `setInstantBooking` and
 * `setSlotsTotal`) answers what `GET /listings/:listingId` answers — the
 * listing with its `publisher`, `agent`, photos, media type and
 * `carriesLoop`, translated for the reader — one read after the write.
 */

const { service, ai } = vi.hoisted(() => ({
  service: {
    assertCanEditListing: vi.fn(),
    updateListing: vi.fn(),
    getListingForAdmin: vi.fn(),
  },
  ai: { translateListings: vi.fn(async (rows: unknown[]) => rows) },
}));

vi.mock('../listings.service', () => service);
vi.mock('../browse.service', () => ({}));
vi.mock('../spot-page.service', () => ({}));
vi.mock('../audience.service', () => ({}));
vi.mock('../../advertisers', () => ({ assertMayActFor: vi.fn(), getAdvertiserForUser: vi.fn() }));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn() }));
vi.mock('../../ai', () => ai);

import { getListingHandler, updateListingHandler } from '../listings.controller';

const detail = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'Andheri East hoarding',
  status: 'ACTIVE',
  instantBooking: false,
  slotsTotal: 1,
  publisher: { id: 'pub_1', name: 'Metro Gym', displayId: 'PUB-1', city: 'Mumbai' },
  agent: { id: 'agt_1', displayId: 'AGT-7' },
  photos: [],
  mediaType: { name: 'LED wall', formatGroup: 'Digital' },
  carriesLoop: true,
  ...over,
});

function res() {
  const r: Record<string, any> = {};
  r['json'] = vi.fn((b: unknown) => {
    r['sent'] = b;
    return r;
  });
  return r;
}
const req = (body: Record<string, unknown>) =>
  ({ params: { listingId: 'lst_1' }, body, user: { sub: 'usr_ops', roles: ['ADMIN'] } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  service.assertCanEditListing.mockResolvedValue(undefined);
  service.updateListing.mockResolvedValue({ id: 'lst_1', instantBooking: true });
});

describe('PATCH /listings/:listingId', () => {
  it('setInstantBooking answers the detail view — publisher and agent beside the switched row', async () => {
    service.getListingForAdmin.mockResolvedValue(detail({ instantBooking: true }));
    const r = res();
    await updateListingHandler(req({ instantBooking: true }), r as never);
    expect(service.updateListing).toHaveBeenCalledWith('lst_1', { instantBooking: true });
    expect(service.getListingForAdmin).toHaveBeenCalledWith('lst_1');
    expect(ai.translateListings).toHaveBeenCalledWith([expect.objectContaining({ id: 'lst_1' })], 'usr_ops');
    expect(r['sent'].data).toMatchObject({
      id: 'lst_1',
      instantBooking: true,
      publisher: { id: 'pub_1', name: 'Metro Gym', displayId: 'PUB-1' },
      agent: { id: 'agt_1', displayId: 'AGT-7' },
      carriesLoop: true,
    });
  });

  it('setSlotsTotal answers the same view the GET answers', async () => {
    service.getListingForAdmin.mockResolvedValue(detail({ slotsTotal: 8 }));
    const patched = res();
    await updateListingHandler(req({ slotsTotal: 8 }), patched as never);
    const got = res();
    await getListingHandler(req({}), got as never);
    expect(patched['sent'].data).toEqual(got['sent'].data);
    expect(patched['sent'].data).toMatchObject({ slotsTotal: 8, publisher: expect.objectContaining({ id: 'pub_1' }), agent: expect.objectContaining({ id: 'agt_1' }) });
  });
});
