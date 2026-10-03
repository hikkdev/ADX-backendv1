# section-overviews

One overview read per user section — package O-B, 15 September 2026.

## Routes

```
GET /section-overviews/:section?from=YYYY-MM-DD&to=YYYY-MM-DD&city=   ADMIN — :section is publishers | advertisers | agents | print-partners | employees | users | leads (LH9) | listings (2 Oct 2026) | campaigns (2 Oct 2026); cached 60 s per section + window + city
```

`from` and `to` are inclusive Indian days (the window opens at `from`'s IST
midnight and closes at the IST midnight after `to`), the last thirty days
ending today in India when absent, at most 366; `to` before `from` is a 400.
The **previous window** is the same number of days immediately before.
`city` narrows to the party's own `city` column, case-insensitively — the
section tables below say which; it never narrows `employees`, who have a
region and not a city. Feature `console.section-overviews` (CONSOLE).

Every answer carries `section`, `window` and `previousWindow` (each
`{ from, to, start, end, days }`), `city`, `generatedAt`, and then its tiles,
series, breakdowns and top tens. Every money figure is a decimal string.

### The three shapes

| Shape | What it is |
| --- | --- |
| **Figure** `{ value, previous, delta }` | A window figure against the previous window; `delta = value − previous`, signed. A **state** figure (the KYC queue, who is suspended now, who has a live listing) has no history on the platform, so `previous` and `delta` are `null` rather than a guess. `total` is the population as at each window's close (`createdAt` before it), so the two compare |
| **Series** `{ days[], previous[], total }` | One `{ day, value }` per Indian day of the window, zeros filled, the previous window's days beside it, and `total` a Figure over the two. Money series carry decimal strings |
| **List** `{ items, total, page, pageSize, counts }` | The list contract (`shared/pagination`), whole table on one page of 100; there is no status facet, so `counts` is `{}`. Top tens are the same shape with ten rows, each `{ key, label, displayId, href, … }` labelled through the owning module's export |
| **City row** `{ key, label, href, cityId, typed, count, … }` (Lot X-B) | Every `byCity` list: grouped **by the city key** (`cityId`), `key` the city's slug (what `?city=` takes), `label` its catalogue name, `href` the party list filtered by slug. The rows typed under towns with no key are ONE row — `key: "other"`, `label: "Other (typed)"`, `href: null`, `cityId: null` — with the raw strings under `typed`, so ops can see what to fold in (`GET /geo/unresolved` lists the same strings with counts) |

## Why this module reads other modules' tables

The rule is that a module does not query another's tables. A report is a sum
across the whole business, so this module — like `admin-overview` — is the
one kind that has to, and the port keeps the exception honest:
`SectionOverviewsRepository` is aggregates only; every method resolves to a
number, a decimal string, or grouped counts, never a row. The contract test
(`__tests__/repository-contract.test.ts`) calls every method and checks the
shape, and reads the Prisma source for any `find*` or write. The one
`findMany` is the department table's names beside their member counts — a
group per department. Two figures are raw `SELECT`s because Prisma's builder
cannot express them: the mean of a date difference (print turnaround) and a
`GROUP BY` over an unnested `text[]` (partners by capability). Both are one
aggregate each.

Series by day are `groupBy` over the timestamp column, folded into Indian
days here; a `@db.Date` column (`EarningAccrual.forDate`, `Holiday.date`)
groups by the day directly.

What another module already answers is carried through its export, never
re-derived: `supply.supplyFunnel`, `advertisers.advertiserFunnel`,
`employees.employeesOverview` and `employees.workloadReport`,
`agents.getLeaderboardForCity`, `agents.agentCostOverWindow` (CP-2 — a salary
record is a row, so the money is aggregated where it is owned and only the
total crosses the boundary), and the four label lookups
(`findPublisherLabels`, `findAdvertiserLabels`, `findAgentLabels`,
`findPrintPartnerLabels`). Both funnels are the platform's state now — the
exports take no window — and are said to be.

## Dependencies

