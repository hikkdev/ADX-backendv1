import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { CONTACT_VERIFY_PURPOSE, sendEmailCodeToAddressForUser, verifyEmailCodeFor } from '../auth';
import { prismaUsersRepository as repository } from './prisma-users.repository';
import type { ProfileRow } from './users.repository';
import { mirrorBasicsToParties } from './users.service';
import { assertIdentityFree, normalizeContactValue } from './users-identity';

/**
 * ED-1 (the owner, 25 Sep 2026) — proving the account's own primary email.
 *
 * Every account proves its number and its email. The number is proved at
 * the door; the email is proved here when the account came in by the number
 * (the apps' first door, the website's second): a code to the address the
 * person typed, and on the answer the address becomes `User.email` with
 * `emailVerifiedAt` stamped. An account that came in by the email door has
 * both already (`auth.attachSignupEmail`).
 *
 * The code is filed under `CONTACT_VERIFY` against the address, exactly as a
 * contact's is, and the one-value-one-account rule runs at both ends —
 * another account may not be given this address in the ten minutes between.
 */
export type PrimaryEmailSend = Awaited<ReturnType<typeof sendEmailCodeToAddressForUser>> & { email: string };

export async function sendPrimaryEmailCode(userId: string, rawEmail: string): Promise<PrimaryEmailSend> {
  const email = normalizeContactValue('EMAIL', rawEmail);
  const user = await repository.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (user.email === email && user.emailVerifiedAt) {
    throw new ApiError(409, 'ALREADY_VERIFIED', 'This email address is already verified on your account.');
  }
  await assertIdentityFree('EMAIL', email, { ownPrimaryOf: userId });
  const sent = await sendEmailCodeToAddressForUser(userId, email, CONTACT_VERIFY_PURPOSE);
  return { ...sent, email };
}

export async function verifyPrimaryEmail(userId: string, rawEmail: string, code: string): Promise<ProfileRow> {
  const email = normalizeContactValue('EMAIL', rawEmail);
  const user = await repository.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  const owner = await verifyEmailCodeFor(email, code, CONTACT_VERIFY_PURPOSE);
  if (owner !== userId) throw new ApiError(401, 'UNAUTHORIZED', 'This code was not sent for your account. Request a new one.');
  await assertIdentityFree('EMAIL', email, { ownPrimaryOf: userId });

  const updated = await repository.updateProfile(userId, { email, emailVerifiedAt: new Date() } as never);
  await mirrorBasicsToParties(updated, { name: user.name, mobile: user.mobile }, { email });
  await logActivity(userId, 'EMAIL_VERIFIED', {
    module: 'users',
    targetType: 'User',
    targetId: userId,
    diff: auditDiff({ email: user.email }, { email }, ['email']),
    metadata: { via: 'PROFILE', from: user.email, to: email },
  });
  return updated;
}
