# admin-overview

The console's month in numbers — Lot B (Q30/Q80), 12 September 2026.

## Routes

```
GET /admin/overview?month=YYYY-MM   ADMIN — the month it is now in India when omitted; cached 60 s per month
GET /admin/overview/series          ADMIN — Lot G (Q115): the day-granular series with the previous window beside it
GET /admin/overview/breakdown       ADMIN — GMV, bookings and earnings by category | city | publisher | advertiser | agent (list contract)
GET /admin/overview/tiles           ADMIN — active listings, fill rate and the four KPIs against the previous window
GET /admin/overview/export.csv      ADMIN — the series streamed as CSV; audited ANALYTICS_EXPORTED
GET /admin/overview/insights        ADMIN — Lot G (Q112): the rule-based dashboard insights, the caller's dismissals left out
POST /admin/overview/insights/:id/dismiss   ADMIN — G13-B: hide one row for this operator until its value changes (7 days at most)
```

Answers, every money figure a decimal string:

| Field | What it is |
| --- | --- |
| `bookingsAuthorised` | `Campaign.total` by `paidAt` in the IST month, status not CANCELLED, plus `PackageSale.total` paid in the month |
| `gmvRecognised` | The platform-side legs of `CAMPAIGN_SPEND` transactions by `occurredAt` in the month — what left advertiser wallets for media. Until any such leg exists on the database, the accrual's gross for the month's days, and `gmvSource` says which |
| `platformRevenue` | Net movement on `platform:revenue` in the month, reversals included |
| `takeRatePct` | `platformRevenue / gmvRecognised × 100`, two decimals; `"0.00"` when there is no GMV |
| `publisherEarnings` | `EarningAccrual.net` for the month's days |
| `activeCampaigns` | Campaigns that ran on any day of the month — LIVE, PAUSED or COMPLETED with a flight overlapping it |
| `newPublishers`, `newAdvertisers` | Rows created in the month |
| `kycPending` | Submitted and still PENDING across the four KYC tables. A queue, so not month-scoped |

The month is an Indian calendar month, `shared/time.monthWindowIST` — closed
at the next month's IST midnight, so a booking paid at 23:30 IST on the 31st
counts where the advertiser saw it on the receipt.

## Two figures that are not the same figure

Bookings authorised is commitment: the moment an advertiser pressed pay. GMV
recognised is delivery: the moment the money actually left the wallet, which
under B3a is the day the campaign starts, for the whole booking. The take rate
is ADX's revenue over the second, never the first — revenue is recognised as
each day accrues (the commission leg on `platform:revenue`), so a month with
many bookings captured and few days delivered reads low, and a month
delivering last month's bookings reads high. That is the truth of the books
rather than a smoothing of it.

## Why this module reads other modules' tables

The rule is that a module does not query another's tables. This is the one
kind of module that has to — a report is a sum across the whole business —
and the port keeps the exception honest: `AdminOverviewRepository` is
aggregates only, every method a `count` or a `_sum` over a window, so nothing
here can become a second write path or a second read model of any row. Add a
figure by adding an aggregate; if the figure needs a row, the module that owns
the row should export it instead.

## Dependencies

