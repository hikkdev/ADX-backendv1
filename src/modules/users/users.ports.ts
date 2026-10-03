import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';

/* ------------------------------------------------------------------ */
/* The print shop's application door — PP-1                            */
/* ------------------------------------------------------------------ */

/**
 * PP-1 (the owner, 21 Sep 2026): the sign-up's third side, "I print and
 * install", opens the account as a print-partner application. The row and
 * the PRT id belong to `print-partners`, but that module reaches `orders`
 * (a job reads its order) and `orders` notifies through `users`, so `users`
 * cannot import it back without a cycle. The dependency is inverted the way
 * auth's resolvers are: this module declares the question, `print-partners`
 * answers it, and `bootstrap/register-modules` introduces them.
 *
 * Unregistered, choosing the party is a 503 — the door is not open until the
 * module that owns it is wired, and a half-opened account would be worse
 * than a refusal.
 */
export type PartnerApplicationPort = {
  apply(
    userId: string,
    input: { name: string; legalName?: string | null; mobile: string; email?: string | null },
  ): Promise<{ partner: { id: string; displayId: string | null }; created: boolean }>;
};

let partnerApplication: PartnerApplicationPort | null = null;

export function registerPartnerApplicationPort(port: PartnerApplicationPort | null): void {
  partnerApplication = port;
}

export async function applyAsPrintPartner(
  userId: string,
  input: { name: string; legalName?: string | null; mobile: string; email?: string | null },
): Promise<{ partner: { id: string; displayId: string | null }; created: boolean }> {
  if (!partnerApplication) {
    throw new ApiError(503, 'PARTY_UNAVAILABLE', 'Print partner applications are not open on this server');
  }
  return partnerApplication.apply(userId, input);
}

/* ------------------------------------------------------------------ */
/* Deactivate / Reactivate, cascaded onto the profiles                 */
/* ------------------------------------------------------------------ */

/**
 * Account lifecycle (2 Oct 2026): a user's Deactivate also suspends the
 * user's publisher, advertiser and agent profiles with BLOCK_NEW, and
 * Reactivate lifts exactly what Deactivate placed. The suspension module owns
 * that act, and it imports `users` (the actor labels), so the door is a port
 * `bootstrap/register-modules` fills. Unregistered, the user's sign-in still
 * switches and the profiles are left as they are, logged.
 */
export type ProfileRef = { partyType: string; partyId: string };
export type AccountLifecyclePort = {
  onDeactivated(userId: string, byUserId: string): Promise<ProfileRef[]>;
  onReactivated(userId: string, byUserId: string): Promise<ProfileRef[]>;
};

let lifecycle: AccountLifecyclePort | null = null;

export function registerAccountLifecyclePort(port: AccountLifecyclePort | null): void {
  lifecycle = port;
}

export async function cascadeDeactivation(userId: string, byUserId: string): Promise<ProfileRef[]> {
  if (!lifecycle) {
    logger.warn('User deactivated with no lifecycle port: the profiles were not suspended', { userId });
    return [];
  }
  return lifecycle.onDeactivated(userId, byUserId);
}

export async function cascadeReactivation(userId: string, byUserId: string): Promise<ProfileRef[]> {
  if (!lifecycle) {
    logger.warn('User reactivated with no lifecycle port: the profiles were not reinstated', { userId });
    return [];
  }
  return lifecycle.onReactivated(userId, byUserId);
}
