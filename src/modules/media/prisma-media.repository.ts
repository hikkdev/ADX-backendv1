import { prisma, type Prisma } from '../../shared/database';
import type { MediaRepository } from './media.repository';
import { AD_BOOKING_CLOSED, mediaIdsIn, type MediaFilter, type MediaUsage } from './media.types';

/**
 * Whose pictures: ADX's own have no advertiser, an advertiser's ad artwork
 * has one. A named advertiser is narrower than `owner` and wins; `all` (or
 * nothing) leaves the column alone.
 */
function ownerWhere(filter: MediaFilter): Prisma.MediaAssetWhereInput {
  if (filter.ownerAdvertiserId !== undefined) return { ownerAdvertiserId: filter.ownerAdvertiserId };
  if (filter.owner === 'adx') return { ownerAdvertiserId: null };
  if (filter.owner === 'advertisers') return { ownerAdvertiserId: { not: null } };
  return {};
}

export const prismaMediaRepository: MediaRepository = {
  list(filter: MediaFilter) {
    const where: Prisma.MediaAssetWhereInput = {
      archivedAt: filter.archived ? { not: null } : null,
      ...(filter.tag ? { tags: { has: filter.tag } } : {}),
      ...(filter.specs?.length ? { spec: { in: filter.specs } } : {}),
      ...ownerWhere(filter),
      ...(filter.q
        ? {
            OR: [
              { title: { contains: filter.q, mode: 'insensitive' } },
              { altText: { contains: filter.q, mode: 'insensitive' } },
              { tags: { has: filter.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    return prisma.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, take: filter.limit });
  },

  findById(id) {
    return prisma.mediaAsset.findUnique({ where: { id } });
  },

  findByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.mediaAsset.findMany({ where: { id: { in: ids } } });
  },

  create(data) {
    return prisma.mediaAsset.create({ data });
  },

  update(id, patch) {
    return prisma.mediaAsset.update({ where: { id }, data: patch });
  },

  setArchived(id, at) {
    return prisma.mediaAsset.update({ where: { id }, data: { archivedAt: at } });
  },

  async publishedUsage(mediaId) {
    // One published row per surface at most — eight rows, read whole.
    const live = await prisma.layoutVersion.findMany({ where: { status: 'PUBLISHED' }, select: { surface: true, pageId: true, number: true, blocks: true } });
    const usage: MediaUsage[] = [];
    for (const version of live) {
      const blocks = Array.isArray(version.blocks) ? (version.blocks as unknown[]) : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const { id, type, props } = block as { id?: unknown; type?: unknown; props?: unknown };
        if (mediaIdsIn(props).has(mediaId)) {
          // PB-4: a custom Studio page's version names the page instead of a surface.
          usage.push({ surface: version.surface ?? `page:${version.pageId ?? ''}`, number: version.number, blockId: String(id ?? ''), blockType: String(type ?? '') });
        }
      }
    }
    return usage;
  },

  /*
   * `AdBooking` belongs to `promotions`; it is read here, narrowly (three
   * columns, by artwork id), so `media` never imports `promotions` — which
   * imports `media` to store a buyer's artwork. `layouts` reads the same
   * table the same way for the same reason.
   */
  openAdBookings(mediaId) {
    return prisma.adBooking.findMany({
      where: { mediaId, status: { notIn: [...AD_BOOKING_CLOSED] } },
      select: { id: true, displayId: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  },
};
