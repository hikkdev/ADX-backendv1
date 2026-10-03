import { prisma } from '../database';
import { ApiError } from '../errors';
import { orderAgeProblem, todayInIndia, type OrderAgeProblem } from '../validation';

/**
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders."
 *
 * One guard, asked at every door where a person commits a purchase — before
 * money moves or a booking is made: a campaign's checkout (wallet or
 * gateway), its reservation fee, an accepted design quote, a display ad or
 * a sponsored listing, an advertiser package or a publisher plan, and the
 * auto-renew switch that buys the next term. Signing up, browsing, a draft,
 * the workspace and listing a space ask nothing.
 *
 * WHOSE age. The person behind the ACCOUNT the order is for — the User the
 * advertiser (or publisher) row hangs on — whoever presses the button. On
 * the advertiser's own phone that is the signed-in user. When their agent
 * or the desk acts for them (an agent authorising the campaign they built,
 * ops authorising on the advertiser's behalf, ops recording an offline
 * payment) it is still the account holder, never the agent or the admin:
 * the order is the account holder's contract, and the agent and the admin
 * are adults engaged for work already. An account with no login behind it
 * has no date of birth on file, so it is MISSING until one is added.
 *
 * Lives in `shared` because every order module needs it and several of them
 * sit underneath `users` (`users` → `advertisers` → `wallets`), so a users
 * export would close a cycle. It reads one column of one row.
 *
 * 403 AGE_REQUIRED, `details: { reason: 'MISSING' | 'UNDER_18', self }` —
 * `self` false when the caller is acting for someone else, so a client only
 * offers its own "Add your date of birth" field to the person themselves.
 */

/** The party an order is for — the shape `payments`' Payer and `promotions`' Buyer already have. */
export type OrderingParty = { kind: 'ADVERTISER' | 'PUBLISHER'; id: string };

export type AgeGateOptions = {
  /** Who is pressing the button. When it is not the person being checked, the words are about "the account holder". */
  actorUserId?: string | null | undefined;
  now?: Date | undefined;
};

export type AgeRequiredDetails = { reason: OrderAgeProblem; self: boolean };

const SELF_MESSAGE: Record<OrderAgeProblem, string> = {
  MISSING: 'Add your date of birth to place an order — you need to be 18 or over.',
  UNDER_18: 'You need to be 18 or over to place an order.',
};

const ON_BEHALF_MESSAGE: Record<OrderAgeProblem, string> = {
  MISSING: "Add the account holder's date of birth to place this order — they need to be 18 or over.",
  UNDER_18: 'The account holder is under 18 — an order needs someone 18 or over.',
};

/** The refusal itself — exported so a test (or a door that already holds the date) builds the same one. */
export function ageRequiredError(reason: OrderAgeProblem, self = true): ApiError {
  const details: AgeRequiredDetails = { reason, self };
  return new ApiError(403, 'AGE_REQUIRED', (self ? SELF_MESSAGE : ON_BEHALF_MESSAGE)[reason], details);
}

/**
 * The person `userId` may place an order: a date of birth on file, the 18th
 * birthday on or before today (the Indian day). Null `userId` — an account
 * with no login behind it — is MISSING.
 */
export async function assertAdultForOrders(userId: string | null | undefined, options: AgeGateOptions = {}): Promise<void> {
  const self = !options.actorUserId || options.actorUserId === userId;
  if (!userId) throw ageRequiredError('MISSING', self);
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true } });
  const problem = orderAgeProblem(row?.dateOfBirth ?? null, todayInIndia(options.now));
  if (problem) throw ageRequiredError(problem, self);
}

/** The account holder behind a party — the advertiser's or the publisher's login; null when it has none. */
export async function orderingPersonOf(party: OrderingParty): Promise<string | null> {
  if (party.kind === 'ADVERTISER') {
    return (await prisma.advertiser.findUnique({ where: { id: party.id }, select: { userId: true } }))?.userId ?? null;
  }
  return (await prisma.publisher.findUnique({ where: { id: party.id }, select: { userId: true } }))?.userId ?? null;
}

/** The order is the party's: their account holder must be 18 or over (see the file note on whose age). */
export async function assertPartyAdultForOrders(party: OrderingParty, options: AgeGateOptions = {}): Promise<void> {
  const userId = await orderingPersonOf(party);
  // No login behind the account: whoever is asking is not its holder, so the words are the account holder's.
  if (!userId) throw ageRequiredError('MISSING', false);
  await assertAdultForOrders(userId, options);
}
