import { Prisma, prisma } from '../../shared/database';
import type { LegalRepository } from './legal.repository';
import type { DocumentPatch, LegalDocumentKind, NewDocument } from './legal.types';

const json = (value: unknown) =>
  value === undefined ? undefined : value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

export const prismaLegalRepository: LegalRepository = {
  list(kind) {
    return prisma.legalDocument.findMany({
      where: kind ? { kind } : {},
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    });
  },

  findById(id) {
    return prisma.legalDocument.findUnique({ where: { id } });
  },

  active(kind) {
    return prisma.legalDocument.findFirst({ where: { kind, isActive: true } });
  },

  activeAll() {
    return prisma.legalDocument.findMany({ where: { isActive: true }, orderBy: { kind: 'asc' } });
  },

  async highestVersion(kind) {
    const top = await prisma.legalDocument.findFirst({ where: { kind }, orderBy: { version: 'desc' }, select: { version: true } });
    return top?.version ?? 0;
  },

  create(data: NewDocument) {
    return prisma.legalDocument.create({
      data: { ...data, meta: json(data.meta) ?? Prisma.JsonNull },
    });
  },

  update(id, patch: DocumentPatch) {
    const { meta, ...rest } = patch;
    return prisma.legalDocument.update({
      where: { id },
      data: { ...rest, ...(meta !== undefined ? { meta: json(meta) as Prisma.InputJsonValue } : {}) },
    });
  },

  async delete(id) {
    await prisma.legalDocument.delete({ where: { id } });
  },

  async activate(id, kind: LegalDocumentKind, at) {
    const [, row] = await prisma.$transaction([
      prisma.legalDocument.updateMany({
        where: { kind, isActive: true, id: { not: id } },
        data: { isActive: false, retiredAt: at },
      }),
      prisma.legalDocument.update({
        where: { id },
        data: { isActive: true, activatedAt: at, retiredAt: null, effectiveFrom: at },
      }),
    ]);
    return row;
  },

  count() {
    return prisma.legalDocument.count();
  },
};