`shared/cache` (the minute's cache), `shared/time`, `shared/money`,
`shared/database` (repository only), `shared/pagination`, `shared/csv`,
`shared/audit` (the export). One module: `app-config`, for
`getPlatformSettings().insights` (Lot G).

## E6

Every month carries `bookingsCount` (campaigns + package sales paid in the
window, the same filter as `bookingsAuthorised`) and `averageBookingValue`
(`bookingsAuthorised / bookingsCount`, `"0.00"` when none).
`GET /admin/overview?from=YYYY-MM&to=YYYY-MM` answers `{ from, to, months[] }`
— one single-month shape per month, oldest first, each through the same
minute cache — at most 24 months; `from` and `to` go together, and `to`
before `from` is a 400.

## Lot G (Q115): the analytics set

Four reads over one idea — a day-granular walk over the ledger and the
orders, bucketed by Indian day, with the previous window of the same length
beside it. All ADMIN, all cached 60 s in Redis keyed by their query.

```
GET /admin/overview/series?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month&segment=ALL|PUBLISHERS|ADVERTISERS|AGENTS&category=&city=
GET /admin/overview/breakdown?from&to&by=category|city|publisher|advertiser|agent&q=&sort=&page=&pageSize=
GET /admin/overview/tiles?from&to
GET /admin/overview/export.csv?from&to&granularity&segment&category&city   — the series streamed; audited ANALYTICS_EXPORTED
```

`from` and `to` are inclusive Indian days (the window opens at `from`'s IST
midnight and closes at the IST midnight after `to`), at most 366 days; `to`
before `from` is a 400. The previous window is the same number of days
immediately before. `granularity` defaults to `day`; a `week` bucket starts
on Monday and a `month` bucket on the 1st, each labelled by its natural start
(`bucket`) with `start`/`end` clamped to the window, so the first bucket of a
range beginning mid-week is labelled by that week's Monday.

### The series

Every bucket carries, money as decimal strings:

| Figure | What it is |
| --- | --- |
| `gmvRecognised` | The platform-side `CAMPAIGN_SPEND` legs by the Indian day they were posted — the whole booking, captured when the campaign starts (B3a). Until any such leg exists on the database, `EarningAccrual.gross` by `forDate`, and `gmvSource` says which |
| `bookingsAuthorised` `{ count, value }` | `Campaign.total` by `paidAt` plus `PackageSale.total` by `paidAt`, neither CANCELLED |
| `publisherEarnings` | `EarningAccrual.net` by `forDate` |
| `advertiserSpend` | `gmvRecognised` plus the package sales paid — what left advertisers' wallets, media or not |
| `agentCommissions` | `AgentIncentive` CREDITED, by the day it was verified |
| `onboardingStats` | `publishersOnboarded` = `Publisher.activatedAt`; `advertisersOnboarded` = `Advertiser.activatedAt`; `agentsActivated` = `AgentKyc` VERIFIED by `reviewedAt` — the desk's decision is what turns an agent on |

`totals` sums the buckets; `previous.buckets` / `previous.totals` are the
same for the previous window; `comparison` puts them side by side per metric
as `{ current, previous, deltaPct }` — `deltaPct` is
`(current − previous) / previous × 100` to two decimals, `null` when the
previous figure is zero. The keys are `gmvRecognised`, `bookingsCount`,
`bookingsValue`, `publisherEarnings`, `advertiserSpend`, `agentCommissions`,
`publishersOnboarded`, `advertisersOnboarded`, `agentsActivated`.

Both windows are read in one pass (the repository is asked for the combined
span once) and split by day afterwards.

**Filters.** `category` (INDOOR | OUTDOOR | TRANSIT | MEDIA) and `city`
(case-insensitive) narrow through the listing. A capture is the whole booking,
so a filtered read sees the part of it the matching spots carry, in the ratio
of their line totals (by count when no spot is priced); the same share applies
to `bookingsAuthorised`. A package sale has no listing and drops out under
either filter. The city filter also reaches the agent's city (commissions) and
the parties' cities (onboarding); a category filter leaves those two alone,
because neither has one. `filters` echoes what was applied.

**Segments.** The buckets always carry every figure; `series` names the ones
the segment draws:

| Segment | `series` | Narrowing |
| --- | --- | --- |
| `ALL` | everything | none |
| `PUBLISHERS` | `gmvRecognised`, `publisherEarnings`, `publishersOnboarded` | none |
| `ADVERTISERS` | `bookingsCount`, `bookingsValue`, `gmvRecognised`, `advertiserSpend`, `advertisersOnboarded` | none |
| `AGENTS` | `bookingsCount`, `bookingsValue`, `gmvRecognised`, `agentCommissions`, `agentsActivated` | the money is agent-assisted bookings only — a campaign or a package sale with an agent on it |

### The breakdown

G11-1: every row also carries `previous: { gmvRecognised, bookings } | null`
— the same row over the window shifted back by its own length (null when
that group had nothing then) — and `deltaPct | null`, the GMV movement
against it (`deltaPct`, null when there is nothing to compare with or the
previous GMV was zero). The previous window's facts are read in the same
pass as the current ones (its accruals only while they are the GMV source;
earnings are not compared), the campaigns of both windows looked up once,
and the pair is cached together — sort, search and page never walk it again.

Lot X-B: `by=city` groups **by the listing's city key** — `key` the city's
slug, `label` its catalogue name, `href` `/listings?city=<slug>`; the spots
on listings typed under a town with no key are one row, `key: "other"`,
`label: "Other (typed)"`, with no link. The `?city=` filter on the series
and the CSV is a slug (a name still resolves), resolved once into
`AnalyticsFilter.cityId`: a spot, an agent's commission or an onboarding is
in the city by its key (whatever it was typed as), or — with no key — when
its spelling matches; a facet that resolves to no key matches only facts
with no key. The accrual reads are narrowed the same way in the repository.

GMV, bookings and earnings by one dimension, on the list contract
(`{ items, total, page, pageSize, counts }`; there is no status facet, so
`counts` is `{}`). Top publishers is `by=publisher` at the default sort. Each
row: `{ key, label, href, gmvRecognised, bookingsCount, bookingsValue,
publisherEarnings, sharePct }` — `href` is the console route
(`/publishers/:id`, `/advertisers/:id`, `/agents/:id`,
`/listings?category=`, `/listings?city=`), `sharePct` the row's GMV over the
window's. Under a listing dimension a booking is apportioned across its spots
by line total, and an accrual belongs to the spot's own listing; under
`advertiser` and `agent` a booking is whole, and `agent` lists assisted
bookings only. Package sales count for their advertiser and agent. `sort`:
`GMV_DESC` (default) | `GMV_ASC` | `BOOKINGS_DESC` | `BOOKINGS_ASC` |
`VALUE_DESC` | `VALUE_ASC` | `EARNINGS_DESC` | `EARNINGS_ASC` | `LABEL_ASC` |
`LABEL_DESC`; ties break on the label. `q` searches the label. The whole
table is computed and cached once per window and dimension; sort, search and
page are applied on the way out, so flipping a column never walks the ledger
again.

### The tiles

`{ activeListings, fillRate, gmvRecognised, takeRatePct, platformRevenue,
bookingsAuthorised, activeCampaigns, kycPending }` — each window figure as
`{ current, previous, deltaPct }` against the previous window, through the
same aggregates the month read uses. `activeListings` is
`{ count, newInWindow, previousNewInWindow, delta }` (G13-B): `count` is
listings ACTIVE now (a state, not a window figure), `newInWindow` and
`previousNewInWindow` are `Listing.publishedAt` in the window and in the one
before it, `delta` their difference — the frame's "1,092 up 64". `kycPending`
is the queue.

**Fill rate** is booked listing-days over available listing-days, over the
listings ACTIVE now, in the window:

- *available* = Σ over ACTIVE listings of `slotsTotal` × the days of the
  window from the day the listing was published — a listing published
  mid-window is not available before it was;
- *booked* = Σ over BOOKED, LIVE or COMPLETED spots on those listings of
  `quantity` × the days of the spot's flight inside the window.

`pct` is `booked / available × 100` to two decimals, `"0.00"` with nothing
available. Quantity is not capped at the slot count: an over-booked screen
reads over 100 %, which is the fact the tile is for.

### The CSV

`export.csv` streams the series — a header, then one CRLF line per bucket:
`bucket,start,end,gmvRecognised,bookingsCount,bookingsValue,publisherEarnings,advertiserSpend,agentCommissions,publishersOnboarded,advertisersOnboarded,agentsActivated`.
The pull is audited `ANALYTICS_EXPORTED` (module `admin-overview`, the query
and the bucket count) before the first byte, the way the audit trail's own
export is.

### What changed in the port

The repository grew a second kind of method beside the aggregates: a
window-scoped **fact** read — narrow, id-keyed rows the service buckets by
Indian day and apportions across a campaign's spots. Every fact read is
bounded by the bookings in the window (one row per capture, per paid booking,
per credited incentive, per party onboarded), never by listing-days; the one
table that grows by listing-days, `EarningAccrual`, is only ever read through
`groupBy`. Nothing returned can be written back. Dependencies gain
`app-config` (`getPlatformSettings`, for the insights below) and
`shared/pagination`, `shared/csv`.

## Lot G (Q112): the dashboard insights

```
GET /admin/overview/insights   ADMIN — cached 60 s
```

Rule-based now, AI later. Answers `{ generatedAt, items[] }`, each item
`{ id, key, severity: INFO|WARN|CRITICAL, text, href, value, direction? }` with
`href` the console route to open and `id` the stable id the dismiss route
takes (the rule key — a rule is one row). **Only a rule with something to say
appears** — a zero is silence, not an INFO row — so an empty list is the good
news. Thresholds are `getPlatformSettings().insights` (and
`kyc.reviewSlaHours`), edited on the settings page. Every count rule is WARN,
and CRITICAL from `insights.criticalCount` (default 10) up.

| Key | Rule | Threshold (default) | `href` |
| --- | --- | --- | --- |
| `GMV_VS_LAST_MONTH` | This Indian month's `gmvRecognised` against last month's (the two month reads above): `value` is the percentage, `direction` UP or DOWN. INFO on a rise or a small dip; WARN on a fall at or past `gmvDropWarnPct`; CRITICAL at or past `gmvDropCriticalPct`. Silent while last month was zero or the two are equal | `insights.gmvDropWarnPct` (10), `insights.gmvDropCriticalPct` (30) | `/analytics` |
| `KYC_PAST_SLA` | KYC records submitted, still PENDING, and older than the review SLA, across the four KYC tables | `kyc.reviewSlaHours` (48) | `/kyc` |
| `PAYOUT_BATCHES_AWAITING_APPROVAL` | `PayoutBatch` IN_REVIEW — built by one admin, waiting for the second | — | `/finance/payouts` |
| `WITHDRAWALS_AWAITING_RELEASE` | `WithdrawalRequest` APPROVED, decided longer ago than the release window, never released | `insights.withdrawalReleaseHours` (48) | `/finance` |
| `FRAUD_CASES_STALE` | `FraudCase` OPEN, INVESTIGATING or ESCALATED, opened more than N days ago | `insights.fraudOpenDays` (7) | `/disputes/fraud` |
| `SUPPORT_TICKETS_BREACHED` | The support queue's own `?breached=true` rule: not CLOSED, not paused, either clock past | the ticket's own due dates | `/support?breached=true` |
| `LISTINGS_FLOOR_GRACE_ENDING` | `PriceApproval` PENDING whose `graceUntil` falls within the next N days | `insights.floorGraceDays` (3) | `/pricing/approvals` |
| `CAMPAIGNS_PAYMENT_HOLD_ENDING` | Distinct PENDING_PAYMENT campaigns with a spot `reservedUntil` within the next N hours | `insights.paymentHoldHours` (2) | `/campaigns?status=PENDING_PAYMENT` |

Each count is one `count` in the repository; the rule, the text and the
severity live in `insights.service.ts`, so a new rule is a count plus a line.

### G13-B: dismissing a row

`POST /admin/overview/insights/:id/dismiss` (ADMIN) answers
`{ id, dismissed: true, expiresAt }` and hides that row **for the caller**
until the rule's value changes or seven days pass, whichever first. The
record is a Redis key per operator + id
(`admin-overview:insights:dismissed:<userId>:<id>`) holding a hash of the
row's `value` (and, for GMV, its `direction`), TTL seven days; the insights
read compares the stored hash with the live row and leaves matching rows
out, so a count that moves from 4 to 6 is news again. The computed list stays
one shared cache; only the filter is per caller. An `id` that is not a rule,
or a rule with nothing to say right now, is a 404. Redis being unreadable
answers the whole list rather than failing the dashboard.
