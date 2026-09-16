import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { logger } from '../../../shared/logging';
import { fcm, type PushMessage, type PushSendResult } from '../../../shared/push';
import type { DeviceToken } from '../../../shared/database';
import { prismaPushRepository as repository } from './prisma-push.repository';
import type { RegisterDeviceInput } from './push.repository';

/**
 * Push — G6 (Q103/133).
 *
 * Two halves. The device registry: a phone hands its FCM token in on every
 * boot (`PUT /users/me/devices`), the row follows the login, and a sign-out
 * takes it back. The sender: one message to every device a person holds,
 * through `shared/push/fcm`, deleting a row the moment FCM says the token is
 * UNREGISTERED — a stale token is not something to retry.
 *
 * Absent Firebase configuration every send is `{ skipped }` and nothing here
 * treats that as an error: the dispatcher marks the delivery SKIPPED and the
 * flag broadcast logs the count it would have reached.
 */

export type DeviceView = {
  id: string;
  app: DeviceToken['app'];
  platform: DeviceToken['platform'];
  appVersion: string | null;
  /** The token's last six characters — enough for a phone to recognise itself, never the whole credential. */
  tokenSuffix: string;
  lastSeenAt: Date;
  createdAt: Date;
};

export const toDeviceView = (row: DeviceToken): DeviceView => ({
  id: row.id,
  app: row.app,
  platform: row.platform,
  appVersion: row.appVersion,
  tokenSuffix: row.token.slice(-6),
  lastSeenAt: row.lastSeenAt,
  createdAt: row.createdAt,
});

/* ── the registry ────────────────────────────────────────────────── */

export async function registerDevice(input: RegisterDeviceInput, req?: Request, now = new Date()): Promise<{ device: DeviceView; created: boolean; moved: boolean }> {
  const result = await repository.register(input, now);
  // A refresh on every app boot is not an event; a new phone or a phone that
  // changed hands is.
  if (result.created || result.movedFromUserId) {
    await logActivity(input.userId, result.movedFromUserId ? 'DEVICE_MOVED' : 'DEVICE_REGISTERED', {
      req,
      targetType: 'DeviceToken',
      targetId: result.row.id,
      module: 'notifications',
      metadata: { app: input.app, platform: input.platform, appVersion: input.appVersion ?? null, movedFromUserId: result.movedFromUserId },
    });
  }
  return { device: toDeviceView(result.row), created: result.created, moved: result.movedFromUserId !== null };
}

/** 404 rather than 403 when the token is somebody else's: a token is a credential, and "not yours" would confirm it exists. */
export async function removeDevice(userId: string, token: string, req?: Request): Promise<void> {
  const removed = await repository.remove(userId, token);
  if (!removed) throw new ApiError(404, 'NOT_FOUND', 'No such device on this account');
  await logActivity(userId, 'DEVICE_REMOVED', { req, targetType: 'DeviceToken', targetId: token.slice(-6), module: 'notifications' });
}

export async function listDevices(userId: string): Promise<DeviceView[]> {
  return (await repository.listForUser(userId)).map(toDeviceView);
}

/* ── sending ─────────────────────────────────────────────────────── */

export type PushSkipReason = 'FCM_NOT_CONFIGURED' | 'FCM_MISCONFIGURED' | 'NO_DEVICE';

export interface PushOutcome {
  /** How many devices were on file when the send started. */
  devices: number;
  sent: number;
  /** Rows FCM said would never deliver again; deleted. */
  unregistered: number;
  /** Failures worth a retry — the rail was down, the quota hit, the token mint refused. */
  retryable: number;
  /** Failures not worth one — a malformed token, an answer FCM did not explain. */
  failed: number;
  skipped: PushSkipReason | null;
  /** Per device, for the attempt log. Never carries the token itself. */
  results: { deviceId: string; tokenSuffix: string; ok: boolean; messageId?: string; error?: string; status?: number }[];
  /** The first message id FCM handed back, for the delivery row. */
  messageId: string | null;
}

const RETRYABLE = new Set(['UNAVAILABLE', 'QUOTA', 'UNAUTHENTICATED']);

