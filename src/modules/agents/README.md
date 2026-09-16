# agents

Field workers with an `AgentProfile`, plus their milestone board and training
library.

```
agents/
  agents.*            the AgentProfile directory and requireAgentProfile
  dashboard.service   GET /agents/me — the DR 01 dashboard header
  tier-ladder         BRONZE I … PLATINUM I, computed from onboardings
  milestones/         AgentMilestone, MilestoneTemplate, TrainingResource
```

## Three things called "milestone", and "agent"

| Name | What | Where |
| --- | --- | --- |
| **agent milestones** (here) | agent gamification — targets, rewards, tiers | `AgentMilestone`, `MilestoneTemplate` |
| `order-milestones` | per-order fulfilment checklist | `OrderMilestone`, `MilestonePlan` |
| `employees` | internal staff HR records | `Employee` |

They share vocabulary and nothing else. Do not merge them.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/agents` | ADMIN — the only way an agent comes to exist; issues an `AGT-` identifier. Lot V: `createAgent` passes `pricing.assertCityAllows(city, 'agentOnboarding')` — 400 `CITY_NOT_OPEN` in a catalogued city whose rollout stage is not onboarding agents (PLANNED, PAUSED, WITHDRAWN); a town the catalogue lacks is free text |
| GET | `/api/v1/agents/me` | `authenticate` + an agent profile (404 without) — the dashboard header |
| GET | `/api/v1/agents` | ADMIN |
| GET | `/api/v1/agents/:id` | ADMIN — E10-1: `user` carries `closedAt`, `closeReason` beside `id, name, mobile, email, isActive` (Lot A, Q21), the way the publisher and advertiser reads do; null when no account backs the profile. N3-B: `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }` — the `AgentKyc` record's summary (joined on `findById`), `state` derived by `shared/kyc-state` the way `GET /agent-kyc` derives it: AWAITING_DOCUMENTS from the moment the profile exists (there is no mirror column on the profile), REQUESTED after the desk's one click, PENDING once recorded, then the decision — so the agent page and the queue agree |
| GET | `/api/v1/milestones?chip=` | `authenticate` (agent's own board: `{ tier, milestones, claimable, active, counts }`) |
| POST | `/api/v1/milestones/:milestoneId/claim` | `authenticate`, owner (**201**; 409 on a second claim or an incomplete one) |
| GET | `/api/v1/milestones/templates` | ADMIN |
| POST | `/api/v1/milestones/templates` | ADMIN (**201**) |
| GET | `/api/v1/milestones/templates/:templateId` | ADMIN |
| PATCH | `/api/v1/milestones/templates/:templateId` | ADMIN |
| GET | `/api/v1/agents/:id/milestones` | ADMIN — any agent's board, derived the same way |
| GET | `/api/v1/agents/me/tier` | `authenticate` — the rung, the ladder, the benefits, the promotion to celebrate once |
| POST | `/api/v1/agents/me/tier/ack` | `authenticate` — `{ eventId }`; the once |
| GET | `/api/v1/agents/me/leaderboard?period=WEEK\|MONTH\|ALL` | `authenticate` |
| GET | `/api/v1/agents/tier-ladder` | ADMIN — thresholds and support lines |
| PUT | `/api/v1/agents/tier-ladder` | ADMIN — `{ rungs?, supportLines? }`; a ladder that does not climb is a 400 |
| GET | `/api/v1/agents/leaderboard?city=&period=` | ADMIN — the same board, nobody's own row |
| GET | `/api/v1/agents/:id/tier` | ADMIN — with history |
| PATCH | `/api/v1/agents/:id/tier` | ADMIN — pin `{ tier, level, reason }` or unpin `{ tier: null, reason }`; an event and an activity log either way |
| GET | `/api/v1/training` | `authenticate` |
| POST | `/api/v1/training` | ADMIN (**201**) |

`GET /agents/:id/reviews` (ADMIN) is **not** here — it is `reviews`', mounted
ahead of this router (Lot D, Q112).

## The city key (Lot X-B)

`AgentProfile` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`createAgent` and `updateAgent` (the party importer goes through both); null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. `GET /agents?city=` takes a slug (a name still resolves) and matches by the key, the spelling only for rows whose key is null; the leaderboard's cohort is keyed the same way — the agent's own key off the profile, the desk's `?city=` resolved once — so an agent typed "Bangalore" ranks in Bengaluru.

## Owned Prisma entities

`AgentProfile`, `AgentMilestone`, `MilestoneTemplate`, `TrainingResource`.

`AgentProfile` rows are *created* by `users` when an agent role is granted;
`agents` owns them from then on.

## Public exports (`index.ts`)

- `agentRouter`, `milestoneRouter`, `trainingRouter`.
- **`requireAgentProfile(userId)`** — resolves the caller's agent profile or
  throws `404 Agent profile not found`. Used by `orders`, `order-milestones`,
  `earnings` and `publishers`.
- `findAgentProfile(userId)` — the same lookup without the throw.
- `findAgentTier(agentId)` — Lot B: the tier an incentive is recorded at, by
  profile id, for `orders`, `publishers`, `advertisers` and `campaigns`.
- `MilestoneBoard`, `MilestoneCard`, `TemplateView`, `MILESTONE_STATES`,
  `MILESTONE_CHIPS` — the board's vocabulary, for the apps and the console.
- `setAgentReviewSnapshot(agentId, { reviewAvg, reviewCount })` — Lot D
  (Q112): `reviews` recomputes the publishers' stars on every rating and
  hands the aggregate here, so `AgentRating.reviewAvg / reviewCount` stay
  this module's columns. `registerAgentReviewPort` / `AgentReviewPort` — the
  ledger's feed of recent reviews, filled by `reviews` through bootstrap
  (inverted because `reviews` imports this module). Unregistered, the ledger
  carries no review rows; the score still does.
- `listActiveAgentsForDirectory(q?)` — Lot E (Q99): ACTIVE profiles whose
  user can sign in, with the name and the rung ("GOLD II"), for `hr`'s
  people registry (`GET /hr/people`), which unions them with the active
  staff. Agents are assignable on the staff diary; this is how it finds them.

## The rating's fourth driver (Lot D, Q19/Q112)

The publishers' stars join the three derived drivers in
`rating/rating.rules.ts` at weight **0.2** — completion 0.4, on-time 0.2,
rejection 0.2, review 0.2 — and are re-weighted away while `reviewCount` is
0, so an agent nobody has rated scores exactly as before the lot. Four stars
is neutral (the base score's goodness), five lifts, below four drags. The
ledger row is `+0.1` for five stars, `0` for four, `−0.1` for three or
fewer (`DELTA.fiveStars` / `fourStars` / `threeStarsOrLess`). `ratingFor`
reads the snapshot columns for the score and the port for the ledger;
`saveSnapshot` never touches the two review columns. E7-3: both reads —
`GET /agents/me/rating` and `GET /agents/:id/rating` (ADMIN) — carry the
snapshot columns themselves as `reviewAvg` (a decimal string, null before a
first star) and `reviewCount`, so the console prints the stars beside the
score rather than deriving them from the driver's rate.

## Milestones (DR 05)

- **Progress is derived on read, never incremented.** `incrementMilestoneProgress`
  — the hook nobody called — is gone. Each type reads a counter that already
  exists: `ONBOARDING` the two counts the tier ladder climbs on; `ACTIVITY`
  completed `FieldVisit`s plus accepted `ListingVerification`s; `REVENUE`
  credited `AgentIncentive`s, as a `Decimal`; `QUALITY` on-time arrivals,
  judged by the rating's own `arrivedOnTime`. The row's `progress` is a cache
  written only when the derivation moved (the `AgentRating` rule), and
  `completedAt` is stamped the first time the target is reached and never again.
- **Windows.** `windowDays` with no `startsAt` counts from the agent's own row —
  the clock began when the milestone appeared on their board; neither means all
  time. The deadline ("30th APR") and "Due in 10 days" are derived, not stored.
- **Six states, four chips.** `LOCKED` (`unlockAfter` not met) · `UPCOMING`
  (`startsAt` ahead) · `ACTIVE` · `COMPLETED` · `CLAIMED` · `EXPIRED`, filed
  under All / Active / Upcoming / Completed by `chipOf`. The lock is checked
  before the start date because "complete 2 milestones first" is the more
  useful sentence. `EXPIRED` is under All only.
- **The claim pays the template's reward.** `POST /milestones/:id/claim` records
  a `MILESTONE_BONUS` through `payouts.recordIncentive` with the template's
  `rewardAmount` as the amount (the rate table's flat row is the fallback for a
  template that names no reward), TDS withheld at earn time, landing
  `PENDING_VERIFICATION` for finance to release. The app words it honestly: the
  money is recorded, ops release it. A milestone claims once — 409 the second
  time, and `AgentMilestone_claim_is_recorded` says the same in SQL.
- **`rewardAmount` is `Decimal(14,2)`** since `20260911100000_milestones_move`;
  it was one of two `Float` money columns in the schema. Request bodies take it
  as a decimal string.
- **A template can be created inactive** and ordered, so a bad one no longer
  pollutes every agent's board the instant it exists.
- **The dashboard hero** (`GET /agents/me` → `milestone`) is the first `ACTIVE`
  card, derived from the same counters.

## The tier ladder (DR 05)

- **`AgentProfile.tier` is the `AgentTier` enum with `tierLevel` beside it**
  since `20260911110000_tier_ladder`. The console prints what the agent sees.
- **The dashboard read is still the writer**, through `tier/tier.service.ts`
  `syncTier` — but a change is now an `AgentTierEvent` (a fall too, instead of
  dropping silently), a promotion to a new *tier* records the `TIER_BONUS` the
  rate table prices for that tier (nothing when none is priced), and a pinned
  tier is left where ops put it.
- **Thresholds come from the `tier-ladder` app-config row**, `LADDER` is the
  fallback, and `validLadder` refuses a table that does not start at 0, climb
  strictly and never repeat a rung — so a bad ladder is a 400 at the desk, not
  a default forever after.
- **Benefits are real or absent (decision 8).** A bonus row appears only when a
  `TIER_BONUS` rate exists for the tier, worded as what it is (recorded on
  promotion, released by finance); a support line only when ops stored one in
  the `support-lines` row. "Priority lead assignment" is not listed: nothing
  assigns leads by tier.
- **The GOLD Achieved screen fires once.** `promotion` on `GET /agents/me/tier`
  is the newest unacknowledged *climb*; `POST /agents/me/tier/ack` stamps it.
- **Pinning is the explicit door.** `PATCH /agents/:id` still cannot write
  `tier`; `PATCH /agents/:id/tier` needs a reason, writes the event with
  `byUserId`, and `logActivity`s it.

## The leaderboard (DR 05)

- **Earnings are credited `AgentIncentive`s** — the only earnings the platform
  records for an agent (`EarningAccrual` is a publisher's) — summed as
  `Decimal`; gaps are `Decimal` subtraction. Pending money does not count.
- **The cohort is the city**, the way the rating's percentile does it, with
  the same `MIN_COHORT = 10` floor: below it there is no board.
- **Rolling windows**, not calendar ones (a calendar week on Monday morning
  ranks nobody); the delta is the rank in the previous window of the same
  length. `ALL` has no delta.
- **Decision 9, what leaves the server:** the podium's three figures, ranks
  4–10 as rank/name/locality, the viewer's own figure and the gaps to their two
  neighbours. Nobody else's absolute figure is sent.
- **There is no prize.** `prize` is `null`; the app draws the podium without
  the words.

## The duplication this module retired

`prisma.agentProfile.findUnique({ where: { userId } })` followed by
`throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found')` appeared
**twelve times** across `publisher`, `order`, `orderMilestone` (×4), `earnings`
(×2), `milestone`, `digio` (×2) and `agent`. It is now one function. If the
message or status ever needs to change, it changes once.

