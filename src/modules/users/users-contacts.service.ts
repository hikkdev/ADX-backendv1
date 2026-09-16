import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import type { ContactKind } from '../../shared/database';
import {
  CONTACT_VERIFY_PURPOSE,
  completeMobileChange,
  hasProvenEmail,
  sendEmailCodeToAddressForUser,
  sendOtpToNumberForUser,
  verifyEmailCodeFor,
  verifyOtp,
} from '../auth';
import { prismaUsersRepository as repository } from './prisma-users.repository';
import type { ContactRow, WithRoles } from './users.repository';
import { findUserLabels } from './users.service';
import { assertIdentityFree, findIdentityHolder, normalizeContactValue } from './users-identity';

export { assertIdentityFree, findIdentityHolder, normalizeContactValue } from './users-identity';

/**
 * K-B1 — a person's contacts beside the primary pair.
 *
 * `User.mobile` (the sign-in identity) and `User.email` stay the primary
 * pair; a `UserContact` row is every other number or address the account
 * answers to — a second phone, a work email, the number an admin was given
 * on a call. Three rules run through every write here:
 *
 *  - **A value belongs to one account.** `assertIdentityFree` refuses (409
 *    `CONTACT_TAKEN`) a value that is any user's primary or any contact —
 *    including the caller's own primary, which is not a contact but the
 *    identity. `details.which` says which, so the desk can say why.
 *  - **A contact starts unverified** and is proved with a code — to the
 *    phone through auth's `sendOtpToNumberForUser`, to the address through
 *    `sendEmailCodeToAddressForUser`, both under `CONTACT_VERIFY_PURPOSE` —
 *    or marked verified by an admin who heard it read back, with a reason.
 *  - **Make-primary is one transaction** (`repository.swapPrimary`): the
 *    contact's value becomes the primary, the old primary drops down to a
 *    contact row carrying the proof it had (Lot K2: a never-proved email
 *    drops down unverified), and for PHONE the post-swap work is the very same
 *    the self-service two-code change runs (`completeMobileChange`: sessions
 *    revoked, live codes expired, audit, the old number told). The person
 *    may only promote a verified contact; the desk may promote an unverified
 *    one with a reason, and the audit row says UNVERIFIED.
 */

export type ContactView = {
  id: string;
  kind: ContactKind;
  value: string;
  label: string | null;
  verifiedAt: Date | null;
  addedBy: { id: string; name: string | null };
  createdAt: Date;
};

export type ContactsView = {
  primary: {
    mobile: string;
    mobileVerifiedAt: Date | null;
    email: string | null;
    emailVerified: boolean;
  };
  contacts: ContactView[];
};

async function requireUser(userId: string) {
  const user = await repository.findWithRoles(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return user;
}

/** The contact, and only when it belongs to this account — a foreign id is 404, never a hint. */
async function requireContact(userId: string, contactId: string): Promise<ContactRow> {
  const contact = await repository.findContact(contactId);
  if (!contact || contact.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Contact not found');
  return contact;
}

export async function listContacts(userId: string): Promise<ContactsView> {
  const user = await requireUser(userId);
  const rows = await repository.findContacts(userId);
  const [labels, emailVerified] = await Promise.all([
    findUserLabels(rows.map((row) => row.addedById)),
    user.email ? hasProvenEmail(userId, user.email) : Promise.resolve(false),
  ]);
  return {
    primary: {
      mobile: user.mobile,
      mobileVerifiedAt: user.mobileVerifiedAt,
      email: user.email,
      emailVerified,
    },
    contacts: rows.map((row) => toView(row, labels.get(row.addedById)?.name ?? null)),
  };
}

export function toView(row: ContactRow, addedByName: string | null): ContactView {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    label: row.label,
    verifiedAt: row.verifiedAt,
    addedBy: { id: row.addedById, name: addedByName },
    createdAt: row.createdAt,
  };
}

export async function addContact(
  userId: string,
  actorId: string,
  input: { kind: ContactKind; value: string; label?: string | undefined },
): Promise<ContactRow> {
  await requireUser(userId);
  const value = normalizeContactValue(input.kind, input.value);
  await assertIdentityFree(input.kind, value);
  return repository.createContact({ userId, kind: input.kind, value, label: input.label, addedById: actorId });
}

export async function updateContactLabel(userId: string, contactId: string, label: string | null): Promise<ContactRow> {
  await requireContact(userId, contactId);
  return repository.updateContact(contactId, { label: label === '' ? null : label });
}

export async function removeContact(userId: string, contactId: string): Promise<ContactRow> {
  const contact = await requireContact(userId, contactId);
  await repository.deleteContact(contactId);
  return contact;
}

export type SendCodeResult = { kind: ContactKind; expiresInSeconds: number; resendAfterSeconds: number; sendsRemaining: number; devOtp?: string };

/** A code to the contact itself — the phone through the SMS rail, the address through the email rail. */
export async function sendContactCode(userId: string, contactId: string): Promise<SendCodeResult> {
  const contact = await requireContact(userId, contactId);
  if (contact.verifiedAt) throw new ApiError(409, 'ALREADY_VERIFIED', 'This contact is already verified');
  const result =
    contact.kind === 'PHONE'
      ? await sendOtpToNumberForUser(userId, contact.value, CONTACT_VERIFY_PURPOSE)
      : await sendEmailCodeToAddressForUser(userId, contact.value, CONTACT_VERIFY_PURPOSE);
  return {
    kind: contact.kind,
    expiresInSeconds: result.expiresInSeconds,
    resendAfterSeconds: result.resendAfterSeconds,
    sendsRemaining: result.sendsRemaining,
    ...(result.devOtp ? { devOtp: result.devOtp } : {}),
  };
}

/** The code came back — the row is verified. A code issued for another account is a refusal, never a hint. */
export async function verifyContact(userId: string, contactId: string, code: string): Promise<ContactRow> {
  const contact = await requireContact(userId, contactId);
  if (contact.verifiedAt) throw new ApiError(409, 'ALREADY_VERIFIED', 'This contact is already verified');
  const provedFor =
    contact.kind === 'PHONE'
      ? await verifyOtp(contact.value, code, CONTACT_VERIFY_PURPOSE)
      : await verifyEmailCodeFor(contact.value, code, CONTACT_VERIFY_PURPOSE);
  if (provedFor !== userId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'This code has expired. Request a new one.');
  }
  return repository.updateContact(contactId, { verifiedAt: new Date() });
}

