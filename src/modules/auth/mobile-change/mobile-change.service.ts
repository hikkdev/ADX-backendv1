import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import { redis } from '../../../shared/cache';
import { logger } from '../../../shared/logging';
import { notify } from '../../notifications';
import { expireOutstandingOtpsForUser, normalizeMobile, sendOtpToNumberForUser, verifyOtp } from '../otp/otp.service';
import { revokeSessions } from '../tokens/tokens.service';
import { prismaMobileChangeRepository as repository } from './prisma-mobile-change.repository';

/**
 * Changing the number the account signs in with — the highest-risk screen in
 * DR 07, and the reason it is built last.
 *
 * The number **is** the identity: `User.mobile` is unique, OTP sign-in
 * resolves it, and every profile hangs off the `User` row. So the change moves
 * nothing but that one column, and everything that could have been keyed on
 * the number is checked first:
 *
 *  - **Payouts follow `User.id`, not the number** (decision 11, verified
 *    against the schema on 11 September 2026): `PayoutMethod.userId`,
 *    `WithdrawalRequest.walletId` → `Wallet` → the party row → `userId`.
 *    Nothing in payouts, wallets or the ledger reads `mobile`. A change
 *    therefore cannot strand a payout.
 *  - A **UPI VPA can still contain the old number** — it is text the person
 *    typed, and ADX does not rewrite it. The screen says so.
 *  - A withdrawal **in flight** blocks the change anyway. Not because the rail
 *    would break, but because ops reconcile a transfer against a person, and
 *    the person's number changing mid-transfer is exactly the confusion a
 *    finance query does not need.
 *
 * Lot F (Q18, the owner's answer): **two codes, in order — the old number
 * confirms first.** A signed-in session is not proof that the person holding
 * the phone still holds the number, and a stolen session must not be able
 * to walk the identity away. So:
 *
 *   start        { newMobile }        the new number is free → a code to the
 *                                     CURRENT number (CHANGE_MOBILE_OLD)
 *   confirm-old  { newMobile, code }  the old number's code → a code to the
 *                                     NEW number (CHANGE_MOBILE); the consent
 *                                     is remembered for fifteen minutes
 *   verify       { newMobile, code }  refused unless confirm-old succeeded for
 *                                     that newMobile inside the window; swaps
 *                                     the column, ends every session, tells
 *                                     both numbers, audits the diff
 *
 * The consent lives in Redis (`auth:mobile-change:<userId>`), keyed by the
 * user and holding the new number, so a confirm-old for one number cannot be
 * spent on another. The caller must already be signed in throughout — this
 * is not a recovery path for a number somebody has lost.
 */

/** A withdrawal ADX has not finished paying. */
const IN_FLIGHT = ['REQUESTED', 'APPROVED', 'PROCESSING'] as const;

/** How long the old number's consent stands before the new number must be proved. */
export const CONFIRM_OLD_TTL_SECONDS = 15 * 60;

const consentKey = (userId: string) => `auth:mobile-change:${userId}`;

async function rememberConsent(userId: string, newMobile: string): Promise<void> {
  await redis.set(consentKey(userId), newMobile, 'EX', CONFIRM_OLD_TTL_SECONDS);
}

