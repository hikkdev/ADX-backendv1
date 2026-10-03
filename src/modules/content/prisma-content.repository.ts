import { prisma } from '../../shared/database';
import type { ContentFilter, ContentRepository } from './content.repository';
import type { NewPage, PagePatch } from './content.types';

export const prismaContentRepository: ContentRepository = {
  list(slug) {
    return prisma.contentPage.findMany({
      where: slug ? { slug } : {},
      orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    });
  },

  findById(id) {
    return prisma.contentPage.findUnique({ where: { id } });
  },

  active(slug) {
    return prisma.contentPage.findFirst({ where: { slug, isActive: true } });
  },

  activeAll(filter: ContentFilter) {
    return prisma.contentPage.findMany({
      where: {
        isActive: true,
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.surface ? { surfaces: { has: filter.surface } } : {}),
        ...(filter.tag ? { tags: { has: filter.tag } } : {}),
      },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }],
    });
  },

  async highestVersion(slug) {
    const top = await prisma.contentPage.findFirst({ where: { slug }, orderBy: { version: 'desc' }, select: { version: true } });
    return top?.version ?? 0;
  },

  create(data: NewPage) {
    return prisma.contentPage.create({ data });
  },

  update(id, patch: PagePatch) {
    return prisma.contentPage.update({ where: { id }, data: patch });
  },

  async delete(id) {
    await prisma.contentPage.delete({ where: { id } });
  },

  async publish(id, slug, at) {
    const [, row] = await prisma.$transaction([
      prisma.contentPage.updateMany({
        where: { slug, isActive: true, id: { not: id } },
        data: { isActive: false, retiredAt: at },
      }),
      prisma.contentPage.update({
        where: { id },
        data: { isActive: true, publishedAt: at, retiredAt: null },
      }),
    ]);
    return row;
  },

  unpublish(id, at) {
    return prisma.contentPage.update({ where: { id }, data: { isActive: false, retiredAt: at } });
  },
};
