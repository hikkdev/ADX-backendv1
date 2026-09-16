import { ApiError } from '../../shared/errors';
import type { ContactKind } from '../../shared/database';
import { normalizeMobile } from '../auth';
import { prismaUsersRepository as repository } from './prisma-users.repository';

/**
 * K-B1 — one value, one account.
 *
 * The rule every identity write in this module runs through: a mobile or an
 * email is free only when no account signs in with it (`User.mobile` /
 * `User.email`) AND no `UserContact` row anywhere carries it. Kept apart from
 * the two services so the editor (`users.service`) and the contacts desk
 * (`users-contacts.service`) can both ask it without importing each other.
 */

export type Taken = { which: 'PRIMARY' | 'CONTACT'; userId: string; contactId?: string };

/** Lower-cased email; E.164 number. The unique index is on the normalised form. */
export function normalizeContactValue(kind: ContactKind, value: string): string {
  return kind === 'EMAIL' ? value.trim().toLowerCase() : normalizeMobile(value.trim());
}

/**
 * Who holds this value, if anybody: an account's primary, or a contact row
 * (anyone's, the owner's own included). Null when the value is free.
 * `ownPrimaryOf` names an account whose own primary does not count — for a
 * caller that has already decided the value is unchanged on that row.
 */
export async function findIdentityHolder(
  kind: ContactKind,
  value: string,
  options: { ownPrimaryOf?: string | undefined } = {},
): Promise<Taken | null> {
  const primary = kind === 'EMAIL' ? await repository.findByEmail(value) : await repository.findByMobile(value);
  if (primary && primary.id !== options.ownPrimaryOf) return { which: 'PRIMARY', userId: primary.id };
  const contact = await repository.findContactByValue(kind, value);
  if (contact) return { which: 'CONTACT', userId: contact.userId, contactId: contact.id };
  return null;
}

/** 409 `CONTACT_TAKEN` when the value is any user's primary or any contact row. */
export async function assertIdentityFree(
  kind: ContactKind,
  value: string,
  options: { ownPrimaryOf?: string | undefined } = {},
): Promise<void> {
  const holder = await findIdentityHolder(kind, value, options);
  if (!holder) return;
  throw new ApiError(
    409,
    'CONTACT_TAKEN',
    holder.which === 'PRIMARY'
      ? `This ${kind === 'EMAIL' ? 'email' : 'number'} is already an account's sign-in ${kind === 'EMAIL' ? 'email' : 'number'}.`
      : `This ${kind === 'EMAIL' ? 'email' : 'number'} is already on an account as a contact.`,
    { kind, value, ...holder },
  );
}