async function consentedNumber(userId: string): Promise<string | null> {
  try {
    return await redis.get(consentKey(userId));
  } catch (err) {
    // Fail closed: without the consent the change does not happen.
    logger.warn('Could not read the mobile-change consent', { userId, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function forgetConsent(userId: string): Promise<void> {
  try {
    await redis.del(consentKey(userId));
  } catch {
    /* it expires on its own */
  }
}

async function requireUser(userId: string) {
  const user = await repository.findUser(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return user;
}

/** The two guards every step re-checks: the number is free, and no money is in flight. */
async function assertChangeAllowed(userId: string, user: { mobile: string }, mobile: string, inFlightMessage: string): Promise<void> {
  if (normalizeMobile(user.mobile) === mobile) {
    throw new ApiError(409, 'CONFLICT', 'That is already your number.');
  }
  const taken = await repository.findUserByMobile(mobile);
  if (taken && taken.id !== userId) {
    throw new ApiError(409, 'CONFLICT', 'An account already uses that number.');
  }
  const inFlight = await repository.countWithdrawalsInFlight(userId, [...IN_FLIGHT]);
  if (inFlight > 0) throw new ApiError(409, 'CONFLICT', inFlightMessage);
}

/** POST /auth/change-mobile/start — validates the new number, codes the OLD one. */
export async function startMobileChange(userId: string, rawMobile: string) {
  const mobile = normalizeMobile(rawMobile);
  const user = await requireUser(userId);
  await assertChangeAllowed(
    userId,
    user,
    mobile,
    'You have a withdrawal in progress. Wait until it has been paid, then change your number.',
  );

  // A start for a different number withdraws any consent already given.
  await forgetConsent(userId);
  const result = await sendOtpToNumberForUser(userId, user.mobile, 'CHANGE_MOBILE_OLD');
  await logActivity(userId, 'MOBILE_CHANGE_STARTED', {
    targetType: 'User',
    targetId: userId,
    module: 'auth',
    metadata: { to: mobile, codeSentTo: 'CURRENT' },
  });
  return { ...result, sentTo: 'CURRENT' as const };
}

/** POST /auth/change-mobile/confirm-old — the old number's code, then a code to the NEW one. */
export async function confirmOldMobile(userId: string, rawMobile: string, code: string) {
  const mobile = normalizeMobile(rawMobile);
  const user = await requireUser(userId);
  await assertChangeAllowed(
    userId,
    user,
    mobile,
    'A withdrawal started while you were confirming. Your number has not changed.',
  );

  const provedFor = await verifyOtp(user.mobile, code, 'CHANGE_MOBILE_OLD');
  if (provedFor !== userId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'This code has expired. Request a new one.');
  }

  await rememberConsent(userId, mobile);
  const result = await sendOtpToNumberForUser(userId, mobile, 'CHANGE_MOBILE');
  await logActivity(userId, 'MOBILE_CHANGE_OLD_CONFIRMED', {
    targetType: 'User',
    targetId: userId,
    module: 'auth',
    metadata: { to: mobile, codeSentTo: 'NEW', consentSeconds: CONFIRM_OLD_TTL_SECONDS },
  });
  return { ...result, sentTo: 'NEW' as const, confirmWithinSeconds: CONFIRM_OLD_TTL_SECONDS };
}

/** POST /auth/change-mobile/verify — the new number's code; the identity moves. */
export async function verifyMobileChange(userId: string, rawMobile: string, code: string) {
  const mobile = normalizeMobile(rawMobile);
  const user = await requireUser(userId);

  // The old number's consent has to stand, for THIS number, inside the window.
  const consented = await consentedNumber(userId);
  if (consented !== mobile) {
    throw new ApiError(
      409,
      'CONFLICT',
      'Confirm the code sent to your current number first. If it has been more than fifteen minutes, start again.',
      { reason: 'OLD_NUMBER_NOT_CONFIRMED' },
    );
  }

  // Re-checked here and not only at the start: minutes pass between the
  // calls, and somebody else may have registered the number in between.
  await assertChangeAllowed(
    userId,
    user,
    mobile,
    'A withdrawal started while you were confirming. Your number has not changed.',
  );

  const provedFor = await verifyOtp(mobile, code, 'CHANGE_MOBILE');
  if (provedFor !== userId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'This code has expired. Request a new one.');
  }

  const previous = user.mobile;
  const updated = await repository.changeMobile(userId, mobile);
  await forgetConsent(userId);

  await completeMobileChange(userId, previous, updated.mobile, { action: 'USER_MOBILE_CHANGED', module: 'auth' });

  return { mobile: updated.mobile, previousMobile: previous, sessionsRevoked: true };
}


/**
 * K-B1: everything that has to happen once `User.mobile` has moved, whoever
 * moved it — the self-service swap above and the console's make-primary
 * (`users`' contacts desk) share it, so neither can forget a step:
 *
 *  1. every session goes, refresh tokens and the access tokens in flight —
 *     they were issued to an identity that no longer exists;
 *  2. every live OTP the account holds is expired, so a LOGIN code already
 *     sent to the old number cannot still sign this account in through it;
 *  3. the audit row, with the before/after pair, under the caller's action;
 *  4. the OLD number is told (the `mobile-changed` template) — if this was
 *     not the person's doing, that is where they find out — and the account
 *     gets the in-app row. A dead rail is logged and skipped; nothing here
 *     can undo a swap that took.
 */
export async function completeMobileChange(
  userId: string,
  previous: string,
  mobile: string,
  options: { action: string; module: string; metadata?: Record<string, unknown> | undefined },
): Promise<void> {
  await revokeSessions(userId, 'MOBILE_CHANGED');
  try {
    await expireOutstandingOtpsForUser(userId);
  } catch (err) {
    logger.warn('Outstanding OTPs were not expired after a mobile change', { userId, reason: err instanceof Error ? err.message : String(err) });
  }
  await logActivity(userId, options.action, {
    targetType: 'User',
    targetId: userId,
    module: options.module,
    diff: auditDiff({ mobile: previous }, { mobile }, ['mobile']),
    metadata: { from: previous, to: mobile, ...(options.metadata ?? {}) },
  });

  try {
    await notify(
      'MOBILE_CHANGED',
      userId,
      { newMasked: maskNewMobile(mobile), date: new Date().toISOString().slice(0, 10) },
      {
        type: 'SYSTEM',
        recipient: { mobile: previous },
        immediate: true,
        inApp: {
          type: 'SYSTEM',
          title: 'Your sign-in number changed',
          subtitle: mobile,
          message: `Your ADX number changed from ${previous} to ${mobile}. If this was not you, call ADX support now.`,
          relatedId: userId,
        },
      },
    );
  } catch (err) {
    logger.warn('Mobile-changed notice was not sent', { userId, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** `+91 XXXXX ***NN` — the old number learns where the identity went without the SMS printing the whole new number. */
export function maskNewMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  return `+91 XXXXX ***${digits.slice(-2)}`;
}
