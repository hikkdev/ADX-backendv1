import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import { signAccessToken } from '../../../shared/auth';
import type { Role } from '../../../shared/database';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { twoFactorLoginUser } from '../auth.mapper';
import { sessionMeta, startSession } from '../auth.session';
import { resolveConsoleStanding, resolvePermissions } from '../auth.ports';
import { OtpError } from '../otp/otp-security';
import { confirmTotpSchema, disableTotpSchema, regenerateRecoveryCodesSchema, sendTwoFactorSchema, verifyTwoFactorSchema } from './two-factor.schema';
import { availableMethods, isAdmin, sendTwoFactorCode, verifyTwoFactorCode } from './two-factor.service';
import {
  adminTwoFactorPolicy,
  authenticatorStatus,
  confirmEnrolment,
  disableAuthenticator,
  mustEnrolAuthenticator,
  regenerateRecoveryCodes,
  startEnrolment,
} from './authenticator.service';
import { prismaTwoFactorRepository as twoFactorRepository } from './prisma-two-factor.repository';

/**
 * POST /auth/2fa/send — a code to the phone, or (while the budget lasts) to
 * the email. `Retry-After` is mirrored out of the OTP budget refusals, same as
 * the OTP endpoints. Lot K2: AUTHENTICATOR sends nothing and says so.
 */
export async function sendTwoFactorHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendTwoFactorSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  try {
    const result = await sendTwoFactorCode(parsed.data.challengeToken, parsed.data.method);
    const message = result.method === 'AUTHENTICATOR' ? 'Open your authenticator app' : 'Code sent';
    res.json({ success: true, data: { message, ...result } });
  } catch (err) {
    if (err instanceof OtpError && err.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(err.retryAfterSeconds));
    }
    throw err;
  }
}

/**
 * POST /auth/2fa/verify — the code, and then the tokens the login handler did
 * not hand out. This is the second half of that request, so it answers with
 * the same shape the login endpoints do. Lot K2: when the policy requires an
 * authenticator app and this admin has none, the tokens carry
 * `mustEnrolAuthenticator` and the answer says so.
 */
export async function verifyTwoFactorHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifyTwoFactorSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  let verified: Awaited<ReturnType<typeof verifyTwoFactorCode>>;
  try {
    verified = await verifyTwoFactorCode(parsed.data.challengeToken, parsed.data.code);
  } catch (err) {
    if (err instanceof OtpError && err.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(err.retryAfterSeconds));
    }
    throw err;
  }
  const { userId, roles, method, recoveryCodesLeft, warning } = verified;

  const user = await repository.findLoginUserById(userId);
  if (!user || !user.isActive) throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');

  const mustEnrol = await mustEnrolAuthenticator(user, roles.includes('ADMIN'));
  const { accessToken, refreshToken } = await startSession(userId, roles, sessionMeta(req), { mustEnrolAuthenticator: mustEnrol });
  await logActivity(userId, 'LOGIN_2FA', req, { method, ...(mustEnrol ? { mustEnrolAuthenticator: true } : {}) });

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: twoFactorLoginUser(user, roles),
      ...(mustEnrol ? { mustEnrolAuthenticator: true } : {}),
      ...(recoveryCodesLeft !== undefined ? { recoveryCodesLeft, warning: warning ?? null } : {}),
    },
  });
}

/* ── Lot K2: the authenticator app, for the signed-in admin ─────── */

/** POST /auth/2fa/totp/enrol — the secret, shown once, and the QR. */
export async function enrolTotpHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const start = await startEnrolment(userId);
  await logActivity(userId, 'TOTP_ENROLMENT_STARTED', { req, module: 'auth', targetType: 'User', targetId: userId, metadata: { expiresInSeconds: start.expiresInSeconds } });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: start });
}

/**
 * POST /auth/2fa/totp/confirm — the first code from the app. The recovery
 * codes come back once. A session held in the must-enrol state is handed a
 * fresh access token without the claim, so the console need not refresh.
 */
export async function confirmTotpHandler(req: Request, res: Response): Promise<void> {
  const parsed = confirmTotpSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const userId = req.user!.sub;

  const done = await confirmEnrolment(userId, parsed.data.code);
  await logActivity(userId, 'TOTP_ENROLLED', {
    req,
    module: 'auth',
    targetType: 'User',
    targetId: userId,
    diff: auditDiff({ authenticator: null }, { authenticator: done.enrolledAt }, ['authenticator']),
    metadata: { recoveryCodesIssued: done.recoveryCodes.length },
  });

  let accessToken: string | undefined;
  if (req.user!.mustEnrolAuthenticator) {
    const roles = req.user!.roles as Role[];
    const perms = await resolvePermissions(userId, roles);
    accessToken = signAccessToken(userId, roles, req.user!.sid, { perms });
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: { enrolledAt: done.enrolledAt, recoveryCodes: done.recoveryCodes, ...(accessToken ? { accessToken } : {}) },
  });
}

/** POST /auth/2fa/totp/disable — { code } or { recoveryCode }. */
export async function disableTotpHandler(req: Request, res: Response): Promise<void> {
  const parsed = disableTotpSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const userId = req.user!.sub;

  const before = await twoFactorRepository.findUser(userId);
  const result = await disableAuthenticator(userId, parsed.data);
  await logActivity(userId, 'TOTP_DISABLED', {
    req,
    module: 'auth',
    targetType: 'User',
    targetId: userId,
    diff: auditDiff({ authenticator: before?.totpEnrolledAt ?? null }, { authenticator: null }, ['authenticator']),
    metadata: { provedWith: result.how },
  });
  res.json({ success: true, data: { message: 'Authenticator app removed', disabled: true } });
}

/** POST /auth/2fa/recovery-codes/regenerate — { code }; the old ten are gone. */
export async function regenerateRecoveryCodesHandler(req: Request, res: Response): Promise<void> {
  const parsed = regenerateRecoveryCodesSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const userId = req.user!.sub;

  const result = await regenerateRecoveryCodes(userId, parsed.data.code);
  await logActivity(userId, 'RECOVERY_CODES_REGENERATED', { req, module: 'auth', targetType: 'User', targetId: userId, metadata: { count: result.recoveryCodes.length } });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: result });
}

/** GET /auth/2fa/status — the methods, the enrolment and the policy. */
export async function twoFactorStatusHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const user = await twoFactorRepository.findUser(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  const roles = user.roles.map((r) => r.role) as Role[];
  const [methods, authenticator, policy, standing] = await Promise.all([
    isAdmin(user.roles) ? availableMethods(user.id, user.email) : Promise.resolve([]),
    authenticatorStatus(user),
    adminTwoFactorPolicy(),
    // M-B: the console standing, through the port access-control fills.
    resolveConsoleStanding(user.id, roles),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      methods,
      authenticator,
      policy,
      mustEnrolAuthenticator: req.user!.mustEnrolAuthenticator === true,
      roleConfig: standing.roleConfig,
      isSuperAdmin: standing.isSuperAdmin,
    },
  });
}
