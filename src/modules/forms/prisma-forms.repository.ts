import { prisma, type Prisma } from '../../shared/database';
import type { FormsRepository, SubmissionFilter } from './forms.repository';

function submissionWhere(formId: string, filter: SubmissionFilter): Prisma.FormSubmissionWhereInput {
  const where: Prisma.FormSubmissionWhereInput = { formId };
  if (filter.status) where.status = filter.status;
  if (filter.cityId) where.cityId = filter.cityId;
  if (filter.from || filter.to) where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) };
  return where;
}

export const prismaFormsRepository: FormsRepository = {
  list() {
    return prisma.form.findMany({ orderBy: [{ archivedAt: 'asc' }, { title: 'asc' }] });
  },

  byKey(key) {
    return prisma.form.findUnique({ where: { key } });
  },

  create(data) {
    return prisma.form.create({ data });
  },

  update(id, data) {
    return prisma.form.update({ where: { id }, data });
  },

  async newSubmissionCounts() {
    const groups = await prisma.formSubmission.groupBy({ by: ['formId'], where: { status: 'NEW' }, _count: { _all: true } });
    return new Map(groups.map((group) => [group.formId, group._count._all]));
  },

  currentVersions() {
    return prisma.formVersion.findMany({ where: { status: { in: ['PUBLISHED', 'DRAFT'] } } });
  },

  live(formId) {
    return prisma.formVersion.findFirst({ where: { formId, status: 'PUBLISHED' }, orderBy: { number: 'desc' } });
  },

  draft(formId) {
    return prisma.formVersion.findFirst({ where: { formId, status: 'DRAFT' }, orderBy: { number: 'desc' } });
  },

  byNumber(formId, number) {
    return prisma.formVersion.findUnique({ where: { formId_number: { formId, number } } });
  },

  versions(formId) {
    return prisma.formVersion.findMany({ where: { formId }, orderBy: { number: 'desc' } });
  },

  async highestNumber(formId) {
    const top = await prisma.formVersion.findFirst({ where: { formId }, orderBy: { number: 'desc' }, select: { number: true } });
    return top?.number ?? 0;
  },

  createDraft(data) {
    return prisma.formVersion.create({ data: { ...data, status: 'DRAFT' } });
  },

  updateDraft(id, data) {
    return prisma.formVersion.update({ where: { id }, data });
  },

  async deleteDraft(id) {
    await prisma.formVersion.delete({ where: { id } });
  },

  async publishDraft(id, formId, by, at, changeNote) {
    const [, row] = await prisma.$transaction([
      prisma.formVersion.updateMany({ where: { formId, status: 'PUBLISHED', id: { not: id } }, data: { status: 'RETIRED', retiredAt: at } }),
      prisma.formVersion.update({
        where: { id },
        data: { status: 'PUBLISHED', publishedAt: at, publishedById: by, ...(changeNote !== null ? { changeNote } : {}) },
      }),
    ]);
    return row;
  },

  async publishCopy(data) {
    const [, row] = await prisma.$transaction([
      prisma.formVersion.updateMany({ where: { formId: data.formId, status: 'PUBLISHED' }, data: { status: 'RETIRED', retiredAt: data.at } }),
      prisma.formVersion.create({
        data: {
          formId: data.formId,
          number: data.number,
          status: 'PUBLISHED',
          definition: data.definition,
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

  citiesByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  },

  citiesByIdsOrNames(values) {
    if (values.length === 0) return Promise.resolve([]);
    return prisma.city.findMany({
      where: { OR: [{ id: { in: values } }, { name: { in: values, mode: 'insensitive' } }] },
      select: { id: true, name: true },
    });
  },

  createSubmission(data) {
    return prisma.formSubmission.create({ data });
  },

  updateSubmission(id, data) {
    return prisma.formSubmission.update({ where: { id }, data });
  },

  submission(formId, id) {
    return prisma.formSubmission.findFirst({ where: { id, formId } });
  },

  async listSubmissions(formId, filter, slice) {
    const where = submissionWhere(formId, filter);
    const [items, total] = await Promise.all([
      prisma.formSubmission.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: slice.skip, take: slice.take }),
      prisma.formSubmission.count({ where }),
    ]);
    return { items, total };
  },

  submissionsInBox(formId, box, limit) {
    return prisma.formSubmission.findMany({
      where: {
        formId,
        status: { not: 'ARCHIVED' },
        latitude: { gte: box.south, lte: box.north },
        longitude: { gte: box.west, lte: box.east },
      },
      select: { id: true, latitude: true, longitude: true, contactName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};
