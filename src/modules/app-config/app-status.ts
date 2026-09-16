import { z } from 'zod';
import { APP_STATUS_KEY } from './app-config.repository';
import { prismaAppConfigRepository as repository } from './prisma-app-config.repository';

/**
 * What an app must know before it can do anything: whether this build is still
 * supported, whether ADX is up, and how each service is faring.
 *
 * Public and unauthenticated on purpose — a force-update gate that needs a
 * token is useless, because an out-of-date build may not be able to sign in,
 * and a maintenance window is exactly when the token endpoint is down.
 *
 * Kept in a second `AppConfig` row (`app-status`) rather than a table, the way
 * `categoryPlans` is: it is one small document ops edit, not a set of records.
 */

export const SERVICE_KEYS = ['orders', 'payments', 'maps', 'qr', 'notifications', 'kyc'] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

export const SERVICE_LABEL: Record<ServiceKey, string> = {
  orders: 'Orders and offers',
  payments: 'Payments and payouts',
  maps: 'Maps and navigation',
  qr: 'QR verification',
  notifications: 'Notifications',
  // Lot D (Q129): identity verification — Digio, and the manual desk behind it.
  kyc: 'Identity verification',
};

export type ServiceState = 'UP' | 'DEGRADED' | 'DOWN';

const buildSchema = z.object({ android: z.number().int().min(0), ios: z.number().int().min(0) });

export const appStatusSchema = z.object({
  minimumBuild: buildSchema,
  latestBuild: buildSchema,
  storeUrl: z.object({ android: z.string().url(), ios: z.string().url() }),
  maintenance: z.object({
    active: z.boolean(),
    message: z.string().trim().max(500).optional(),
    /** ISO. What the Back soon screen prints as "until". */
    until: z.string().datetime().optional(),
  }),
  /** The incident banner above the services list. Absent when there is none. */
  incident: z
    .object({
      title: z.string().trim().min(1).max(120),
      message: z.string().trim().min(1).max(500),
      since: z.string().datetime().optional(),
      severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('WARNING'),
    })
    .nullable()
    .optional(),
  services: z
    .array(
      z.object({
        key: z.enum(SERVICE_KEYS),
        label: z.string().trim().min(1).max(60),
        state: z.enum(['UP', 'DEGRADED', 'DOWN']),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .max(20),
});

export type AppStatus = z.infer<typeof appStatusSchema>;

/**
 * What a fresh install gets before ops have written the row: every build
 * supported, nothing under maintenance, every service up. The safe answer —
 * a default that locked people out of an app nobody had configured would be
 * the worst possible failure of this endpoint.
 */
export const DEFAULT_APP_STATUS: AppStatus = {
  minimumBuild: { android: 0, ios: 0 },
  latestBuild: { android: 0, ios: 0 },
  storeUrl: {
    android: 'https://play.google.com/store/apps/details?id=in.adx.agent',
    ios: 'https://apps.apple.com/in/app/adx/id0000000000',
  },
  maintenance: { active: false },
  incident: null,
  services: SERVICE_KEYS.map((key) => ({ key, label: SERVICE_LABEL[key], state: 'UP' as const })),
};

export async function getAppStatus(): Promise<AppStatus & { updatedAt: string }> {
  const row = await repository.findByKey(APP_STATUS_KEY);
  const parsed = appStatusSchema.safeParse(row?.value);
  // A row that does not parse is a row ops half-wrote. Serving the safe
  // default beats serving a partial one, which could lock every build out.
  const status = parsed.success ? parsed.data : DEFAULT_APP_STATUS;
  return { ...status, updatedAt: (row?.updatedAt ?? new Date()).toISOString() };
}

export async function saveAppStatus(value: AppStatus): Promise<AppStatus & { updatedAt: string }> {
  const row = await repository.saveByKey(APP_STATUS_KEY, value);
  return { ...(row.value as AppStatus), updatedAt: row.updatedAt.toISOString() };
}

/** Which gate a build falls into. Build 0 means "unknown", which never blocks. */
export function gateFor(
  status: Pick<AppStatus, 'minimumBuild' | 'latestBuild' | 'maintenance'>,
  platform: 'android' | 'ios',
  build: number,
): 'FORCE_UPDATE' | 'MAINTENANCE' | 'UPDATE_AVAILABLE' | 'OK' {
  if (build > 0 && build < status.minimumBuild[platform]) return 'FORCE_UPDATE';
  if (status.maintenance.active) return 'MAINTENANCE';
  if (build > 0 && build < status.latestBuild[platform]) return 'UPDATE_AVAILABLE';
  return 'OK';
}
