import { z } from 'zod';
import { prismaUsersRepository as repository } from './prisma-users.repository';

/**
 * What a person has decided about their own account — DR 07 wave 5.
 *
 * Key/value rather than a column per switch: the Privacy and App Preferences
 * frames draw nine between them, more will follow, and none of them is a
 * platform record. Namespaced so a reader knows which screen owns a key.
 *
 * Every key has a default, and an unsaved key reads as that default rather
 * than as null. So a new switch ships without a migration and without a
 * screen having to decide what "not set" means.
 */

export const PREFERENCE_KEYS = {
  /* Privacy (Figma 4453:91) */
  'privacy.showName': { default: true as boolean | string },
  'privacy.showPhoto': { default: true as boolean | string },
  /** never · duringJobs · always. The runtime permission is a separate thing. */
  'privacy.locationSharing': { default: 'duringJobs' as boolean | string },
  'privacy.backgroundLocation': { default: false as boolean | string },
  'privacy.personalisedTips': { default: true as boolean | string },

  /* App preferences (Figma 4453:211) */
  /** system · light · dark. The tokens read the system today; see the screen. */
  'app.theme': { default: 'system' as boolean | string },
  'app.sounds': { default: true as boolean | string },
  'app.haptics': { default: true as boolean | string },
  'app.dataSaver': { default: false as boolean | string },
  /** standard · satellite · terrain. */
  'app.mapStyle': { default: 'standard' as boolean | string },

  /* Quiet hours (Figma 4453:31) */
  'notifications.doNotDisturb': { default: false as boolean | string },
  /** "22:00-07:00", the window the frame prints under Do not disturb. */
  'notifications.quietHours': { default: '22:00-07:00' as boolean | string },
  'notifications.weekendMode': { default: false as boolean | string },
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_KEYS;
export const PREFERENCE_KEY_LIST = Object.keys(PREFERENCE_KEYS) as PreferenceKey[];

/** A switch or a short choice. Nothing here is a document. */
const preferenceValue = z.union([z.boolean(), z.string().trim().max(64)]);

/**
 * A patch, not the whole map: a screen saves the switch that moved.
 *
 * An object rather than `z.record` with an enum key — that form is exhaustive
 * in zod 4 and would demand every key on every save.
 */
const shape = Object.fromEntries(
  PREFERENCE_KEY_LIST.map((key) => [key, preferenceValue.optional()]),
) as { [K in PreferenceKey]: z.ZodOptional<typeof preferenceValue> };

export const savePreferencesSchema = z
  .object(shape)
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: 'Nothing to save' });

export type PreferenceMap = Record<PreferenceKey, boolean | string>;

/** Every key, saved or not. */
export async function getUserPreferences(userId: string): Promise<PreferenceMap> {
  const saved = await repository.findPreferences(userId);
  const map = {} as PreferenceMap;
  for (const key of PREFERENCE_KEY_LIST) {
    const row = saved.find((entry) => entry.key === key);
    const value = row?.value;
    map[key] = typeof value === 'boolean' || typeof value === 'string' ? value : PREFERENCE_KEYS[key].default;
  }
  return map;
}

/**
 * E11-1: what `GET /users/me/preferences` answers — the map, and beside it
 * `emailUnsubscribedAt`, the one account fact the Notifications screen prints
 * next to its switches. Not a preference key: it is stamped by the public
 * unsubscribe link and cleared by `POST /users/me/email-resubscribe`, never
 * by the preference save.
 */
export type PreferencesView = PreferenceMap & { emailUnsubscribedAt: Date | null };

export async function getPreferencesView(userId: string): Promise<PreferencesView> {
  const [map, user] = await Promise.all([getUserPreferences(userId), repository.findById(userId)]);
  return { ...map, emailUnsubscribedAt: user?.emailUnsubscribedAt ?? null };
}

export async function saveUserPreferences(
  userId: string,
  patch: Partial<Record<PreferenceKey, boolean | string>>,
): Promise<PreferenceMap> {
  await Promise.all(
    Object.entries(patch).map(([key, value]) =>
      repository.upsertPreference(userId, key, value as boolean | string),
    ),
  );
  return getUserPreferences(userId);
}