## Invariants

- **BLOCK_NEW is asked once, and answered here.** `agentAcceptsWork` (and its
  throwing twin `assertAgentAcceptsWork`, 409 `AGENT_SUSPENDED`) is what the
  order lane, `visits`, `order-milestones` and `leads` all call before putting
  work in front of an agent. It is true only for an ACTIVE profile carrying no
  BLOCK_NEW: the two move together, and both are checked so a hand-edited
  status cannot let work through a live suspension. `findAssignable` filters on
  both for the same reason. The columns themselves are written by
  `modules/suspension`, never here; `GET /agents/me` carries them so the app can
  say why no offers are arriving.
- The agent listing meta is `{ total, limit, offset }` — **not** the
  `{ page, pageSize, total, totalPages }` shape the other admin listings use.
  Both are contract; do not normalise.
- `search` matches the **joined user's** name or mobile, not agent-profile
  fields.
- The by-id join includes `email`; the listing join does not.
- `GET /milestones` materialises rows lazily: every active template the agent
  has no row for is created on read, so a new template appears for everyone
  without a backfill. It also returns the agent's `tier` alongside the board.
- `category=All` on the training listing is the UI's no-filter sentinel, not a
  real category.
- `incrementMilestoneProgress` advances every incomplete milestone of the given
  type by one and completes those reaching their target.

