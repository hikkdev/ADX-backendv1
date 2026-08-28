import type { AppConfig } from '../../shared/database';

/** The whole application config lives in a single row keyed 'main'. */
export const CONFIG_KEY = 'main';

/** A second row, mapping listing category -> default milestone plan id. */
export const CATEGORY_PLANS_KEY = 'categoryPlans';

export interface AppConfigRepository {
  find(): Promise<AppConfig | null>;
  findByKey(key: string): Promise<AppConfig | null>;
  save(value: object): Promise<AppConfig>;
}
