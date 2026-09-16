import type { DeviceApp, DevicePlatform, DeviceToken } from '../../../shared/database';

/**
 * Persistence seam for the push half of the module — G6 (Q103/133).
 *
 * A `DeviceToken` is one phone's FCM registration. The token is unique across
 * the table on purpose: a phone that signs out and signs in as somebody else
 * moves its token to the new login rather than leaving the old one able to
 * receive their notices.
 */

export interface RegisterDeviceInput {
  userId: string;
  token: string;
  app: DeviceApp;
  platform: DevicePlatform;
  appVersion?: string | null | undefined;
}

export interface RegisterDeviceResult {
  row: DeviceToken;
  /** True when the row was written for the first time. */
  created: boolean;
  /** The login the token belonged to before this call, when it was somebody else. */
  movedFromUserId: string | null;
}

export interface PushRepository {
  /** Upsert on `token`: a fresh row, a refresh of `lastSeenAt` / `appVersion`, or the token moving to this login. */
  register(input: RegisterDeviceInput, now: Date): Promise<RegisterDeviceResult>;
  /** The caller's own row only; false when the token is not theirs (or not on file). */
  remove(userId: string, token: string): Promise<boolean>;
  /** A token FCM said is UNREGISTERED, whoever holds it. */
  removeByToken(token: string): Promise<boolean>;
  listForUser(userId: string): Promise<DeviceToken[]>;
  /** One slice of every device on file, keyset by id, for the flag broadcast. */
  listAll(afterId: string | null, take: number): Promise<DeviceToken[]>;
  countAll(): Promise<number>;
}