## The dashboard (`GET /agents/me`)

One request for everything DR 01 draws above the map: identity and city, the
sides the agent sells for (from roles, publisher first), the tier ladder
position, the wallet balance, and the day's counters. Computed, not stored:

- **Onboarded** = publishers attributed to the agent with
  `onboardingStatus = ONBOARDING_COMPLETE` + advertisers attributed with
  `activatedAt` set. Attribution alone (a scan that was approved) is not an
  onboarding.
- **Tier** comes from `tier-ladder.ts` — one table, PROVISIONAL thresholds,
  `rungFor(total)` — and is **written back** to `AgentProfile.tier` when it
  differs, so the admin listing's tier column agrees with the app. This is the
  field's only writer.
- **Today** is the Indian day (fixed +05:30 — the hosts run UTC): orders the
  agent holds whose `slotTime` falls in it or that are `IN_PROGRESS` /
  `PENDING_OTP`, and — as `visits` — visit milestones assigned to the agent
  due in it or already `IN_PROGRESS` **plus** (G12-B) the agent's DR 06 field
  visits, SCHEDULED / IN_PROGRESS, slotted in it or already under way. The
  field visits are counted on the `FieldVisit` table inside
  `prisma-agents.repository.countToday` rather than through `visits`, because
  `visits` imports this module and reaching back would close the cycle.
