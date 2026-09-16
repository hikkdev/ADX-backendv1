import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-B — a write answers the same view its read answers.
 *
 * `POST /pricing/media-types` and `PATCH /pricing/media-types/:id` hand the
 * repository's row straight through, so the repository answers what
 * `GET /pricing/media-types` lists: the row with `sizeClassIds` and
 * `materialIds` — the same include on the write, no second read.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    mediaType: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaPricingRepository as repository } from '../prisma-pricing.repository';

const stored = {
  id: 'mt_1',
  name: 'Bus Shelter Panel',
  slug: 'bus-shelter-panel',
  category: 'OUTDOOR',
  status: 'ACTIVE',
  description: null,
  venueTypeId: null,
  formatGroup: null,
  origin: 'OPS',
  sizeClasses: [{ sizeClassId: 'sc_a' }, { sizeClassId: 'sc_b' }],
  materials: [{ materialId: 'mat_vinyl' }],
};

const detailInclude = { sizeClasses: { select: { sizeClassId: true } }, materials: { select: { materialId: true } } };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.mediaType.create.mockResolvedValue(stored);
  prisma.mediaType.update.mockResolvedValue({ ...stored, name: 'Bus Shelter' });
  prisma.mediaType.findMany.mockResolvedValue([stored]);
});

describe('media-type writes answer the list row', () => {
  it('createMediaType — sizeClassIds and materialIds beside the row, from the same include the list uses', async () => {
    const created = await repository.createMediaType({
      name: 'Bus Shelter Panel',
      slug: 'bus-shelter-panel',
      category: 'OUTDOOR',
      sizeClassIds: ['sc_a', 'sc_b'],
      materialIds: ['mat_vinyl'],
    } as never);
    expect(prisma.mediaType.create.mock.calls[0]![0].include).toEqual(detailInclude);
    expect(created).toMatchObject({ id: 'mt_1', sizeClassIds: ['sc_a', 'sc_b'], materialIds: ['mat_vinyl'] });
    expect(created).not.toHaveProperty('sizeClasses');
    const [listed] = await repository.listMediaTypes();
    expect(prisma.mediaType.findMany.mock.calls[0]![0].include).toEqual(detailInclude);
    expect(created).toEqual(listed);
  });

  it('updateMediaType — the same view after the patch', async () => {
    const updated = await repository.updateMediaType('mt_1', { name: 'Bus Shelter' } as never);
    expect(prisma.mediaType.update).toHaveBeenCalledWith({ where: { id: 'mt_1' }, data: { name: 'Bus Shelter' }, include: detailInclude });
    expect(updated).toMatchObject({ name: 'Bus Shelter', sizeClassIds: ['sc_a', 'sc_b'], materialIds: ['mat_vinyl'] });
    expect(updated).not.toHaveProperty('materials');
  });
});
