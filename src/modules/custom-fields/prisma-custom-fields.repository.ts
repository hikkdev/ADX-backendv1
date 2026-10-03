import { Prisma, prisma } from '../../shared/database';
import type { CustomFieldsRepository, DefOption } from './custom-fields.repository';

/** A definition's options as the column takes them: the list, or a JSON null where the kind has none. */
const optionsColumn = (options: DefOption[] | null) => (options === null ? Prisma.JsonNull : (options as unknown as Prisma.InputJsonValue));

export const prismaCustomFieldsRepository: CustomFieldsRepository = {
  listDefs(filter) {
    return prisma.customFieldDef.findMany({
      where: { ...(filter.entity ? { entity: filter.entity } : {}), ...(filter.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  },

  defById(id) {
    return prisma.customFieldDef.findUnique({ where: { id } });
  },

  defByKey(entity, key) {
    return prisma.customFieldDef.findUnique({ where: { entity_key: { entity, key } } });
  },

  createDef(data) {
    return prisma.customFieldDef.create({ data: { ...data, options: optionsColumn(data.options) } });
  },

  updateDef(id, data) {
    const { options, ...rest } = data;
    return prisma.customFieldDef.update({ where: { id }, data: { ...rest, ...(options !== undefined ? { options: optionsColumn(options) } : {}) } });
  },

  async entityExists(entity, entityId) {
    switch (entity) {
      case 'PUBLISHER':
        return Boolean(await prisma.publisher.findUnique({ where: { id: entityId }, select: { id: true } }));
      case 'ADVERTISER':
        return Boolean(await prisma.advertiser.findUnique({ where: { id: entityId }, select: { id: true } }));
      case 'LISTING':
        return Boolean(await prisma.listing.findUnique({ where: { id: entityId }, select: { id: true } }));
      case 'LEAD':
        return Boolean(await prisma.lead.findUnique({ where: { id: entityId }, select: { id: true } }));
      default:
        return false;
    }
  },

  valuesFor(entity, entityId) {
    return prisma.customFieldValue.findMany({ where: { entity, entityId } });
  },

  async writeValues(entity, entityId, writes, clears, byUserId) {
    await prisma.$transaction([
      ...writes.map((write) =>
        prisma.customFieldValue.upsert({
          where: { defId_entityId: { defId: write.defId, entityId } },
          create: { defId: write.defId, entity, entityId, value: write.value, updatedByUserId: byUserId },
          update: { value: write.value, updatedByUserId: byUserId },
        }),
      ),
      ...(clears.length ? [prisma.customFieldValue.deleteMany({ where: { entityId, defId: { in: clears } } })] : []),
    ]);
  },
};