- **Leads** is an empty list. There is no Lead model (raised in the brief, not
  guessed); the `LeadCluster` shape is declared so the map layer drops in
  without an app release.
- **Sales counters (Lot B, Q100).** `progress.packagesSold` (PackageSale by
  agentId, paid) and `progress.campaignsLaunched` (Campaign by agentId,
  SCHEDULED onwards) sit beside `onboarded`. `GET /agents/:id` carries the same
  four figures as `counters`. They are counters and nothing more: the ladder
  climbs on `onboarded.total` alone and the rating (`rating/`) never reads
  them — a counter the formula does not read is one that cannot quietly become
  a rating input later. A count that cannot be read prints 0 rather than
  failing the header.

## Tests

```bash
npx vitest run src/modules/agents
```

## Suggested ownership

Agent-experience team, alongside `earnings`.

## Profile, status and work preferences (D5)

`AgentProfile.status` is whether the agent is OFFERED WORK — `ACTIVE`,
`ON_LEAVE`, `SUSPENDED` — and is distinct from `User.isActive`, which is whether
they can sign in at all. `findAssignable` offers only `ACTIVE` agents, and only
those under their own `maxActiveOrders` (orders they hold from SLOT_PROPOSED to
PENDING_OTP), so both preferences are honoured by the auto-assign sweep rather
than merely stored.

The rest of the profile is DR 10's territory and DR 07's screens as ops records
them at the desk: `businessName` (edit profile), and the work preferences —
`homeZone`, `radiusKm`, `workingDays` (MON..SUN), `hoursFrom`/`hoursTo`
("HH:MM"), `autoAcceptInZone`, `orderTypes` (listing categories),
`maxActiveOrders`. `PATCH /agents/:id` (ADMIN) writes any of it including the
status; `GET|PATCH /agents/me/preferences` is the agent's own view of the
preference subset, for the DR 07 screen when it is built. Auto-accept is honoured by
the order lane: a spot in the agent's city — and home zone, when they named one — is
accepted for them the moment it is offered (`orders/assignment inZone`), through the
same assignment rows an answered offer leaves.

## Offer priority (DR 07's "keep rejections under 10%")

`shared/dispatch/offer-priority.ts` is the one rule, read here and by the orders history: over the last thirty days, fewer than five
offers is the fast lane; otherwise the share declined or left to expire, at or under
10 %, is the fast lane and above it is slowed. `findAssignable` reads each candidate's
recent answers and offers in that order — fast lane, lower rate, lighter load,
seniority — still under the cap. The console's agent page prints the lane and the
number behind it from `GET /orders/agents/:id/offers`. A lane, not a rating.