`shared/cache` (the minute's cache), `shared/time`, `shared/money`,
`shared/pagination`, `shared/kyc-state` (the party-level where fragments),
`shared/database` (repository only). Modules: `supply`, `advertisers`,
`agents`, `employees`, `print-partners`, `publishers`, `pricing`, and since
LH9 `leads` (`leadFunnel`, `LEAD_STAGES`), and since 2 Oct 2026 `campaigns`
(`launchQueueSummary`, `WAITING_REASONS`) — exports only.

**The city facet (Lot X-B).** `?city=` is a slug (the console's older links
still pass a name — either resolves) — resolved once per read through
`pricing.cityKeyFor` into `Scope.cityId`. Every figure then narrows **by the
key**: a party row keyed to the city counts whatever it was typed as; a row
with no key counts when its spelling matches, case-insensitively; a facet
that resolves to no key (a typed town nobody catalogued) matches only rows
with no key. The one exception is `quoteRequestsByDay`: a `PrintQuoteRequest`
carries a typed city and no key, so it stays on the spelling. The repository's
one extra `findMany` is the `City` label lookup (`{ id, slug, name }` per key
in a breakdown) — never a party row.

## publishers

City: `Publisher.city`.

| Field | What it is |
| --- | --- |
| `tiles.total` | `Publisher` rows created before the window's close, against the previous window's close |
| `tiles.newInWindow` | `Publisher.createdAt` in the window |
| `tiles.active` | Publishers with at least one ACTIVE listing now (state) |
| `tiles.kyc` | `{ awaitingDocuments, requested, pending, needsInfo, rejected, verified }` — parties per queue state, `kycPartyStateWhere(state, mirror)` over `PublisherKyc` (state) |
| `tiles.suspended` | `suspendedAt` set (state) |
| `tiles.closed` | The publisher's login has `User.closedAt` (state) |
| `funnel` | `GET /supply/funnel`'s answer, through `supply`'s export — the platform's state now, not windowed and not narrowed by `city` |
| `series.newPublishers` | `createdAt` by day |
| `series.firstListingsPublished` | Publishers whose FIRST listing went live on the day — `_min(Listing.publishedAt)` per publisher, kept when it falls in the window |
| `series.firstBookings` | Publishers whose FIRST delivered booking day fell on the day — `_min(EarningAccrual.forDate)` per publisher. The accrual is the one table keyed by publisher that records a booking's delivery |
| `breakdowns.byCity` | Per `Publisher.city`: publishers, their ACTIVE listings, and `EarningAccrual.gross` in the window (`gmv`) |
| `breakdowns.byCategory` | Per listing category: publishers with a listing in it, and its ACTIVE listings |
| `breakdowns.bySubscriptionTier` | `PublisherSubscription` running now (`startsAt ≤ now`, `endsAt` null or later) per tier |
| `breakdowns.byAgent` | `Publisher.agentId` counted, labelled through `agents`; `/agents/:id` |
| `top.byEarnings` | `EarningAccrual.net` per publisher for the window's days, ten largest; `amount`; `/publishers/:id` |
| `money.earningsPaid` | `EarningAccrual.net` for the window's days |
| `money.payoutsReleased` | `WithdrawalRequest.netAmount` PAID by `paidAt` from publisher wallets |

## advertisers

City: `Advertiser.city`.

| Field | What it is |
| --- | --- |
| `tiles.total`, `tiles.newInWindow` | As for publishers, over `Advertiser` |
| `tiles.active` | Advertisers with a campaign that ran on any day of the window — LIVE, PAUSED or COMPLETED with a flight overlapping it |
| `tiles.kyc` | The six states over `AdvertiserKyc` (state) |
| `tiles.byIndustry` | `Advertiser.industry` counted (also under `breakdowns`) |
| `funnel` | `GET /advertisers/funnel`'s answer, through `advertisers`' export — state now, not narrowed by `city` |
| `series.newAdvertisers` | `createdAt` by day |
| `series.firstCampaigns` | Advertisers whose FIRST paid campaign was paid on the day — `_min(Campaign.paidAt)` per advertiser, CANCELLED left out |
| `series.spend` | `Campaign.total` plus `PackageSale.total` by the day they were paid, neither CANCELLED — what advertisers committed, by the day they pressed pay |
| `breakdowns.byCity` | Per `Advertiser.city`: advertisers, and what they paid in the window |
| `breakdowns.byPackageTier` | `PackageSale` ACTIVE per tier |
| `breakdowns.byAgent` | `Advertiser.agentId` counted, labelled through `agents` |
| `top.bySpend` | Campaigns plus package sales paid in the window per advertiser, ten largest; `/advertisers/:id` |
| `money.walletBalanceHeld` | `Wallet.balance` summed over advertiser wallets (state) |
| `money.topUps` | `WalletTopUp.amount` by `receivedAt` into advertiser wallets |

## agents

City: `AgentProfile.city`.

| Field | What it is |
| --- | --- |
| `tiles.total`, `tiles.newInWindow` | Over `AgentProfile` |
| `tiles.active` | Agents with an order touched (`Order.updatedAt`) in the window, or a field visit scheduled or completed in it |
| `tiles.byRole` | `{ publisherAgents, advertiserAgents }` — `UserRole` AGENT_PUBLISHER / AGENT_ADVERTISER on logins with an agent profile; one agent may hold both |
| `tiles.byTier` | `AgentProfile.tier` counted (also under `breakdowns`) |
| `tiles.kyc` | The six states over `AgentKyc` (no mirror column) |
| `tiles.suspended` | `status` SUSPENDED or `suspendedAt` set (state) |
| `series.onboardingsDone` | `Publisher.activatedAt` plus `Advertiser.activatedAt` by day, with an agent on the party; the city is the agent's |
| `series.visitsCompleted` | `FieldVisit` COMPLETED by `completedAt` |
| `series.jobsCompleted` | `Order` COMPLETED by `adminApprovedAt` (the approval that completes an order), with an agent on it |
| `breakdowns.byCity` | `AgentProfile.city` counted |
| `top.byCommission` | `AgentIncentive.netAmount` CREDITED by `verifiedAt` per agent, ten largest; `/agents/:id` |
| `top.leaderboard` | `GET /agents/leaderboard`'s answer for the city through `agents`' export (period MONTH — the board's rolling thirty days, not this window); `null` without a city, because the board is a city cohort |
| `money.incentivesPaid` | `AgentIncentive.netAmount` CREDITED by `verifiedAt` |

## print-partners

City: `PrintPartner.city` (quote requests: the request's own `city`).

| Field | What it is |
| --- | --- |
| `tiles.total`, `tiles.newInWindow` | Over `PrintPartner` |
| `tiles.active` | `isActive` (state) |
| `tiles.acceptingQuoteRequests` | `isActive` and `acceptsQuoteRequests` (state) |
| `tiles.kyc` | The six states over `PrintPartnerKyc` |
| `tiles.byCity` | `PrintPartner.city` counted (also under `breakdowns`) |
| `series.quoteRequestsSent` | `PrintQuoteRequest.createdAt` by day |
| `series.quotesReceived` | `PrintQuote.submittedAt` by day |
| `series.jobsCompleted` | `PrintJob.collectedAt` by day — a job is complete when the prints were collected |
| `breakdowns.byCapability` | Partners per `capabilities[]` string; a partner with three counts in three |
| `top.byJobs` | Per partner: jobs collected in the window (`jobs`) and `actualCost` on them (`earnings`), ten by jobs then earnings; `/print-partners/:id` |
| `averageTurnaroundDays` | `{ value, previous, delta }` — mean of `collectedAt − requestedAt` in days over jobs collected in the window, two decimals, `null` with none |
| `awardsWon` | `quotes` submitted in the window, `awarded` of them ACCEPTED (each a Figure), and `sharePct` = awarded / quotes × 100 |

## employees

No city.

| Field | What it is |
| --- | --- |
| `overview` | `GET /employees/overview`'s answer through `employees`' export — `{ headcount: { total, active, inactive }, openPositions }` |
| `tiles.joined` | `Employee.createdAt` in the window — the join date the platform records |
| `tiles.kyc` | The six states over `EmployeeKyc` |
| `tiles.tenure` | Active employees by time since `createdAt`: `under1y` / `from1to3y` / `over3y` |
| `tiles.holidays` | `Holiday.date` in the window |
| `breakdowns.byDepartment` | Active departments: `headcount` (active members), `openRoles`; `/hr/departments/:id` |
| `breakdowns.byWorkMode`, `byEmploymentType`, `byRegion` | Active employees per `workMode` / `employmentType` / `region` |
| `workload` | `GET /employees/workload?granularity=month` over the window, through `employees`' export, verbatim |

## users

City: the party profile's city — a login is in a city when its publisher,
advertiser or agent profile says so.

| Field | What it is |
| --- | --- |
| `tiles.total`, `tiles.newInWindow` | Over `User` |
| `tiles.active` | `User.lastLoginAt` in the window. The column holds only the most recent sign-in, so a previous window counts only logins whose latest sign-in is still in it |
| `tiles.byRole` | `{ publisher, advertiser, agent, printPartner, admin, none }` — `UserRole` per role (`agent` is both agent roles), `none` the logins with no role row |
| `tiles.twoFactor` | `{ admins, enrolled, sharePct }` — ADMIN logins and those with `totpEnrolledAt`; platform-wide, not narrowed by `city` (admins have no party profile) |
| `tiles.closed` | `closedAt` set (state); `tiles.closedInWindow` by `closedAt` in the window |
| `tiles.erasureRequestsOpen` | `ErasureRequest` PENDING or APPROVED (state); platform-wide, not narrowed by `city` |
| `tiles.contactsVerified` | `{ verified, total, sharePct }` over `UserContact.verifiedAt` |
| `series.signUps` | `createdAt` by day |
| `series.signIns` | `lastLoginAt` by day — the same caveat as `active` |
| `breakdowns.byRole` | `UserRole` per role, labelled (Publisher agent, Print partner, …); `/users?role=` |
| `breakdowns.byLanguage` | `User.language` counted |
| `breakdowns.byCity` | Publisher, advertiser and agent profiles' cities counted and summed — a login with two profiles in one city counts twice |

## leads (LH9, the Lead Hunt, 22 Sep 2026)

City: `Lead.cityId` / `Lead.city`, the way every lead read keys it. The
hunt's money (`money.*`, the cost per activation) is scoped by the
**agent's** city — an incentive row carries no city of its own.

| Field | What it is |
| --- | --- |
| `tiles.open` | Leads neither converted nor lost now (state) |
| `tiles.newInWindow` | `createdAt` in the window |
| `tiles.contacted` | `firstContactedAt` in the window — stamped once, so a contact counts in one window |
| `tiles.converted`, `tiles.activated` | `convertedAt` / `activatedAt` in the window (the catch: first listing live / first campaign paid) |
| `tiles.lost` | Stage LOST reached inside the window (`stageChangedAt`) |
| `tiles.byTemperature` | Open leads by HOT / WARM / COLD now (state); `/leads/list?temperature=` |
| `funnel.byStage` | **`leads.leadFunnel`'s own answer over the leads CREATED in the window** (the desk's `/leads/funnel`, `to` the window's last instant), every stage in the pipeline's order (D12) with the count, the pipeline value (`estimatedValue` summed) and the average days in stage; `funnel.totals` and `funnel.lossMix` (D11) are the funnel's too |
| `series.newLeads`, `series.conversions`, `series.activations` | `createdAt` / `convertedAt` / `activatedAt` by day |
| `breakdowns.bySource` | The funnel's rows: leads in the cohort, how many converted / activated, the rate; `/leads/sources?key=` (the "No source" row has no link) |
| `breakdowns.byAgent` | The funnel's rows labelled through `agents.findAgentLabels`; `/agents/:id` |
| `breakdowns.byCity` | The repository's own keyed city rows (Lot X-B): leads created in the window per city and how many of that cohort converted; `/leads?city=` narrows this overview |
| `breakdowns.byCategory` | The funnel's rows; `/leads/list?category=` |
| `breakdowns.byChannel` | The funnel's D14 attribution: per channel, how many first contacts, engagements and conversions it produced (no link — nothing filters on a channel) |
| `conversion.timeToConvert` | Days from `createdAt` to `convertedAt` over the rows converted in the window — the mean and the **median** (`PERCENTILE_CONT`, one raw SELECT), null with none; the previous window's beside them |
| `conversion.costPerActivation` | `(incentives + topUps) / activations` — the LEAD_CONVERTED / ACTIVATED / RETAINED rows recorded in the window in any status but REJECTED (pending money is a cost already taken on), the priority rows (`orderId` `priority:…`, LH5) counted as `topUps`, over the catches in the window; null with no catch |
| `conversion.pipelineValue` | The funnel's per-stage values folded |
| `recycle` | Leads recycled in the window (`recycledAt`, stamped by the D11 recycle since LH9) and how many of those have converted since (`convertedAt >= recycledAt`, one raw COUNT) — the yield |
| `money.incentives`, `money.topUps` | The same two sums as figures against the previous window |

## listings (2 Oct 2026)

The owner asked for an Overview tab first on Listings like every other
section's. City: `Listing.cityId` / `Listing.city`, the listing's own. A
**booking** is a `CampaignSpot` on a campaign paid in the window, neither
the spot nor the campaign cancelled (the admin overview's breakdown counts
the same rows by listing); the **GMV** is `EarningAccrual.gross` over the
window's days, the column the publishers overview calls GMV.

| Field | What it is |
| --- | --- |
| `tiles.total` | Listings created before the window's close, every status (against the previous close) |
| `tiles.live`, `tiles.awaitingReview` | ACTIVE / PENDING_REVIEW now (states) |
| `tiles.suspended` | Status SUSPENDED or any `suspensionScopes` in force now (state) |
| `tiles.newInWindow` | `createdAt` in the window |
| `tiles.published` | `publishedAt` in the window — the published series' total |
| `tiles.bookings` | Booked spots, as above |
| `money.gmv` | Accrual gross, as above |
| `series.newListings`, `series.published` | `createdAt` / `publishedAt` by day |
| `work.renewals` | The renewals tab's queue counted: a leased / licensed / permitted spot (`rightsBasis` not OWNED) whose `rightsValidUntil` falls within 60 days (`due`) or is past (`lapsed`), in the statuses `supply.rightsDue` reads |
| `work.claimsOpen` | `ListingClaim` PENDING |
| `work.verification` | The verification tab's queue counted: ACTIVE or SUSPENDED listings whose `verificationExpiresAt` falls within the widest risk window (`supply.RISK_WINDOW_DAYS`, 15 days) or is past |
| `breakdowns.byStatus` | Listings per status now, in the lifecycle's order; `/listings/directory?status=` |
| `breakdowns.byCity` | Keyed city rows (Lot X-B): listings, the live ones, the accrual gross in the window; `/listings?city=` narrows this overview |
| `breakdowns.byCategory` | Listings, live ones and accrual gross per category; `/listings/directory?category=` |
| `breakdowns.byPublisher` | The ten publishers holding the most listings (unclaimed ones left out), with their live count, labelled through `publishers.findPublisherLabels`; `/publishers/:id` |

The publishers overview's category rows link to `/listings/directory?category=`
too since the same day — the table moved off `/listings`.

## campaigns (2 Oct 2026)

The owner: "Campaigns section feels too weak here" — an Overview tab first on
Campaigns, like Listings'. City: the market the campaign targets
(`Campaign.targetMarketCityId`, the typed `targetMarket` the fallback). The
**booked value** is the `total` of the campaigns PAID in the window
(`paidAt`), cancelled ones left out — the column the advertisers overview's
spend reads. Engagement is the `TrackingEvent` rows recorded in the window
(`SCAN`, `VIEW`, `CTA_CLICK`, `FORM_SUBMIT`), through the campaign's codes.
The launch queue is the `campaigns` module's (`launchQueueSummary`, the same
gates and population as `GET /campaigns/launch-queue`) — carried, not re-derived.

| Field | What it is |
| --- | --- |
| `tiles.live`, `tiles.scheduled`, `tiles.awaitingPayment` | LIVE / SCHEDULED / PENDING_PAYMENT now (states) |
| `tiles.waitingToLaunch` | Paid (or reservation-fee-paid) and blocked — the launch queue's size (a state) |
| `tiles.paid`, `tiles.completed`, `tiles.cancelled` | `paidAt` (not cancelled since), `completedAt`, `cancelledAt` in the window |
| `tiles.scans`, `tiles.landingViews`, `tiles.ctaClicks`, `tiles.enquiries` | The engagement events in the window |
| `money.bookedValue` | The booked value, as above |
| `series.bookedValue`, `series.scans` | `paidAt` by day (money), SCAN events by day |
| `work.launchingSoon` | SCHEDULED campaigns whose flight overlaps the next 7 days, today in India included (flight days are UTC midnights); `href` the directory on `status=SCHEDULED&from=<today>&to=<today+6>`, the same overlap |
| `work.endingSoon` | LIVE campaigns ending within the next 7 days; `href` the directory on `status=LIVE&sort=ENDING_SOON` |
| `work.waitingToLaunch` | `{ total, href: /campaigns/launch-queue, byReason }` — one `CountRow` per reason (`RESERVATION_FEE`, `PAYMENT`, `DESIGN_QUOTE`, `KYC`, `ARTWORK`, `PUBLISHER`, `AGENT`), each `href` the queue on that reason; a campaign waiting on two counts under both |
| `breakdowns.byStatus` | Campaigns per status now, in the lifecycle's order; `/campaigns/directory?status=` |
| `breakdowns.byCity` | Keyed city rows (Lot X-B): campaigns, the live ones, the booked value in the window; `/campaigns?city=` narrows this overview |
| `breakdowns.byGoal` | Campaigns and live ones per goal; `/campaigns/directory?goal=` |
| `breakdowns.byAdvertiser` | The ten advertisers whose campaigns paid in the window are worth the most — `{ key, label, displayId, href: /advertisers/:id, amount, count }`, labelled through `advertisers.findAdvertiserLabels` |

## Cost per onboarding (CP-2, 23 Sep 2026)

Three of the overviews carry a `cost` block: **publishers** and
**advertisers** get their own side's figure, **agents** the blended one.

This module contributes only the denominator — `onboardingsByProvenance`, a
count of accounts that finished onboarding in the window split by whether an
agent brought them (the QR-14 `onboardedVia` stamp: `AGENT` or `QR`). The
money is `agents.agentCostOverWindow`, because a salary record is a row and
this port is aggregates only.

```
cost.perOnboarding      = (salary committed + rewards paid) / agent-led onboardings
cost.allInPerOnboarding = the same, with the per-onboarding commission added back
```

Four decisions worth keeping straight:

1. **The denominator is agent-led only.** An account that signed itself up
   cost no agent anything; folding it in would flatter the figure every
   month. `onboardings.selfServe` is reported beside it, not hidden.
2. **The commission sits outside the basis.** It is the one payment that
   scales exactly with the thing being counted, so putting it in both the
   numerator and its own trigger tells you nothing the rate did not.
   `allInPerOnboarding` is there for anyone who wants the whole bill.
3. **Null is "not recorded", never "free".** Nothing onboarded, or no salary
   on record for any agent there, both answer null. A `₹0.00` would say the
   opposite of what is true, and the tiles print "Not recorded" and say which
   it is.
4. **The blended figure is not the two sides added up.** An agent holding
   both roles is counted on both, because their salary genuinely buys both.

`byCity` folds the two halves together by city key — the money by the agent's
own city, the onboardings by the party's — and the console draws it as a
"Cost each" column on the table each of those pages already has.

## What the platform does not record

Said here rather than invented: employees who LEFT in a window (no leaving
date; `isActive` flips without a timestamp), agents by department (agents
have none), a windowed funnel (both exports count the state now), the day an
advertiser's or publisher's account was closed as a party (only the login
closes), and sign-ins other than the latest (`lastLoginAt` is a single
column).