/** The desk's word — the person read the code back on a call. The reason is on the audit row, not here. */
export async function markContactVerified(userId: string, contactId: string): Promise<ContactRow> {
  const contact = await requireContact(userId, contactId);
  if (contact.verifiedAt) throw new ApiError(409, 'ALREADY_VERIFIED', 'This contact is already verified');
  return repository.updateContact(contactId, { verifiedAt: new Date() });
}

export type PrimaryChange = {
  user: WithRoles;
  kind: ContactKind;
  before: string | null;
  after: string;
  /** False when the desk promoted an unverified contact — the audit row says UNVERIFIED. */
  wasVerified: boolean;
};

/**
 * The swap. `allowUnverified` is the desk's power only; the person's own
 * route passes false and an unverified contact answers 409
 * `CONTACT_NOT_VERIFIED`. For PHONE the post-swap work is `completeMobileChange`,
 * under the caller's audit action (`USER_PRIMARY_CHANGED` from the desk,
 * `USER_MOBILE_CHANGED` from the person) — so the desk's audit row carries the
 * before/after pair, the reason and the actor, while every session and live
 * code on the old number goes exactly as the two-code change does.
 */
export async function makePrimary(
  userId: string,
  actorId: string,
  contactId: string,
  options: { allowUnverified: boolean; action: string; metadata?: Record<string, unknown> | undefined },
): Promise<PrimaryChange> {
  const user = await requireUser(userId);
  const contact = await requireContact(userId, contactId);
  const wasVerified = contact.verifiedAt !== null;
  if (!wasVerified && !options.allowUnverified) {
    throw new ApiError(409, 'CONTACT_NOT_VERIFIED', 'Verify this contact before making it the primary.');
  }

  // A stale row cannot take the identity: the value must still be free of
  // every OTHER account's primary. Its own contact row is the one being promoted.
  const holder = await findIdentityHolder(contact.kind, contact.value);
  if (holder && (holder.which === 'PRIMARY' || holder.contactId !== contact.id)) {
    throw new ApiError(409, 'CONTACT_TAKEN', 'This value now belongs to another account.', { kind: contact.kind, value: contact.value, ...holder });
  }

  const before = contact.kind === 'PHONE' ? user.mobile : user.email;
  // Lot K2 (Lot K verifier): the old primary drops down with the proof it
  // actually had — the phone's stamp; for an email, verified now only when
  // `hasProvenEmail` says a code was ever answered at it, else unverified.
  const previous =
    contact.kind === 'PHONE'
      ? { value: user.mobile, verifiedAt: user.mobileVerifiedAt }
      : user.email
        ? { value: user.email, verifiedAt: (await hasProvenEmail(userId, user.email)) ? new Date() : null }
        : null;

  const updated = await repository.swapPrimary({
    userId,
    contact,
    previous,
    actorId,
    verifiedAt: contact.verifiedAt,
  });

  const metadata = { ...(options.metadata ?? {}), changedBy: actorId, verified: wasVerified ? 'VERIFIED' : 'UNVERIFIED', contactId };
  if (contact.kind === 'PHONE') {
    await completeMobileChange(userId, user.mobile, contact.value, { action: options.action, module: 'users', metadata });
  } else {
    // An email is not the sign-in identity, so no session goes; the row is
    // the same shape as the phone's, with the before/after pair.
    await logActivity(userId, options.action, {
      module: 'users',
      targetType: 'User',
      targetId: userId,
      diff: auditDiff({ email: before }, { email: contact.value }, ['email']),
      metadata: { from: before, to: contact.value, ...metadata },
    });
  }

  return { user: updated, kind: contact.kind, before, after: contact.value, wasVerified };
}
