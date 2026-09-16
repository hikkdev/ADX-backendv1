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
    // No ActivityLog row is possible here — its userId is a foreign key and
    // there is no user to hang it on — so the rejection goes to the log only.
    logger.warn('Google sign-in for an unprovisioned address', {
      hostedDomain: identity.hostedDomain,
      googleSub: identity.sub,
    });
    // Unlike login-password, naming the reason here leaks nothing. The caller
    // has already proved to Google that they own this mailbox, so they learn
    // only about their own address — it is not an oracle for probing others.
    // Being explicit saves a support ticket from every new hire.
    throw new ApiError(
      403,
      'FORBIDDEN',
      'No ADX account is linked to this Google address. Ask an administrator to invite you.',
    );
  }

  if (!user.isActive) {
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

  // Lot A (Q25): Google proved the mailbox, not the phone. An admin therefore
  // gets the same challenge a password sign-in gets, and no tokens yet.
  if (isAdmin(roles)) {
    const challenge = await issueChallenge(user);
    await logActivity(user.id, 'LOGIN_2FA_CHALLENGED', req, { method: 'google', googleSub: identity.sub });
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
