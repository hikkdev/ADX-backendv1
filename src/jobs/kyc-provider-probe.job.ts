import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { logActivity } from '../shared/audit';
import { runDigioProbe } from '../shared/vendors';
import { listAdminUserIds, systemUserId } from '../modules/users';
import { createNotification } from '../modules/notifications';

const TAG = 'kycProviderProbeJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:kyc-provider-probe-tick';
// Shorter than the interval, so an instance that dies mid-probe clears its own lock.
const LOCK_TTL_MS = 4 * 60 * 1000;
/**
 * ActivityLog.userId is a foreign key, so a job's rows are attributed to the
 * system account (E6: `users.systemUserId`, `ADX system`, inactive, no
 * roles) with `metadata.by` naming the automation. Only when that account
 * cannot be reached does the first admin stand in, as before E6; nobody at
 * all means no row — and a warning, because a deployment with no admin has
 * bigger problems than a missing audit line.
 */
export async function jobActor(tag: string): Promise<string | null> {
  const system = await systemUserId();
  if (system) return system;
  const [first] = await listAdminUserIds();
  if (!first) logger.warn('No admin user to attribute a job audit row to', { tag });
  return first ?? null;
}

export let kycProviderProbeInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The Digio probe, every five minutes — Lot D (Q129).
 *
 * One instance per tick (Redis lock). A failing probe flips the provider
 * switch DIGIO → DEGRADED and every admin hears about it; a passing probe
 * flips it back and they hear that too. MANUAL is ops' own switch and the
 * probe never moves it. The switch lives in the integrations row, read by
 * every Digio initiate and restart through `shared/integrations`.
 */
export async function kycProviderProbeTick(): Promise<void> {
  recordHeartbeat('kyc-provider-probe');
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const { verdict, change } = await runDigioProbe();
    if (!change) return;

    const adminIds = await listAdminUserIds();
    const actor = await jobActor(TAG);
    if (actor) {
      await logActivity(actor, 'KYC_PROVIDER_CHANGED', {
        targetType: 'AppConfig',
        targetId: 'integrations',
        module: 'integrations',
        diff: { kycProvider: { before: change.from, after: change.to } },
        metadata: { by: TAG, detail: verdict.detail ?? null, latencyMs: verdict.latencyMs },
      });
    }

    const degraded = change.to === 'DEGRADED';
    await Promise.all(
      adminIds.map((userId) =>
        createNotification({
          userId,
          type: 'SYSTEM',
          title: degraded ? 'Digio is not answering — KYC degraded' : 'Digio is back — KYC restored',
          subtitle: `Provider switch: ${change.from} → ${change.to}`,
          message: degraded
            ? `The Digio probe failed (${verdict.detail ?? 'no detail'}). New Digio checks answer 503 and the apps offer the manual upload path until the probe passes again, or until you set the switch to MANUAL.`
            : `The Digio probe passed after ${verdict.latencyMs} ms. Digio checks are being accepted again.`,
          suggestedAction: 'Open Settings → Integrations → KYC',
          relatedId: 'integrations',
        }),
      ),
    );
    logger.warn('KYC provider switch moved', { tag: TAG, ...change, notified: adminIds.length });
  } catch (err) {
    logger.error('kycProviderProbeJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startKycProviderProbeJob(): void {
  kycProviderProbeInterval = setInterval(() => void kycProviderProbeTick(), INTERVAL_MS);
}
