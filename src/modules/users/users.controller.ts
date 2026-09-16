import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, listActivity as listActivityLogs, logActivity } from '../../shared/audit';
import {
  authenticatorStatus,
  clearAuthenticator,
  createInvite,
  inviteSchema,
  listActiveSessions,
  listInvites,
  recoveryCodesLeftFor,
  resendInvite,
  resetEmailOtpFallback,
  revokeInvite,
  revokeOtherSessions,
  revokeSessionById,
} from '../auth';
import { assignRoleConfig, assignRoleConfigSchema, consoleStandingFor } from '../access-control';
import type { Role } from '../../shared/database';
import {
  adminUsersQuerySchema,
  assignRoleSchema,
  bootstrapAdminSchema,
  choosePartySchema,
  createUserSchema,
  updateProfileSchema,
  updateUserByAdminSchema,
} from './users.schema';
import { adminListPayload, adminUpdatePayload, profilePayload, twoFactorState, twoFactorSummary } from './users.mapper';
import * as service from './users.service';
import { onboardingManifest as buildManifestFor } from './onboarding-manifest.service';
import { getPreferencesView, savePreferencesSchema, saveUserPreferences } from './preferences';

export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await service.getProfile(req.user!.sub);
  // M-B: the console standing — `roleConfig { id, name, isSystem }` and
  // `isSuperAdmin` — by access-control's own predicate, so the console
  // stops making a second read to decide it. A non-admin reads null / false.
  const standing = await consoleStandingFor(user.id, user.roles.map((r) => r.role));
  // E6: the second-factor state rides on /me only.
  res.json({ success: true, data: { ...profilePayload(user), ...twoFactorState(user), ...standing } });
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await service.updateProfile(userId, parsed.data);
  await logActivity(userId, 'PROFILE_UPDATED', req, { fields: Object.keys(parsed.data) });

  res.json({ success: true, data: profilePayload(user) });
}

// POST /users/me/party — which side of the marketplace this account is on.
// 201 when the party was opened (or claimed) by this call, 200 when it
// already existed; the identifier comes back either way.
export async function chooseParty(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = choosePartySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const choice = await service.chooseParty(userId, parsed.data);
  if (choice.created) {
    await logActivity(userId, 'PARTY_OPENED', req, {
      party: choice.party,
      accountType: choice.accountType,
      displayId: choice.displayId,
    });
  }

  res.status(choice.created ? 201 : 200).json({ success: true, data: choice });
}

// GET /users/me/onboarding-manifest?party=&version= — the ladder for the caller's own side
export async function onboardingManifest(req: Request, res: Response): Promise<void> {
  const raw = req.query['party'];
  const party = typeof raw === 'string' ? raw.toUpperCase() : undefined;
  if (party !== undefined && party !== 'PUBLISHER' && party !== 'ADVERTISER') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'party must be PUBLISHER or ADVERTISER');
  }
  // Q83: the manifestVersion the phone stamped at the first step. Absent on
  // the first read; on every later read, so an edit does not move the rungs.
  const rawVersion = req.query['version'];
  const version = typeof rawVersion === 'string' && rawVersion !== '' ? Number(rawVersion) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'version must be a positive integer');
  }
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await buildManifestFor(req.user!.sub, party, version) });
}

// GET /users/me/sessions — active (non-revoked, non-expired) login sessions
/** DR 07 wave 5: every preference key, saved or defaulted. E11-1: `emailUnsubscribedAt` beside them. */
export async function getMyPreferences(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getPreferencesView(req.user!.sub) });
}

export async function saveMyPreferences(req: Request, res: Response): Promise<void> {
  const parsed = savePreferencesSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  await saveUserPreferences(req.user!.sub, parsed.data);
  // The same shape the read answers, so a screen never has to merge.
  res.json({ success: true, data: await getPreferencesView(req.user!.sub) });
}

