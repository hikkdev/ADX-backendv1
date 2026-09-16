/**
 * The publishers' stars, read back for the ledger — Lot D (Q19/Q112).
 *
 * `reviews` owns the Review table and imports this module to write the
 * `AgentRating.reviewAvg / reviewCount` snapshot after every rating, so the
 * rating cannot import `reviews` back to list the recent ones without a
 * cycle. The same shape as `lead-layer.port.ts`: this module declares what it
 * needs, `reviews` implements it, bootstrap wires it. Unregistered, the
 * ledger simply carries no review rows — the score still does, because the
 * snapshot columns are read here directly.
 */

export type AgentReviewEntry = {
  reviewId: string;
  rating: number;
  note: string | null;
  at: Date;
  /**
   * E7-2: who rated them, from `Review.authorPublisherId` — the ledger is
   * the one place the agent reads the name (the frame draws it); the
   * listing page's reviews stay anonymous. Null when the publisher is gone.
   */
  publisherName: string | null;
};

export interface AgentReviewPort {
  /** Published reviews of this agent since `from`, newest first, a handful. */
  recentReviews(agentId: string, from: Date): Promise<AgentReviewEntry[]>;
}

const EMPTY: AgentReviewPort = { recentReviews: async () => [] };

let port: AgentReviewPort = EMPTY;

export function registerAgentReviewPort(implementation: AgentReviewPort): void {
  port = implementation;
}

/** Tests only: back to the empty feed. */
export function resetAgentReviewPort(): void {
  port = EMPTY;
}

export function agentReviewFeed(): AgentReviewPort {
  return port;
}
