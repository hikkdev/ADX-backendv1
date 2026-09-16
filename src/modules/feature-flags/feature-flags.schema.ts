import { z } from 'zod';
import { FEATURE_KINDS, FEATURE_SURFACES } from '../../shared/features';

/**
 * Lot G (answer 146): who a rollout reaches, beyond the percentage.
 *
 * `userIds` is the allowlist — named accounts are on regardless of the rest;
 * `roles` and `cities` narrow the percentage bucket. Every list is optional
 * and an empty list means "no restriction on this axis", which is also what
 * `null` means for the whole object.
 */
export const rolloutSchema = z
  .object({
    roles: z.array(z.string().trim().regex(/^[A-Z][A-Z_]*$/, 'A role is upper-case')).max(20).optional(),
    cities: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
    userIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  })
  .strict();

export type RolloutInput = z.infer<typeof rolloutSchema>;

/**
 * A patch, not a replacement: naming only `enabled` leaves the rollout where
 * it is, naming only `variant` leaves the switch where it is. At least one of
 * the four has to be present, or the request is a no-op that would still
 * write a change row and overwrite `lastGoodState` with itself.
 */
const flagPatchFields = {
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  /** One of the row's `variants`, or null to run the default implementation. */
  variant: z.string().trim().min(1).max(64).nullable().optional(),
  /** The rollout rules, or null to clear them. */
  rollout: rolloutSchema.nullable().optional(),
};

const namesAField = {
  check: (body: { enabled?: unknown; rolloutPercent?: unknown; variant?: unknown; rollout?: unknown }) =>
    body.enabled !== undefined || body.rolloutPercent !== undefined || body.variant !== undefined || body.rollout !== undefined,
  message: 'Name enabled, rolloutPercent, variant or rollout',
};

export const setFlagSchema = z
  .object({
    ...flagPatchFields,
    note: z.string().trim().max(500).optional(),
  })
  .refine(namesAField.check, { message: namesAField.message });

export type SetFlagInput = z.infer<typeof setFlagSchema>;

export const rollbackFlagSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

/* ── L-B: the bulk write ─────────────────────────────────────────────── */

export const BULK_FLAG_KEYS_MAX = 200;

/** 1-200 distinct keys (a legacy alias is accepted, like `/:key`). */
const bulkKeysSchema = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(BULK_FLAG_KEYS_MAX)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'Every key once' });

/**
 * A bulk move without a reason is the thing an incident review cannot
 * reconstruct, so the note is required here where `/:key` leaves it
 * optional.
 */
const bulkNoteSchema = z.string().trim().min(4).max(500);

/** The same patch `PATCH /:key` takes, applied to every key named. */
export const bulkSetFlagsSchema = z.object({
  keys: bulkKeysSchema,
  patch: z.object(flagPatchFields).refine(namesAField.check, { message: namesAField.message }),
  note: bulkNoteSchema,
});

export type BulkSetFlagsInput = z.infer<typeof bulkSetFlagsSchema>;

export const bulkRollbackFlagsSchema = z.object({
  keys: bulkKeysSchema,
  note: bulkNoteSchema,
});

export type BulkRollbackFlagsInput = z.infer<typeof bulkRollbackFlagsSchema>;

/* ── L-B: the list's filters and page ────────────────────────────────── */

export const FLAG_STATES = ['ON', 'OFF', 'DARK_LAUNCH'] as const;
export type FlagStateFilter = (typeof FLAG_STATES)[number];

export const FLAG_SOURCES = ['REGISTERED', 'MANUAL'] as const;

export const MAX_FLAG_PAGE_SIZE = 500;

/**
 * `?surface=&kind=&source=&state=&owner=&q=` — the console's own filters,
 * evaluated server-side so a bulk selection can name "every key the filter
 * leaves" — and `?page&pageSize`, which switch the answer to the list
 * contract. No parameter: the bare array the console reads today.
 */
export const listFlagsQuerySchema = z.object({
  surface: z.enum(FEATURE_SURFACES).optional(),
  kind: z.enum(FEATURE_KINDS).optional(),
  source: z.enum(FLAG_SOURCES).optional(),
  state: z.enum(FLAG_STATES).optional(),
  owner: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_FLAG_PAGE_SIZE).optional(),
});

export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;
