import { z } from 'zod';
import { PARTY_TYPES, SCOPES_BY_PARTY } from './suspension.service';

/**
 * What a suspension request may say.
 *
 * The reason is required and bounded on both ends. A suspension with no stated
 * reason is not reviewable six months later — the same rule the refund desk
 * keeps — and the table's own CHECK refuses a scope list without one, so a
 * blank reason would be a 500 rather than a 400 if it got this far.
 */

export const SUSPENSION_SCOPES = [
  'BLOCK_NEW',
  'STOP_OPEN_WORK',
  'STOP_ACCRUAL',
  'FREEZE_WALLET',
  'BLOCK_SIGNIN',
] as const;

export const reasonSchema = z.string().trim().min(3).max(500);

export const suspendBodySchema = z.object({
  /** Which sections. Validated against the party's own list in the service. */
  scopes: z.array(z.enum(SUSPENSION_SCOPES)).min(1).max(SUSPENSION_SCOPES.length),
  reason: reasonSchema,
});
export type SuspendBody = z.infer<typeof suspendBodySchema>;

export const reinstateBodySchema = z.object({
  /** Omitted or empty lifts everything the party is carrying. */
  scopes: z.array(z.enum(SUSPENSION_SCOPES)).max(SUSPENSION_SCOPES.length).optional(),
  reason: reasonSchema,
});
export type ReinstateBody = z.infer<typeof reinstateBodySchema>;

export const partyParamsSchema = z.object({
  partyType: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(PARTY_TYPES)),
  partyId: z.string().trim().min(1).max(64),
});

export const idParamSchema = z.object({ id: z.string().trim().min(1).max(64) });

/** What each party admits, for the console to draw the right checkboxes. */
export const admittedScopes = SCOPES_BY_PARTY;
