import { z } from 'zod';

/**
 * Onboarding addresses (the owner, 1 Oct 2026): every onboarding flow has one
 * address search bar that fills the address all the way to the PIN code, and
 * plain boxes a person can still type into. These are the two boxes the
 * parties did not all have — the PIN code and the state.
 *
 * Both are optional and nullable on the wire; a blank box ("" or spaces) is
 * read as null, so a client that sends what the person left empty clears the
 * value instead of being refused.
 */

/** An Indian PIN code: six digits, never starting with 0. */
export const PIN_CODE_PATTERN = /^[1-9][0-9]{5}$/;
export const PIN_CODE_MESSAGE = 'A PIN code is six digits and does not start with 0 — 560001, say.';
export const ADDRESS_STATE_MAX = 80;

const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value);

/** `postalCode` / `currentPostalCode` — trimmed, six digits, null clears. */
export const pinCodeSchema = z.preprocess(blankToNull, z.string().trim().regex(PIN_CODE_PATTERN, PIN_CODE_MESSAGE).nullable()).optional();

/** A free-text state ("Karnataka") — trimmed, at most 80 characters, null clears. */
export const addressStateSchema = z
  .preprocess(blankToNull, z.string().trim().max(ADDRESS_STATE_MAX, `A state is at most ${ADDRESS_STATE_MAX} characters.`).nullable())
  .optional();
