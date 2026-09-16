/**
 * P-B: the two facts the publisher's detail card reads from modules that sit
 * above this one in the graph.
 *
 * `revenue` imports `publishers` (`findPublisherForUser`, for the plan
 * orders) and `visits` reaches it through `orders` → `users`, so importing
 * either here would close a ring. The card declares what it needs and
 * bootstrap fills it with `revenue.runningSubscriptionForPublisher` and
 * `visits.visitsForPublisher`. Unregistered, the subscription is null and
 * the feed carries no visits — honest, and the rest of the card still reads.
 */

/** A visit as the feed draws it — the slice of `visits`' VisitCard the card needs. */
export type SummaryVisit = {
  kind: string;
  status: string;
  businessName: string;
  locality: string | null;
  scheduledFor: string | null;
  completedAt: string | null;
};

export type PublisherSummaryPort = {
  /** The plan the publisher is running on at `at`, or null. */
  runningSubscription(publisherId: string, at: Date): Promise<{ tier: string; endsAt: Date | null } | null>;
  /** The visits made to the publisher — scheduled, in progress or completed — newest first, at most `limit`. */
  visits(publisherId: string, limit: number): Promise<SummaryVisit[]>;
};

const unregistered: PublisherSummaryPort = {
  runningSubscription: async () => null,
  visits: async () => [],
};

let registered: PublisherSummaryPort = unregistered;

export function registerPublisherSummaryPort(port: PublisherSummaryPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetPublisherSummaryPort(): void {
  registered = unregistered;
}

export const publisherSummaryPort = (): PublisherSummaryPort => registered;
