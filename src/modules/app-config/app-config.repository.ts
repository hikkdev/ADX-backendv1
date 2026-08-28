import type { AppConfig } from '../../shared/database';

/** The whole application config lives in a single row keyed 'main'. */
export const CONFIG_KEY = 'main';

export interface AppConfigRepository {
  find(): Promise<AppConfig | null>;
  save(value: object): Promise<AppConfig>;
}
