import { prisma } from '../../shared/database';
import type { SitePagesRepository } from './site-pages.repository';

/**
 * `LayoutVersion` belongs to `layouts`; the one read here — which surfaces
 * and pages have a PUBLISHED or DRAFT row — is the desk's overview and the
 * routing table's "is this page live", read whole (a few dozen rows at most).
 */
export const prismaSitePagesRepository: SitePagesRepository = {
  async listPages() {
    const rows = await prisma.sitePage.findMany({ include: { _count: { select: { redirects: true } } }, orderBy: [{ kind: 'asc' }, { title: 'asc' }] });
    return rows.map(({ _count, ...page }) => ({ ...page, redirectCount: _count.redirects }));
  },

  findByKey(key) {
    return prisma.sitePage.findUnique({ where: { key } });
  },

  pageAtPath(path) {
    return prisma.sitePage.findUnique({ where: { path } });
  },

  createPage(data) {
    return prisma.sitePage.create({ data: { ...data, kind: 'CUSTOM' } });
  },

  updatePage(id, patch) {
    return prisma.sitePage.update({ where: { id }, data: patch });
  },

  currentVersions() {
    return prisma.layoutVersion.findMany({
      where: { status: { in: ['PUBLISHED', 'DRAFT'] } },
      select: { surface: true, pageId: true, number: true, status: true, meta: true, publishedAt: true, updatedAt: true },
    });
  },

  listRedirects() {
    return prisma.siteRedirect.findMany({ include: { page: { select: { key: true, title: true } } }, orderBy: { createdAt: 'desc' } });
  },

  findRedirect(id) {
    return prisma.siteRedirect.findUnique({ where: { id } });
  },

  redirectFrom(fromPath) {
    return prisma.siteRedirect.findUnique({ where: { fromPath } });
  },

  createRedirect(data) {
    return prisma.siteRedirect.create({ data });
  },

  async deleteRedirect(id) {
    await prisma.siteRedirect.delete({ where: { id } });
  },

  changeAddress({ pageId, oldPath, newPath, by, dropRedirectId }) {
    return prisma.$transaction(async (tx) => {
      if (dropRedirectId) await tx.siteRedirect.delete({ where: { id: dropRedirectId } });
      const retargeted = await tx.siteRedirect.updateMany({ where: { toPath: oldPath }, data: { toPath: newPath } });
      const page = await tx.sitePage.update({ where: { id: pageId }, data: { path: newPath } });
      await tx.siteRedirect.create({ data: { fromPath: oldPath, toPath: newPath, pageId, permanent: true, reason: 'ADDRESS_CHANGE', createdByUserId: by } });
      return { page, retargeted: retargeted.count };
    });
  },
};