// E11-1: POST /users/me/email-resubscribe — the person's own undo of the
// public unsubscribe link. 409 when there was nothing to undo.
export async function resubscribeMyEmail(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const result = await service.resubscribeEmail(userId);
  await logActivity(userId, 'USER_EMAIL_RESUBSCRIBED', req, { userId });
  res.json({ success: true, data: result });
}

export async function listMySessions(req: Request, res: Response): Promise<void> {
  const sessions = await listActiveSessions(req.user!.sub);
  // "This device" is the row the caller's own access token names.
  const sid = req.user!.sid ?? null;
  res.json({ success: true, data: sessions.map((session) => ({ ...session, current: sid !== null && session.id === sid })) });
}

// DELETE /users/me/sessions/:id — revoke a single session (e.g. "log out" a device)
export async function revokeMySession(req: Request, res: Response): Promise<void> {
  const sessionId = req.params['id'] as string;
  const revoked = await revokeSessionById(req.user!.sub, sessionId);
  if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  await logActivity(req.user!.sub, 'SESSION_REVOKED', req, { sessionId });
  res.json({ success: true, data: { message: 'Session revoked' } });
}

// E6: DELETE /users/me/sessions — sign out every other device, keep this one.
export async function revokeMyOtherSessions(req: Request, res: Response): Promise<void> {
  const sid = req.user!.sid ?? null;
  if (!sid) throw new ApiError(409, 'CONFLICT', 'This token names no session to keep; sign in again first');
  const revoked = await revokeOtherSessions(req.user!.sub, sid);
  await logActivity(req.user!.sub, 'OTHER_SESSIONS_REVOKED', req, { kept: sid, revoked });
  res.json({ success: true, data: { revoked } });
}

// GET /users/me/activity — recent account activity
export async function listMyActivity(req: Request, res: Response): Promise<void> {
  const activity = await listActivityLogs(req.user!.sub);
  res.json({ success: true, data: activity });
}

/* E6: the desk reading somebody else's sessions and activity — the same
 * shapes as the /me routes, `current` always false because the admin's own
 * token is not one of them. */
export async function listUserSessions(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  await service.requireUser(id);
  const sessions = await listActiveSessions(id);
  res.json({ success: true, data: sessions.map((session) => ({ ...session, current: false })) });
}

export async function listUserActivity(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  await service.requireUser(id);
  res.json({ success: true, data: await listActivityLogs(id) });
}

/* E6: POST /users/:id/reset-password — the ordinary reset link, sent from the desk. */
export async function sendResetLink(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const { email } = await service.sendResetLinkByAdmin(id);
  await logActivity(id, 'PASSWORD_RESET_SENT_BY_ADMIN', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: id,
    metadata: { sentBy: req.user!.sub, email },
  });
  res.json({ success: true, data: { message: 'Reset link sent', email } });
}

export async function getAllUsers(req: Request, res: Response): Promise<void> {
  const parsed = adminUsersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const filter = {
    closed: parsed.data.closed,
    q: parsed.data.q,
    role: parsed.data.role,
    state: parsed.data.state,
    sort: parsed.data.sort,
  };
  // K-B1: `data` stays the array the console reads; the per-state counts and
  // the total travel beside it, so the chips can be drawn without a second call.
  const [users, counts] = await Promise.all([service.listUsersForAdmin(filter), service.countUsersByState(filter)]);
  // Lot K2: the recovery-code count rides on each row's second-factor
  // summary — one query for the enrolled rows, none when there are none.
  const enrolled = users.filter((user) => user.totpEnrolledAt !== null).map((user) => user.id);
  const codesLeft = enrolled.length ? await recoveryCodesLeftFor(enrolled) : new Map<string, number>();
  res.json({ success: true, data: users.map((user) => adminListPayload(user, codesLeft.get(user.id) ?? 0)), counts, total: users.length });
}

