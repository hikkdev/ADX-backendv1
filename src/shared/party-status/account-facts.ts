import { prisma } from '../database';

/**
 * The one column pair the lifecycle doors need from the account behind a
 * party — whether it signs in and whether it is closed — read by id.
 *
 * Here rather than a `users` export for the reason `shared/age-gate` gives:
 * the doors that ask (the KYC desks, the print-partner roster, the
 * notification writer) sit underneath `users`, so an export from there would
 * close a cycle. It reads two columns of one row.
 */
export async function findAccountFacts(userId: string | null | undefined): Promise<{ isActive: boolean; closedAt: Date | null } | null> {
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, closedAt: true } });
}

/** When the account was closed, or null — for a door that refuses a closed account. */
export async function accountClosedAt(userId: string | null | undefined): Promise<Date | null> {
  return (await findAccountFacts(userId))?.closedAt ?? null;
}
