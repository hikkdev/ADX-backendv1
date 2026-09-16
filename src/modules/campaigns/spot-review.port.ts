/**
 * E7-2: which of a campaign's spots have been reviewed, without importing
 * the module that holds the reviews.
 *
 * `reviews` imports this module — `findCampaignSpotForReview` and
 * `assertMayAct` decide whether a spot may be reviewed — so this module
 * importing `reviews` back would close a cycle. The one question the
 * detail read asks is declared here as a port and bootstrap fills it with
 * `reviews.reviewIdsForCampaignSpots`, the way `orders` takes its creative
 * gate: for these spot ids, which carry a review, and which review.
 *
 * Unregistered, every spot reads as unreviewed — the phone's "Rate this
 * spot" prompt shows, and the POST refuses a second review anyway.
 */

export type SpotReviewPort = {
  /** spot id → review id, for the spots that have one. */
  reviewIdsForSpots(spotIds: string[]): Promise<Map<string, string>>;
};

const NONE: SpotReviewPort = { reviewIdsForSpots: async () => new Map() };

let registered: SpotReviewPort = NONE;

export function registerSpotReviewPort(port: SpotReviewPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetSpotReviewPort(): void {
  registered = NONE;
}

export function spotReviewPort(): SpotReviewPort {
  return registered;
}

/** The two fields each spot carries on GET /campaigns/:id. */
export type SpotReviewMark = { reviewed: boolean; reviewId: string | null };

/**
 * Stamps every spot with whether it was reviewed. A port that fails leaves
 * the spots unmarked rather than failing the read — the review is a
 * decoration on the booking, not the booking.
 */
export async function withSpotReviews<T extends { spots: { id: string }[] }>(campaign: T): Promise<Omit<T, 'spots'> & { spots: (T['spots'][number] & SpotReviewMark)[] }> {
  const marks = await registered.reviewIdsForSpots(campaign.spots.map((spot) => spot.id)).catch(() => new Map<string, string>());
  return {
    ...campaign,
    spots: campaign.spots.map((spot) => ({ ...spot, reviewed: marks.has(spot.id), reviewId: marks.get(spot.id) ?? null })),
  };
}