function emptyOutcome(devices: number, skipped: PushSkipReason | null): PushOutcome {
  return { devices, sent: 0, unregistered: 0, retryable: 0, failed: 0, skipped, results: [], messageId: null };
}

/** One message to every device of a set. A stale token deletes its row. A network failure counts as retryable. */
export async function sendToDevices(devices: DeviceToken[], message: PushMessage): Promise<PushOutcome> {
  if (devices.length === 0) return emptyOutcome(0, 'NO_DEVICE');
  const outcome = emptyOutcome(devices.length, null);
  for (const device of devices) {
    let result: PushSendResult;
    try {
      result = await fcm.send(device.token, message);
    } catch (err) {
      outcome.retryable += 1;
      outcome.results.push({ deviceId: device.id, tokenSuffix: device.token.slice(-6), ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      continue;
    }
    if (result.skipped) {
      // Not configured: the same answer for every device; say so once and stop.
      return emptyOutcome(devices.length, result.reason);
    }
    if (result.ok) {
      outcome.sent += 1;
      outcome.messageId ??= result.messageId || null;
      outcome.results.push({ deviceId: device.id, tokenSuffix: device.token.slice(-6), ok: true, messageId: result.messageId });
      continue;
    }
    outcome.results.push({ deviceId: device.id, tokenSuffix: device.token.slice(-6), ok: false, error: result.error, status: result.status });
    if (result.error === 'UNREGISTERED') {
      outcome.unregistered += 1;
      await repository.removeByToken(device.token).catch((err: unknown) => logger.warn('Could not remove an unregistered device token', { deviceId: device.id, reason: String(err) }));
    } else if (RETRYABLE.has(result.error)) {
      outcome.retryable += 1;
    } else {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/** Every device the person holds. */
export async function sendPushToUser(userId: string, message: PushMessage): Promise<PushOutcome> {
  const devices = await repository.listForUser(userId);
  return sendToDevices(devices, message);
}

/* ── the flag broadcast ──────────────────────────────────────────── */

export const FLAGS_CHANGED_TYPE = 'FLAGS_CHANGED';
const BROADCAST_BATCH = 500;

export interface BroadcastOutcome {
  devices: number;
  sent: number;
  unregistered: number;
  failed: number;
  skipped: PushSkipReason | null;
}

/**
 * A silent data push to every device on file — `{ type: 'FLAGS_CHANGED', key }`
 * — so a kill switch reaches a phone without waiting for its next cold start.
 * The apps answer it by re-reading `/app/flags`; nothing is decided from the
 * payload itself. Walked by keyset in batches of 500 so a fleet of any size
 * neither loads at once nor skips a row that arrived mid-walk.
 */
export async function broadcastFlagsChanged(detail: { key?: string; changeId?: string } = {}): Promise<BroadcastOutcome> {
  const data: Record<string, string> = { type: FLAGS_CHANGED_TYPE, at: new Date().toISOString() };
  if (detail.key) data['key'] = detail.key;
  if (detail.changeId) data['changeId'] = detail.changeId;
  const message: PushMessage = { data, contentAvailable: true };

  const tally: BroadcastOutcome = { devices: 0, sent: 0, unregistered: 0, failed: 0, skipped: null };
  if (!fcm.isConfigured()) {
    tally.devices = await repository.countAll();
    tally.skipped = 'FCM_NOT_CONFIGURED';
    logger.info('Flag change push skipped: FCM is not configured', { devices: tally.devices, key: detail.key ?? null });
    return tally;
  }

  let afterId: string | null = null;
  for (;;) {
    const batch: DeviceToken[] = await repository.listAll(afterId, BROADCAST_BATCH);
    if (batch.length === 0) break;
    const outcome = await sendToDevices(batch, message);
    tally.devices += batch.length;
    tally.sent += outcome.sent;
    tally.unregistered += outcome.unregistered;
    tally.failed += outcome.failed + outcome.retryable;
    if (outcome.skipped) {
      tally.skipped = outcome.skipped;
      break;
    }
    if (batch.length < BROADCAST_BATCH) break;
    afterId = batch[batch.length - 1]!.id;
  }
  logger.info('Flag change pushed', { key: detail.key ?? null, ...tally });
  return tally;
}
