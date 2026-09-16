import { z } from 'zod';
import { upperEnum } from '../../../shared/validation';

/**
 * No 0/O, no 1/I — the alphabet of a code somebody reads off a screen and
 * types: the ten-character email code and (Lot K2) the recovery codes.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The channels an admin's second factor can arrive on. Lot K2 adds
 * AUTHENTICATOR — the code an app on the phone computes, nothing sent.
 */
export const TWO_FACTOR_METHODS = ['AUTHENTICATOR', 'SMS', 'EMAIL'] as const;
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

export const sendTwoFactorSchema = z.object({
  challengeToken: z.string().min(1),
  method: upperEnum(TWO_FACTOR_METHODS),
});

export const verifyTwoFactorSchema = z.object({
  challengeToken: z.string().min(1),
  // Six digits on SMS or the authenticator app, ten characters on email,
  // nine (XXXX-XXXX) on a recovery code — one field takes all, and the
  // service knows which it issued. Case is normalised there, not here.
  code: z.string().trim().min(4).max(16),
});

export type SendTwoFactorInput = z.infer<typeof sendTwoFactorSchema>;
export type VerifyTwoFactorInput = z.infer<typeof verifyTwoFactorSchema>;

/* ── Lot K2: the authenticator app ─────────────────────────────── */

/** Six digits, a space in the middle tolerated. */
export const totpCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'A six-digit code from the app'));

/** `XXXX-XXXX` from the email-code alphabet; the dash and case are forgiven. */
export const recoveryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(new RegExp(`^[${CODE_ALPHABET}]{8}$`), 'A recovery code is eight characters'));

export const confirmTotpSchema = z.object({ code: totpCodeSchema });

/** Disable takes either the app's code or a recovery code — one of the two, never neither. */
export const disableTotpSchema = z
  .object({
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((value) => value.code !== undefined || value.recoveryCode !== undefined, {
    message: 'Give the code from your app, or a recovery code',
    path: ['code'],
  });

export const regenerateRecoveryCodesSchema = z.object({ code: totpCodeSchema });

export type ConfirmTotpInput = z.infer<typeof confirmTotpSchema>;
export type DisableTotpInput = z.infer<typeof disableTotpSchema>;
