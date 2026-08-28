import { prisma } from '../../shared/database';
import { CONFIG_KEY, type AppConfigRepository } from './app-config.repository';

export const prismaAppConfigRepository: AppConfigRepository = {
  find() {
    return prisma.appConfig.findUnique({ where: { key: CONFIG_KEY } });
  },

  save(value: object) {
    return prisma.appConfig.upsert({
      where: { key: CONFIG_KEY },
      update: { value },
      create: { key: CONFIG_KEY, value },
    });
  },
};
