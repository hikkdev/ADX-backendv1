import { ApiError } from '../../shared/errors';

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
