/**
 * Order fraud screening — the reads behind the order signals and the
 * desk's cancel-impact (2 Oct 2026). One interface, one Prisma file behind
 * it (`prisma-order-screening.repository.ts`), read-only across the tables
 * the facts live in — the way `prisma-fraud-signals.repository.ts` reads
 * for the party signals. The order itself, and every write to it, goes
 * through `orders`.
 */

/** A party on the order, with the facts the linked-parties check compares. */
export type ScreeningParty = {
  id: string;
  userId: string | null;
  /** The agent the profile hangs off (`agentId`). */
  agentId: string | null;
  /** The agent's login, when an agent onboarded the party (QR-14 provenance, AGENT or QR). */
  onboardedByAgentUserId: string | null;
  createdAt: Date;
};

export interface OrderScreeningIndex {
  /** The advertiser profile the placing login holds, with when the login began; null when it holds none. */
  advertiserForLogin(userId: string): Promise<(ScreeningParty & { userCreatedAt: Date | null }) | null>;
  /** When the login began — the account's age when there is no advertiser profile. */
  loginCreatedAt(userId: string): Promise<Date | null>;
  /** The publisher whose listing it is; null when the listing has none. */
  publisherOfListing(listingId: string): Promise<ScreeningParty | null>;
  /** Orders the login placed in [from, to], inclusive. */
  countOrdersPlaced(userId: string, from: Date, to: Date): Promise<number>;
  /**
   * Other live orders (not cancelled, not refused) by the login on the same
   * listing whose flights overlap `window`; with no window, the undated
   * ones placed within a day of `placedAt`.
   */
  overlappingOrders(input: { userId: string; listingId: string; excludeOrderId: string; window: { start: Date; end: Date } | null; placedAt: Date }): Promise<{ id: string; displayId: string | null }[]>;
  /**
   * What the payments module records for the advertiser: failed attempts
   * (on the order's campaign when it has one, else in the day before the
   * order) and refunds over the last ninety days (gateway refunds and
   * campaign refunds).
   */
  paymentHistory(input: { advertiserId: string; campaignId: string | null; placedAt: Date; since: Date }): Promise<{ failedAttempts: number; refunds: number }>;
  /** CONFIRMED fraud cases on either party, and CONFIRMED_FRAUD orders by the login or on the publisher's spots — this order excluded. */
  priorConfirmedFraud(input: { advertiserId: string | null; publisherId: string | null; advertiserUserId: string; excludeOrderId: string }): Promise<{
    advertiserCases: number;
    publisherCases: number;
    advertiserOrders: number;
    publisherOrders: number;
  }>;
  /** What the publisher has been credited for this order's spot so far (net, rupees as a decimal string). */
  accruedForOrder(orderId: string): Promise<string>;
  /** The agents a cancel releases: the one holding the job and anyone with an offer still open. */
  agentsOnOrder(orderId: string, holdingAgentId: string | null): Promise<number>;
}
