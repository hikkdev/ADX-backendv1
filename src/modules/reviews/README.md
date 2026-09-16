# reviews

What people say about a spot or an agent — Lot D (Q5/Q19/Q104/Q112/Q137).
One table, and one rule under both halves: **every review hangs off the
transaction that earned the right to write it**. An advertiser reviews a spot
through the campaign spot that ran on it; a publisher rates an agent through
the order that agent installed. "24 reviews" is a claim about 24 bookings.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/api/v1/campaigns/:id/spots/:spotId/review` | `authenticate`; the campaign's advertiser (`campaigns.assertMayAct`, then the account itself) — **201** |
| GET | `/api/v1/listings/browse/:listingId/reviews` | `authenticate` — PUBLISHED only; `{ id, rating, note, createdAt }`, list contract |
| GET | `/api/v1/orders/:id/rate-agent/eligibility` | PUBLISHER \| AGENT_PUBLISHER; the listing's publisher — `{ askable, reason }` |
| POST | `/api/v1/orders/:id/rate-agent` | PUBLISHER \| AGENT_PUBLISHER; the listing's publisher — **201** |
| GET | `/api/v1/agents/me/reviews?q&sort&page&pageSize` | AGENT_PUBLISHER \| AGENT_ADVERTISER — E7-2: the agent's own stars, PUBLISHED only, list contract (`counts.PUBLISHED`); `{ id, rating, note, createdAt, orderId }`, never the publisher's name. Declared ahead of `/agents/:id/reviews` so `me` is never read as an id |
| GET | `/api/v1/agents/:id/reviews` | ADMIN — every status, list contract |
| GET | `/api/v1/reviews?subjectType&subjectId&status&q&sort&page&pageSize` | ADMIN — list contract with a status histogram |
| PATCH | `/api/v1/reviews/:id/hide` | ADMIN + `content.approve` — `{ reason }`; audited `REVIEW_HIDDEN` with the status diff |
| PATCH | `/api/v1/reviews/:id/unhide` | ADMIN + `content.approve`; audited `REVIEW_UNHIDDEN` |

The party-facing routes live in `reviewPartyRouter`, mounted by bootstrap on
the API router root **ahead of** `campaigns`, `listings`, `orders` and
`agents` (the way `suspension` is), each with its own `authenticate`; the
desk is `reviewRouter` under `/reviews`. A route registered after those
routers would enter their tree, be authenticated there, and fall out the
bottom.

## Owned Prisma entities

`Review` — `subjectType` LISTING \| AGENT, `subjectId`, the author (user, and
the publisher or advertiser account they acted as), the anchor
(ORDER \| CAMPAIGN_SPOT + id), `rating` 1–5 (CHECK), `note`, `status`
PUBLISHED \| HIDDEN (CHECK: hidden needs a reason), `hiddenReason`,
`hiddenById`. Unique on `(anchorKind, anchorId, subjectType)`; a partial
unique on `(authorPublisherId, subjectId)` for AGENT subjects.

The denormalised stars — `Listing.ratingAvg / reviewCount` and
`AgentRating.reviewAvg / reviewCount` — are **not** this module's columns.
They are recomputed here from the PUBLISHED rows on every write and handed
to `listings.setListingRatingSnapshot` and `agents.setAgentReviewSnapshot`.

## Public exports (`index.ts`)

- `reviewPartyRouter`, `reviewRouter`.
- `recentAgentReviews(agentId, from)` — fills the `AgentReviewPort` the
  `agents` module declares (its rating ledger's "publisher rated you" rows).
  Registered by bootstrap; inverted because this module imports `agents`.
  E7-2: each row carries `publisherName` from `Review.authorPublisherId` —
  the ledger is the one place the agent reads who rated them (the frame
  draws it); the listing page's and the agent's own list stay anonymous.
  The name is a read-only lookup of `Publisher.name` in this module's own
  repository, the way `announcements` reads its audience.
- `reviewIdsForCampaignSpots(spotIds)` — E7-2: fills the `SpotReviewPort`
  the `campaigns` module declares (`reviewed` / `reviewId` on each spot of
  `GET /campaigns/:id`). Registered by bootstrap; inverted because this
  module imports `campaigns`. Any status counts as reviewed.

## Dependencies

- `campaigns` — `assertMayAct`, `findCampaignSpotForReview`.
- `listings` — `getListingWithPublisher`, `setListingRatingSnapshot`.
- `orders` — `getOrderSummary`.
- `agents` — `setAgentReviewSnapshot` (and `findAgentProfile` to resolve the actor).
- `advertisers` — `getAdvertiserForUser` to resolve the actor.
- `notifications` — the publisher hears about a review of their spot.
- `shared/audit`, `shared/pagination`, `shared/errors`, `shared/database` (repository only).

## Invariants

- **A spot is reviewed by the advertiser the campaign ran for** (Q104) —
  `assertMayAct` first, then `actor.advertiserId === campaign.advertiserId`.
  ADX and the agent who built the campaign pass the first and fail the
  second: neither stood in front of the spot. Only a spot whose status is
  `COMPLETED` (409 `CONFLICT`); once per campaign spot (409 `REVIEW_EXISTS`,
  backed by the anchor unique). The advertiser is invited when the campaign
  ends — `campaigns.runCampaignTransitions` sends one BOOKING notification at
  COMPLETED. There is no publisher reply.
- **A publisher rates an agent once, ever** (Q112) — per publisher–agent
  pair, whatever the order; the partial unique backs it, and the service
  answers 409 `REVIEW_EXISTS` on the pair before the anchor. Asked from the
  on-site OTP onward: the order is `PENDING_APPROVAL` or `COMPLETED` and has
  an `agentId`. `/eligibility` returns `NO_AGENT`, `NOT_YET` or
  `ALREADY_RATED` so the app knows whether to draw the prompt.
- **The stars are recomputed on every write, from PUBLISHED rows only.**
  Hiding a review takes it out of the average at once; unhiding puts it
  back. The subject module writes its own columns through its export.
- **Hidden, never deleted.** The row stays as the record of what was said and
  why it was taken down. Hiding twice is 409; every hide and unhide is
  audited by hand (`targetType: 'Review'`, the status diff), so the generic
  admin-write tap writes no second row.
- **The public page never names the author** — `{ id, rating, note, createdAt }`.
- The listing review is logged `LISTING_REVIEWED` against the listing, so the
  desk's per-target audit read shows who reviewed what.

## The agent rating (Q112)

The publishers' stars are the **fourth driver** of `agents/rating`: weight
0.2 beside completion 0.4, on-time 0.2, rejection 0.2, re-weighted away
while `reviewCount` is 0 (so an unrated agent scores exactly as before).
Four stars is neutral, five lifts, below four drags. The ledger row is
`+0.1` for five stars, `0` for four, `−0.1` for three or fewer — see
`agents/rating/rating.rules.ts`.

## Tests

```bash
npx vitest run src/modules/reviews
```

## Suggested ownership

Marketplace — with `listings` on the supply side and `campaigns` on demand.
