import { isWorkingUser } from '../../../shared/party-status';
import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { logger } from '../../../shared/logging';
import type { Role } from '../../../shared/database';
import { googleLoginSchema } from '../auth.schema';
import { googleLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { sessionMeta, startSession } from '../auth.session';
import { verifyGoogleIdToken } from './google.service';
import { isAdmin, issueChallenge } from '../two-factor/two-factor.service';
import { isEnrolled } from '../two-factor/authenticator.service';
import { signupHandoffForProvenEmail, stampProvenEmail } from '../otp/otp.service';

/**
 * POST /auth/google — exchange a Google ID token for an ADX session.
 *
 * Google sign-in is an *authentication* method here, never a registration
 * path: the account must already exist in ADX and be active. That is the right
 * posture for an admin panel, and it also keeps `User.mobile` — a required,
 * unique column — out of the picture, since a Google identity carries no phone
 * number.
 *
 * Note the split with `google.service`: the service proves the caller controls
 * the Google account, this handler decides whether that account may hold an
 * ADX session. Same division as OTP verification and the login handlers.
 */
export async function googleLoginHandler(req: Request, res: Response): Promise<void> {
  const parsed = googleLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const identity = await verifyGoogleIdToken(parsed.data.idToken);

  const matches = await repository.findLoginUsersByEmailInsensitive(identity.email);

  if (matches.length > 1) {
    // Two ADX accounts whose emails differ only by case. Signing one of them in
    // would be arbitrary, so refuse and leave a trail for whoever cleans it up.
    logger.error('Google sign-in matched multiple accounts', {
      ids: matches.map((user) => user.id),
    });
    throw new ApiError(409, 'CONFLICT', 'Multiple ADX accounts share this email. Contact an administrator.');
  }

  const user = matches[0];

  if (!user) {
    // G-2 (the owner, 25 Sep 2026): Google is a sign-up door too. A mailbox
    // Google vouches for skips the email code and goes straight to the phone
    // step — every account still proves a number — carrying the hand-off the
    // email door answers a new address with. An address Google has not
    // verified is not proof of anything, and is refused as before.
    if (!identity.emailVerified) {
      logger.warn('Google sign-in for an unverified address', { googleSub: identity.sub });
      throw new ApiError(403, 'FORBIDDEN', 'Google has not verified this email address. Verify it with Google, or sign up with your email or mobile number.');
    }
    const signup = await signupHandoffForProvenEmail(identity.email);
    logger.info('Google sign-in for a new address: handed to the phone step', { googleSub: identity.sub });
    res.json({ success: true, data: { signup: { signupToken: signup.signupToken, email: signup.email, expiresInSeconds: signup.expiresInSeconds } } });
    return;
  }

  if (!isWorkingUser(user)) {
    // Mirrors what password login records for a rejected attempt, so a
    // deactivated account being probed is visible in the same place.
    await logActivity(user.id, 'LOGIN_FAILED', req, {
      method: 'google',
      reason: 'inactive',
      googleSub: identity.sub,
    });
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  // ED-1: Google proved the mailbox — the same standing the email door's code gives.
  if (identity.emailVerified && user.email) await stampProvenEmail(user.id, user.email);

  // Lot A (Q25): Google proved the mailbox, not the phone. An admin therefore
  // gets the same challenge a password sign-in gets, and no tokens yet.
  if (isAdmin(roles)) {
    const challenge = await issueChallenge(user);
    await logActivity(user.id, 'LOGIN_2FA_CHALLENGED', req, { method: 'google', googleSub: identity.sub });
    res.json({ success: true, data: { challenge } });
    return;
  }
  // 2FA-A: an account with an authenticator answers the app before tokens.
  if (isEnrolled(user)) {
    const challenge = await issueChallenge(user, { methods: ['AUTHENTICATOR'] });
    await logActivity(user.id, 'LOGIN_2FA_CHALLENGED', req, { method: 'google', googleSub: identity.sub, authenticator: true });
    res.json({ success: true, data: { challenge } });
    return;
  }

  const { accessToken, refreshToken } = await startSession(user.id, roles, sessionMeta(req));
  await logActivity(user.id, 'LOGIN_GOOGLE', req, {
    googleSub: identity.sub,
    ...(identity.hostedDomain ? { hostedDomain: identity.hostedDomain } : {}),
  });

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: googleLoginUser(user, roles) },
  });
}
