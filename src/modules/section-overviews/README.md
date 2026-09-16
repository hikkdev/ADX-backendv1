# section-overviews

One overview read per user section — package O-B, 15 September 2026.

## Routes

```
GET /section-overviews/:section?from=YYYY-MM-DD&to=YYYY-MM-DD&city=   ADMIN — :section is publishers | advertisers | agents | print-partners | employees | users; cached 60 s per section + window + city
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
`agents.getLeaderboardForCity`, and the four label lookups
(`findPublisherLabels`, `findAdvertiserLabels`, `findAgentLabels`,
`findPrintPartnerLabels`). Both funnels are the platform's state now — the
exports take no window — and are said to be.

## Dependencies

`shared/cache` (the minute's cache), `shared/time`, `shared/money`,
`shared/pagination`, `shared/kyc-state` (the party-level where fragments),
`shared/database` (repository only). Modules: `supply`, `advertisers`,
`agents`, `employees`, `print-partners`, `publishers`, `pricing` — exports
only.

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

## What the platform does not record

Said here rather than invented: employees who LEFT in a window (no leaving
date; `isActive` flips without a timestamp), agents by department (agents
have none), a windowed funnel (both exports count the state now), the day an
advertiser's or publisher's account was closed as a party (only the login
closes), and sign-ins other than the latest (`lastLoginAt` is a single
column).
