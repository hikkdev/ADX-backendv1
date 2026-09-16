import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { notify } from '../../notifications';
import { upperEnum } from '../../../shared/validation';
import type { AdminInvite, AdminInviteMethod, Role } from '../../../shared/database';
import { normalizeMobile, sendOtp, verifyOtp } from '../otp/otp.service';
import { hashPassword } from '../password/password.service';
import { prismaInvitesRepository as repository, type InviteRow } from './prisma-invites.repository';

/**
 * Invitations to the console — Lot A, Q26.
 *
 * Nobody signs themselves up for an admin account: an admin invites an
 * address, the link carries a one-time token (stored hashed, like a password
 * reset), and acceptance is where the account is actually created. That is
 * why the invite carries the console role rather than a user row waiting to
 * be filled in: an unaccepted invite leaves nothing behind to clean up, and
 * an expired one simply stops working.
 *
 * Acceptance is two calls to the same endpoint. The first carries the token
 * and a mobile number and sends an OTP to it; the second carries the code (and
 * a password when the invite said PASSWORD) and creates the User. The number
 * is proved before the account exists because the second factor (Q25) will
 * send to it — an admin account whose phone was typed wrong is an admin
 * account nobody can sign in to.
 *
 * SEAM: a later platform switch will turn password sign-in off for admins and
 * leave only Google. Nothing here needs to change when it lands — the invite
 * already records which method it was sent for, and the switch will refuse
 * `method: PASSWORD` at creation. It is deliberately not built yet.
 */

export const INVITE_TTL_DAYS = 7;
const INVITE_METHODS = ['PASSWORD', 'GOOGLE'] as const;

export const inviteSchema = z.object({
  email: z.string().email(),
  roleConfigId: z.string().min(1).optional(),
  method: upperEnum(INVITE_METHODS).default('PASSWORD'),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
  otpCode: z.string().trim().length(6).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
});

export type InviteInput = z.infer<typeof inviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export type InviteView = {
  id: string;
  email: string;
  method: AdminInviteMethod;
  roleConfigId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  status: 'OPEN' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  invitedBy?: { id: string; name: string | null; email: string | null };
};

