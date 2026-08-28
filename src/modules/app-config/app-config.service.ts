import { APP_ENUMS } from './app-enums';
import { CATEGORY_PLANS_KEY } from './app-config.repository';
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

/**
 * Default milestone plan for a listing category, from the `categoryPlans`
 * config row. Returns null when unset or malformed rather than throwing —
 * milestone auto-assignment treats "no plan" as "nothing to do".
 */
export async function getCategoryPlanId(category: string): Promise<string | null> {
  const row = await repository.findByKey(CATEGORY_PLANS_KEY);
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[category];
  return typeof candidate === 'string' ? candidate : null;
}
