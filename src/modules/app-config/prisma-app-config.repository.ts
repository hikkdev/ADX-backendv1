import { Prisma, prisma } from '../../shared/database';
import { CONFIG_KEY, type AppConfigRepository } from './app-config.repository';

export const prismaAppConfigRepository: AppConfigRepository = {
  find() {
    return prisma.appConfig.findUnique({ where: { key: CONFIG_KEY } });
  },

  findByKey(key: string) {
    return prisma.appConfig.findUnique({ where: { key } });
  },

  save(value: object) {
    return this.saveByKey(CONFIG_KEY, value);
  },

  saveByKey(key: string, value: object) {
    return prisma.appConfig.upsert({
      where: { key },
      update: { value: value as Prisma.InputJsonValue },
      create: { key, value: value as Prisma.InputJsonValue },
    });
  },

  listByPrefix(prefix: string) {
    return prisma.appConfig.findMany({ where: { key: { startsWith: prefix } }, orderBy: { key: 'asc' } });
  },

  async deleteByKey(key: string) {
    await prisma.appConfig.deleteMany({ where: { key } });
  },
};
