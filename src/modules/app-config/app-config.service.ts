import { APP_ENUMS } from './app-enums';
import { prismaAppConfigRepository as repository } from './prisma-app-config.repository';

/**
 * Served when no config row has been written yet, so a fresh install still
 * boots the agent app with a usable set of enums.
 */
const FALLBACK_CONFIG = {
  enums: APP_ENUMS,
  flows: {},
};

export async function getAppConfig(): Promise<object> {
  const row = await repository.find();
  return row ? (row.value as object) : FALLBACK_CONFIG;
}

export async function saveAppConfig(value: object) {
  const row = await repository.save(value);
  return row.value;
}
