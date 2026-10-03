import { Prisma, prisma } from '../../shared/database';
import type { LayoutsRepository, VersionKey } from './layouts.repository';

/**
 * `AdSlot` and `AdBooking` belong to `promotions`; the resolution reads them
 * here, narrowly (one slot by key, the LIVE bookings for a day), so a layout
 * can draw the ads sold into its slot without the two modules importing
 * each other while both are being built. `SitePage` belongs to `site-pages`;
 * the one read here (PB-1, a page's current address by key) is for the same
 * reason — `site-pages` imports `layouts`, never the other way.
 */

/** The columns a key selects on — a surface's rows, or a custom page's. */
const keyWhere = (key: VersionKey): Prisma.LayoutVersionWhereInput => ('surface' in key ? { surface: key.surface } : { pageId: key.pageId });

/** The columns a key writes: the other one explicitly null, as the DB check wants exactly one set. */
const keyColumns = (key: VersionKey): Pick<Prisma.LayoutVersionUncheckedCreateInput, 'surface' | 'pageId'> =>
  'surface' in key ? { surface: key.surface, pageId: null } : { surface: null, pageId: key.pageId };

/** A nullable Json column takes `DbNull`, not a JS null. */
const metaColumn = (meta: Prisma.InputJsonValue | null) => (meta === null ? Prisma.DbNull : meta);

export const prismaLayoutsRepository: LayoutsRepository = {
  currentRows() {
    return prisma.layoutVersion.findMany({ where: { status: { in: ['PUBLISHED', 'DRAFT'] } } });
  },

  live(key) {
    return prisma.layoutVersion.findFirst({ where: { ...keyWhere(key), status: 'PUBLISHED' }, orderBy: { number: 'desc' } });
  },

  draft(key) {
    return prisma.layoutVersion.findFirst({ where: { ...keyWhere(key), status: 'DRAFT' }, orderBy: { number: 'desc' } });
  },

  byNumber(key, number) {
    return prisma.layoutVersion.findFirst({ where: { ...keyWhere(key), number } });
  },

  versions(key) {
    return prisma.layoutVersion.findMany({ where: keyWhere(key), orderBy: { number: 'desc' } });
  },

  async highestNumber(key) {
    const top = await prisma.layoutVersion.findFirst({ where: keyWhere(key), orderBy: { number: 'desc' }, select: { number: true } });
    return top?.number ?? 0;
  },

  createDraft(data) {
    const { key, meta, ...rest } = data;
    return prisma.layoutVersion.create({ data: { ...rest, ...keyColumns(key), meta: metaColumn(meta), status: 'DRAFT' } });
  },

  updateDraft(id, data) {
    const { meta, ...rest } = data;
    return prisma.layoutVersion.update({ where: { id }, data: { ...rest, meta: metaColumn(meta) } });
  },

  async deleteDraft(id) {
    await prisma.layoutVersion.delete({ where: { id } });
  },

  async publishDraft(id, key, by, at, changeNote) {
    const [, row] = await prisma.$transaction([
      prisma.layoutVersion.updateMany({ where: { ...keyWhere(key), status: 'PUBLISHED', id: { not: id } }, data: { status: 'RETIRED', retiredAt: at } }),
      prisma.layoutVersion.update({
        where: { id },
        data: { status: 'PUBLISHED', publishedAt: at, publishedById: by, ...(changeNote !== null ? { changeNote } : {}) },
      }),
    ]);
    return row;
  },

  async publishCopy(data) {
    const [, row] = await prisma.$transaction([
      prisma.layoutVersion.updateMany({ where: { ...keyWhere(data.key), status: 'PUBLISHED' }, data: { status: 'RETIRED', retiredAt: data.at } }),
      prisma.layoutVersion.create({
        data: {
          ...keyColumns(data.key),
          number: data.number,
          status: 'PUBLISHED',
          blocks: data.blocks,
          meta: metaColumn(data.meta),
          changeNote: data.changeNote,
          createdByUserId: data.by,
          publishedById: data.by,
          publishedAt: data.at,
        },
      }),
    ]);
    return row;
  },

  async userNames(ids) {
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, firstName: true, lastName: true, email: true } });
    return new Map(
      users.map((user) => [user.id, user.name?.trim() || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || user.id]),
    );
  },

  async cityStage(cityId) {
    const city = await prisma.city.findUnique({ where: { id: cityId }, select: { stage: true } });
    return city?.stage ?? null;
  },

  slotByKey(key) {
    return prisma.adSlot.findUnique({ where: { key }, select: { id: true, key: true, label: true, spec: true, isActive: true } });
  },

  liveAds(slotId, day, cityId) {
    return prisma.adBooking.findMany({
      where: {
        slotId,
        status: 'LIVE',
        startDate: { lte: day },
        endDate: { gte: day },
        mediaId: { not: null },
        OR: [{ cityIds: { isEmpty: true } }, ...(cityId ? [{ cityIds: { has: cityId } }] : [])],
      },
      select: { id: true, displayId: true, mediaId: true, headline: true, ctaLabel: true, targetUrl: true, cityIds: true },
      take: 50,
    });
  },

  async pagePaths(keys) {
    if (keys.length === 0) return new Map();
    const pages = await prisma.sitePage.findMany({
      where: { key: { in: keys }, archivedAt: null, OR: [{ kind: 'SYSTEM' }, { versions: { some: { status: 'PUBLISHED' } } }] },
      select: { key: true, path: true },
    });
    return new Map(pages.map((page) => [page.key, page.path]));
  },
};