export async function updateUserByAdmin(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = updateUserByAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { user, diff, movedIdentity } = await service.updateUserByAdmin(id, req.user!.sub, parsed.data);

  // Logged against the edited user, not the acting admin, with the actor
  // recorded in the metadata. K-B1: one row, `USER_UPDATED_BY_ADMIN`, with
  // the diff of every field that changed; `outcome` keeps the older
  // vocabulary (ACCOUNT_DEACTIVATED / ACCOUNT_ACTIVATED / PROFILE_UPDATED_BY_ADMIN)
  // the console's activity views already read, and the reason rides along
  // whenever an identity moved.
  const { reason, ...fields } = parsed.data;
  await logActivity(id, 'USER_UPDATED_BY_ADMIN', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: id,
    diff,
    metadata: {
      updatedBy: req.user!.sub,
      fields: Object.keys(fields),
      outcome: service.adminUpdateAction(parsed.data),
      ...(movedIdentity.length ? { movedIdentity, reason } : {}),
    },
  });

  res.json({ success: true, data: adminUpdatePayload(user) });
}

/* ── invitations to the console (Lot A, Q26) ─────────────────────── */

/*
 * The flow itself belongs to `auth`: it mints a credential, sends it, and
 * creates the account at the other end. These four are the console's view of
 * it, mounted under /users because that is where an admin looks for "who can
 * get in", and they reach the flow through the auth module's index.
 */

export async function inviteUser(req: Request, res: Response): Promise<void> {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const invite = await createInvite(parsed.data, req.user!.sub);
  await logActivity(req.user!.sub, 'USER_INVITED', {
    req,
    module: 'users',
    targetType: 'AdminInvite',
    targetId: invite.id,
    metadata: { email: invite.email, method: invite.method, roleConfigId: invite.roleConfigId },
  });
  res.status(201).json({ success: true, data: invite });
}

export async function listUserInvites(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listInvites() });
}

export async function resendUserInvite(req: Request, res: Response): Promise<void> {
  const invite = await resendInvite(req.params['id'] as string);
  await logActivity(req.user!.sub, 'USER_INVITE_RESENT', {
    req,
    module: 'users',
    targetType: 'AdminInvite',
    targetId: invite.id,
    metadata: { email: invite.email },
  });
  res.json({ success: true, data: invite });
}

export async function revokeUserInvite(req: Request, res: Response): Promise<void> {
  const invite = await revokeInvite(req.params['id'] as string);
  await logActivity(req.user!.sub, 'USER_INVITE_REVOKED', {
    req,
    module: 'users',
    targetType: 'AdminInvite',
    targetId: invite.id,
    metadata: { email: invite.email },
  });
  res.json({ success: true, data: invite });
}

/** GET /users/:id — one account, with the console role it holds. */
export async function getUserById(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const { user, roleConfig, detail } = await service.getUserForAdmin(id);
  // K-B1: the facts the page prints and the links it draws across — the
  // console role beside the seeded roles, the counts, the second-factor and
  // closure stamps, and every party this person is.
  const [sessions, authenticator] = await Promise.all([listActiveSessions(id), authenticatorStatus(user)]);
  res.json({
    success: true,
    data: {
      ...profilePayload(user),
      roleConfig,
      roles: user.roles.map((r) => r.role),
      contactsCount: detail.contactsCount,
      sessionsCount: sessions.length,
      twoFactorRequiredAt: user.twoFactorRequiredAt,
      // Lot K2: the factor the next sign-in asks for, and the codes left.
      twoFactor: twoFactorSummary(user, authenticator.recoveryCodesLeft),
      parties: {
        publisher: detail.publisher,
        advertiser: detail.advertiser,
        agent: detail.agent,
        printPartner: detail.printPartner,
      },
    },
  });
}

/**
 * PUT /users/:id/role-config — which console role this person holds.
 *
 * The write lives in `access-control`, which owns both tables; this is the
 * route, because the console asks it of a user.
 */
