import { isWorkingUser } from '../../../shared/party-status';
import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { logger } from '../../../shared/logging';
import type { Role } from '../../../shared/database';
import { facebookLoginSchema } from '../auth.schema';
import { googleLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { sessionMeta, startSession } from '../auth.session';
import { signupHandoffForProvenEmail, stampProvenEmail } from '../otp/otp.service';
import { isAdmin, issueChallenge } from '../two-factor/two-factor.service';
import { isEnrolled } from '../two-factor/authenticator.service';
import { verifyFacebookToken } from './facebook.service';

/**
 * POST /auth/facebook — FB-1. Register-or-login on the mailbox Facebook
 * vouches for: a known address signs in (an admin, or any account with an
 * authenticator, gets the second-factor challenge instead of tokens); an
 * unknown one is a sign-up, answered as the email door answers a new
 * address — a signup token the phone step carries. No email on the
 * Facebook account means nothing to key on: 409, try another door.
 */
export async function facebookLoginHandler(req: Request, res: Response): Promise<void> {
  const parsed = facebookLoginSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const identity = await verifyFacebookToken(parsed.data.accessToken);
  if (!identity.email) {
    throw new ApiError(409, 'FACEBOOK_EMAIL_REQUIRED', 'Your Facebook account shares no email address with ADX. Sign in with your email or mobile number instead.');
  }

  const matches = await repository.findLoginUsersByEmailInsensitive(identity.email);
  if (matches.length > 1) {
    logger.error('Facebook sign-in matched multiple accounts', { ids: matches.map((user) => user.id) });
    throw new ApiError(409, 'CONFLICT', 'Multiple ADX accounts share this email. Contact an administrator.');
  }
  const user = matches[0];

  if (!user) {
    const signup = await signupHandoffForProvenEmail(identity.email);
    res.json({ success: true, data: { signup: { signupToken: signup.signupToken, email: signup.email, expiresInSeconds: signup.expiresInSeconds } } });
    return;
  }
  if (!isWorkingUser(user)) {
    await logActivity(user.id, 'LOGIN_FAILED', req, { method: 'facebook', reason: 'inactive', facebookId: identity.id });
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  // Facebook proved the mailbox — the same standing the email door's code gives.
  if (user.email) await stampProvenEmail(user.id, user.email);

  // The mailbox is one factor. An admin, or (2FA-A) any account with an
  // authenticator set up, answers the app before tokens are issued.
  if (isAdmin(roles) || isEnrolled(user)) {
    const challenge = isAdmin(roles) ? await issueChallenge(user) : await issueChallenge(user, { methods: ['AUTHENTICATOR'] });
    await logActivity(user.id, 'LOGIN_2FA_CHALLENGED', req, { method: 'facebook', facebookId: identity.id });
    res.json({ success: true, data: { challenge } });
    return;
  }

  const { accessToken, refreshToken } = await startSession(user.id, roles, sessionMeta(req));
  await logActivity(user.id, 'LOGIN_FACEBOOK', req, { facebookId: identity.id });
  res.json({ success: true, data: { accessToken, refreshToken, user: googleLoginUser(user, roles) } });
}
