import type { AppConfig } from '../../shared/database';

/** The whole application config lives in a single row keyed 'main'. */
export const CONFIG_KEY = 'main';

/** A second row, mapping listing category -> default milestone plan id. */
export const CATEGORY_PLANS_KEY = 'categoryPlans';

/** A third: what a build must know before it can run. See app-status.ts. */
export const APP_STATUS_KEY = 'app-status';

/** The `main` row as it was before the last PUT, so a bad flow edit can be undone. */
export const PREVIOUS_CONFIG_KEY = 'main:previous';

/**
 * A flow as it was before a PATCH bumped it: `flows.<key>:v<N>` (Q83). A
 * party mid-ladder is served the version they started from; the last
 * `FLOW_SNAPSHOTS_KEPT` are kept per flow.
 */
export const flowSnapshotKey = (flow: string, version: number) => `flows.${flow}:v${version}`;
export const flowSnapshotPrefix = (flow: string) => `flows.${flow}:v`;
export const FLOW_SNAPSHOTS_KEPT = 5;

export interface AppConfigRepository {
  find(): Promise<AppConfig | null>;
  findByKey(key: string): Promise<AppConfig | null>;
  save(value: object): Promise<AppConfig>;
  /** Any of the module's rows, by key. */
  saveByKey(key: string, value: object): Promise<AppConfig>;
  /** The rows whose key starts with `prefix` — the flow snapshots. */
  listByPrefix(prefix: string): Promise<AppConfig[]>;
  deleteByKey(key: string): Promise<void>;
}