function expiry(): Date {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function mintToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

/** SHA-256, not bcrypt: the token is 256 bits of randomness, so there is nothing to slow down. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function statusOf(invite: AdminInvite, now = new Date()): InviteView['status'] {
  if (invite.acceptedAt) return 'ACCEPTED';
  if (invite.revokedAt) return 'REVOKED';
  if (invite.expiresAt <= now) return 'EXPIRED';
  return 'OPEN';
}

function view(invite: AdminInvite | InviteRow): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    method: invite.method,
    roleConfigId: invite.roleConfigId,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
    status: statusOf(invite),
    ...('invitedBy' in invite ? { invitedBy: invite.invitedBy } : {}),
  };
}

async function deliver(invite: AdminInvite, rawToken: string): Promise<void> {
  const url = `${env.INVITE_ACCEPT_URL.replace(/\/$/, '')}?token=${rawToken}`;
  const how =
    invite.method === 'GOOGLE'
      ? 'You will sign in with your Google Workspace account.'
      : 'You will choose a password as you accept.';
  // Lot E (Q87): the `admin-invite` template through the dispatcher. No user
  // exists yet, so the address is given rather than looked up; the row is
  // sensitive (it carries the link) and its variables are purged in a week.
  await notify('ADMIN_INVITE', null, { url, days: INVITE_TTL_DAYS, how }, { type: 'SYSTEM', recipient: { email: invite.email }, immediate: true });
}

/** POST /users/invites. One open invite per address, so a resend is a resend. */
export async function createInvite(input: InviteInput, invitedByUserId: string): Promise<InviteView> {
  const email = input.email.trim();

  if (await repository.findUserByEmail(email)) {
    throw new ApiError(409, 'CONFLICT', 'An account already uses that email address.');
  }
  if (await repository.findOpenByEmail(email, new Date())) {
    throw new ApiError(409, 'CONFLICT', 'An invitation to that address is already open. Resend or revoke it.');
  }
  if (input.roleConfigId && !(await repository.roleConfigExists(input.roleConfigId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  }

  const { raw, hash } = mintToken();
  const invite = await repository.create({
    email,
    method: input.method,
    roleConfigId: input.roleConfigId ?? null,
    tokenHash: hash,
    invitedByUserId,
    expiresAt: expiry(),
  });

  await deliver(invite, raw);
  return view(invite);
}

export async function listInvites(): Promise<InviteView[]> {
  return (await repository.list()).map(view);
}

/**
 * POST /users/invites/:id/resend — a new token and a new week. The old link
 * stops working, which is the point: a link that was forwarded to the wrong
 * person is retired by resending.
 */
export async function resendInvite(id: string): Promise<InviteView> {
  const invite = await requireOpenInvite(id);
  const { raw, hash } = mintToken();
  const refreshed = await repository.refresh(invite.id, hash, expiry());
  await deliver(refreshed, raw);
  return view(refreshed);
}

export async function revokeInvite(id: string): Promise<InviteView> {
  const invite = await requireOpenInvite(id);
  return view(await repository.revoke(invite.id));
}

async function requireOpenInvite(id: string): Promise<AdminInvite> {
  const invite = await repository.findById(id);
  if (!invite) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
  if (invite.acceptedAt) throw new ApiError(409, 'CONFLICT', 'That invitation has already been accepted.');
  if (invite.revokedAt) throw new ApiError(409, 'CONFLICT', 'That invitation has been revoked.');
  return invite;
}

/* ── the anonymous half ──────────────────────────────────────────── */

/** GET /auth/invites/:token — what the accept screen draws before anybody types. */
export async function describeInvite(rawToken: string): Promise<{
  email: string;
  method: AdminInviteMethod;
  expiresAt: Date | null;
  valid: boolean;
}> {
  const invite = await repository.findByTokenHash(hashToken(rawToken));
  if (!invite || statusOf(invite) !== 'OPEN') {
    // A spent, revoked, expired or invented token all answer the same way, and
    // never name the address: the token is the only thing proving the caller
    // was invited at all.
    return { email: '', method: 'PASSWORD', expiresAt: null, valid: false };
  }
  return { email: invite.email, method: invite.method, expiresAt: invite.expiresAt, valid: true };
}

export type AcceptResult =
  | { stage: 'OTP_SENT'; mobile: string; expiresInSeconds: number; resendAfterSeconds: number; sendsRemaining: number; devOtp?: string }
  | { stage: 'ACCEPTED'; user: { id: string; email: string | null; mobile: string; name: string | null }; roles: Role[] };

/**
 * POST /auth/accept-invite — anonymous, and two steps.
 *
 * Without `otpCode` it sends one to the number given. With it, it creates the
 * account. The number is re-checked at both steps because minutes pass in
 * between and somebody else may have registered it.
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptResult> {
  const invite = await repository.findByTokenHash(hashToken(input.token));
  if (!invite || statusOf(invite) !== 'OPEN') {
    throw new ApiError(400, 'BAD_REQUEST', 'This invitation is no longer valid. Ask for a new one.');
  }

  const mobile = normalizeMobile(input.mobile);
  if (await repository.findUserByEmail(invite.email)) {
    throw new ApiError(409, 'CONFLICT', 'An account already uses that email address.');
  }

  if (!input.otpCode) {
    // REGISTER refuses a number that already has an account and otherwise
    // creates the inert row the code hangs off — the same row this flow
    // promotes into the admin account at step two. Its 409 is the
    // "that number is taken" answer, so there is no second check here.
    const sent = await sendOtp(mobile, 'REGISTER');
    return {
      stage: 'OTP_SENT',
      mobile,
      expiresInSeconds: sent.expiresInSeconds,
      resendAfterSeconds: sent.resendAfterSeconds,
      sendsRemaining: sent.sendsRemaining,
      ...(sent.devOtp ? { devOtp: sent.devOtp } : {}),
    };
  }

  if (invite.method === 'PASSWORD' && !input.password) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a password to finish accepting this invitation.');
  }

  const userId = await verifyOtp(mobile, input.otpCode, 'REGISTER');

  // The row the first step created is a placeholder: a number, the PUBLISHER
  // role the OTP service gives a self-registration, and nothing else. It is
  // promoted rather than replaced, because deleting it would take the very
  // OTP row that just proved the number with it.
  const placeholder = await repository.findUserById(userId);
  if (!placeholder) throw new ApiError(409, 'CONFLICT', 'That number could not be confirmed. Start again.');
  if (placeholder.email) {
    throw new ApiError(409, 'CONFLICT', 'An account already uses that number.');
  }

  const user = await repository.promoteInvitee({
    inviteId: invite.id,
    userId,
    email: invite.email,
    name: input.name,
    passwordHash: input.password ? await hashPassword(input.password) : null,
    roleConfigId: invite.roleConfigId,
  });

  logger.info('Console invitation accepted', { inviteId: invite.id, userId: user.id });
  return {
    stage: 'ACCEPTED',
    user: { id: user.id, email: user.email, mobile: user.mobile, name: user.name },
    roles: user.roles.map((r) => r.role) as Role[],
  };
}