export async function setRoleConfig(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const id = req.params['id'] as string;
  const result = await assignRoleConfig(id, req.user!.sub, parsed.data);

  await logActivity(id, 'ROLE_CONFIG_ASSIGNED', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: id,
    diff: {
      roleConfig: { before: result.previous?.name ?? null, after: result.roleConfig?.name ?? null },
    },
    metadata: { assignedBy: req.user!.sub, roleConfigId: result.roleConfig?.id ?? null },
  });

  res.json({ success: true, data: result });
}

/**
 * POST /users/:id/2fa/reset — hands somebody their email backup back after
 * the hijack guard has spent it. The phone is the other way, and the better
 * one: a successful SMS challenge resets the counter by itself. Lot K2: the
 * authenticator enrolment and the recovery codes go too — the desk's answer
 * to a lost phone — and the audit row says what was cleared.
 */
export async function resetTwoFactorFallback(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  await service.requireUser(id);
  await resetEmailOtpFallback(id);
  const cleared = await clearAuthenticator(id);
  await logActivity(id, 'TWO_FACTOR_FALLBACK_RESET', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: id,
    diff: auditDiff(
      { emailFallbackSpent: true, authenticator: cleared.hadAuthenticator, recoveryCodes: cleared.recoveryCodesCleared },
      { emailFallbackSpent: false, authenticator: false, recoveryCodes: 0 },
      ['emailFallbackSpent', 'authenticator', 'recoveryCodes'],
    ),
    metadata: {
      resetBy: req.user!.sub,
      cleared: {
        emailFallback: true,
        authenticator: cleared.hadAuthenticator,
        recoveryCodes: cleared.recoveryCodesCleared,
      },
    },
  });
  res.json({
    success: true,
    data: {
      message: cleared.hadAuthenticator ? 'Email backup restored and authenticator app removed' : 'Email backup restored',
      cleared: { emailFallback: true, authenticator: cleared.hadAuthenticator, recoveryCodes: cleared.recoveryCodesCleared },
    },
  });
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const { mobile, wasAdmin } = await service.deleteUser(id, req.user!.sub);

  // The deleted user's own activity log is cascade-deleted with them, so
  // record this against the acting admin's log instead.
  await logActivity(req.user!.sub, 'USER_DELETED', req, {
    deletedUserId: id,
    deletedUserMobile: mobile,
    wasAdmin,
  });

  res.json({ success: true, data: { message: 'User deleted' } });
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const roles = parsed.data.roles as Role[];
  const user = await service.createUser({ ...parsed.data, roles });

  // K-B1: audited against the new account, with the desk in the metadata.
  await logActivity(user.id, 'USER_CREATED_BY_ADMIN', {
    req,
    module: 'users',
    targetType: 'User',
    targetId: user.id,
    diff: auditDiff(null, { mobile: user.mobile, name: user.name, email: user.email, roles }),
    metadata: { createdBy: req.user!.sub, roles, roleConfigId: parsed.data.roleConfigId ?? null },
  });
  if (parsed.data.roleConfigId) {
    // The console role, when the create form named one — the same write
    // `PUT /users/:id/role-config` makes, with its own rules and audit row.
    const result = await assignRoleConfig(user.id, req.user!.sub, { roleConfigId: parsed.data.roleConfigId });
    await logActivity(user.id, 'ROLE_CONFIG_ASSIGNED', {
      req,
      module: 'users',
      targetType: 'User',
      targetId: user.id,
      diff: { roleConfig: { before: null, after: result.roleConfig?.name ?? null } },
      metadata: { assignedBy: req.user!.sub, roleConfigId: result.roleConfig?.id ?? null },
    });
  }

  res.status(201).json({
    success: true,
    data: { id: user.id, mobile: user.mobile, name: user.name, roles },
  });
}

export async function bootstrapAdmin(req: Request, res: Response): Promise<void> {
  const parsed = bootstrapAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  await service.bootstrapAdmin(parsed.data.userId);
  res.json({ success: true, data: { message: 'Admin bootstrapped' } });
}

export async function assignRole(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { userId, role } = parsed.data;
  await service.assignRole(userId, role as Role);

  res.json({ success: true, data: { message: `Role ${role} assigned` } });
}
