# visits

DR 06's field visit: the trip that is not a step on an order.

The platform's only visit was an `OrderMilestone`, whose `orderId` is
non-nullable, so an onboarding call on a lead or a renewal call on an
advertiser could not be recorded anywhere, and the Visits list in the agent app
could only draw milestones. `FieldVisit` is the model that can hold the rest.
`LeadActivity` still records that a visit was booked; the visit itself lives
here, and `leads.bookVisit` creates it.

## Lot F: the offer leaves by the dispatcher

An ADX-dispatched visit tells the agent through one `notify('VISIT_OFFER', agentUserId, { agentName: 'ADX', address, when, minutes }, { inApp })` — the in-app ORDER row plus the seeded `visit-offer` SMS, subject to the agent's ORDER preference; never a failure of the booking.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /visits/mine` | any session | The agent's list. `?scope=TODAY\|UPCOMING\|PAST` (default TODAY), `?status`, `?kind`, `?q`. |
| `POST /visits` | any session | An agent books for themselves (lands SCHEDULED); ADMIN with `agentId` dispatches (lands REQUESTED, 25-minute clock). Lot E: `kind` may be `AUDIT`; `campaignTag` optional. |
| `GET /visits/:visitId` | owner or ADMIN | One visit as the card draws it. |
| `POST /visits/:visitId/accept` | owner | Inside the window, or **410 `OFFER_EXPIRED`**. |
| `POST /visits/:visitId/reject` | owner | Declines, with a reason. |
| `POST /visits/:visitId/schedule` | owner | Sets or moves the slot. |
| `POST /visits/:visitId/start` | owner | SCHEDULED → IN_PROGRESS. |
| `POST /visits/:visitId/complete` | owner | Done — and paid (see below). |
| `POST /visits/:visitId/update-location` | owner | G12-B: the order lane's position ping (`{ latitude, longitude }`, numbers; 400 `latitude and longitude required` with no details, as `POST /orders/:id/update-location`), answering `{ success: true }` with no `data` key. `FieldVisit` has no agent-location column and no order to land on, so the ping goes to the live-position store (`visit-location.store.ts`): one Redis key per visit, `visits:location:<visitId>`, holding the order row's shape `{ latitude, longitude, updatedAt }` with a 24-hour expiry; `getVisitLocation(visitId)` reads it back. A ping, not a state change — a settled visit is not refused; a Redis blink drops one ping with a log line, never a failed request. |
| `GET /visits` | ADMIN | The dispatch board. `?date=YYYY-MM-DD` narrows to one Indian day; `?agentId`, `?city` (Lot X-L: a slug or a name, matched by the city key — see below), `?kind`, `?campaignTag`. |
| `PATCH /visits/:visitId` | ADMIN | Reassign (a fresh offer with a fresh clock), reslot, cancel, annotate. |
| `GET /agents/me/day` | any session | The agent's day: jobs, site visits and field visits in one sorted list. E7-2: a FIELD_VISIT entry also carries `visitKind` (ONBOARDING … AUDIT) and `campaignTag`, beside the `Audit · <business>` title; the cards on `/visits/mine` and `/visits` carry `kind` and `campaignTag`, and both lists take `?kind=AUDIT`. |

`/mine` and `POST /` are not role-gated beyond a session because both agent
sides make visits. The dispatch board is the cross-agent view that did not
exist anywhere before.

## The city key (Lot X-B)

`FieldVisit` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`createVisit`; null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. Lot X-L: `GET /visits?city=` (ADMIN) takes a slug (a name still resolves) through `pricing.cityKeyFor` and matches by the key, the `contains` spelling only for rows whose key is null; a facet that resolves to no key matches only null-keyed rows — so 'Bengaluru' and 'Bangalore' are one board. The city clause and `q` each own an OR and sit in one AND list. `GET /geo/unresolved` lists the typed strings with no key across the eight party tables.

## Invariants

- **A suspended agent is offered no visit.** Lot A's BLOCK_NEW is checked on
  every path that puts a visit on somebody's day: ADX dispatching one, an agent
  booking their own, and a reassignment — which is a fresh offer with a fresh
  clock, and so a fresh dispatch. `cancelAgentVisits` is the other half:
  STOP_OPEN_WORK takes every REQUESTED and SCHEDULED visit off them with the
  reason on it, and leaves anything in progress or finished alone, because that
  work happened.
- **Seven statuses, four pills.** REQUESTED / SCHEDULED / IN_PROGRESS /
  COMPLETED / DECLINED / EXPIRED / CANCELLED is the machine; `visitPillOf`
  folds it onto the card's New request / Scheduled / Completed / (settled)
  pills so the app never keeps a second list.
- **Booking for yourself is already accepted.** Nobody offers themselves work:
  an agent's own `POST /visits` lands SCHEDULED with no clock. ADX dispatching
  to a named agent is an offer, and it gets the same 25 minutes an order offer
  gets — the two clocks must agree or an agent learns two rules for one thing.
  `expiresInSeconds` on the card is the countdown; the server keeps the clock,
  the phone only draws it.
- **The clock is enforced.** Accept after `offerExpiresAt` is a **410**, the
  same code the order lane uses. `jobs/agent-timer` sweeps REQUESTED visits
  whose window closed in the tick — only that window, so a restart cannot
  re-expire history.
- **Completion pays.** `IncentiveRate` has priced `SITE_VISIT` since DR 04 and
  nothing ever recorded one. `completeVisit` records the incentive at the
  agent's tier, landing PENDING for finance to release like every other
  incentive, and copies the amount onto the visit so "₹145 earned" on the card
  is the wallet's figure, not a second calculation. A completion with no rate
  configured is still a completion; `earned` is **null**, never zero.
- **The three chips are windows, not statuses.** TODAY is anything open with a
  slot inside the Indian day, plus a request with no slot yet; UPCOMING is open
  and slotted after today; PAST is everything settled, newest first. They are
  computed server-side against `dayWindowIST` because the hosts run UTC and a
  phone re-implementing the +05:30 boundary drifts. The status histogram is
  counted over the window without the status facet, so the chips never
  collapse.
- **Exactly one party.** A visit is to a lead, a publisher or an advertiser —
  the table's `FieldVisit_one_party` check says so, and the schema refuses a
  body with two or none before Postgres has to.
- **The day is owned here.** `GET /agents/me/day` is composed of visits, so it
  lives in this module and bootstrap mounts `agentDayRouter` under
  `/agents/me/day` before `/agents`. Putting it in `agents` would close the
  cycle `agents → visits → agents`.

## Lot B (Q1): what came of a visit

A package sale or a campaign made on a visit carries the visit's id
(`PackageSale.visitId`, `Campaign.visitId`), and the visit reports the outcome
by counting them rather than keeping a second record of the work.
`GET /visits/:id` carries `outcomes: { sales, campaigns, summary }` — sales
sent or paid, campaigns SCHEDULED onwards — and the day view prints `outcome`
("1 sale, 1 campaign launched", or null) beside each field visit.

The gate is here too: `assertVisitOutcome(visitId, agentId, now)` is what
`packages` and `campaigns` ask before accepting a `visitId` — the agent's own
visit, in progress now or completed today (404 / 403 / 409 otherwise). An
outcome recorded against last week's visit is a story, not a record.

## Lot E (Q99): AUDIT, the campaign tag, and the diary overlay

- **`AUDIT` is the fifth kind** — a data audit or poster check. It goes
  through the same machine and the same completion as the other four, so it
  is paid at the visit rate (`IncentiveRate` SITE_VISIT) without a rate of
  its own. `VISIT_KIND_LABELS` / `visitKindLabel` name the five for the card
  and the diary ("Audit · Nilgiri Coffee").
- **`campaignTag`** on dispatch groups the visits of one drive ("Delhi
  onboarding drive"); the card prints it back and the dispatch board filters
  on it (`?campaignTag`, case-insensitive). Free text, at most 80 characters.
- **`agentWorkInWindow(agentProfileId, { start, end }, include)`** is the
  day view's fold — jobs, site visits, field visits onto one row shape —
  generalised over a range and exported for `schedule`'s read-only overlay on
  the staff diary. Each row carries a `link` (`/orders/:id`,
  `/orders/:orderId/milestones/:id`, `/visits/:id`); `include` says which
  tables to ask at all. Visits in the range come from `findScheduledInRange`
  — slotted, any status — because a diary should show a declined visit as
  declined, not pretend it was never booked; unslotted requests have no day
  and stay with the day view. `getAgentDay` uses the same fold and strips the
  links, so the phone's shape is unchanged. The direction stays
  `schedule → visits → agents / orders / order-milestones`: no cycle.

## Lot A

`cancelAgentVisits(agentId, reason)` is `suspension`'s STOP_OPEN_WORK on an
agent. `countOpenVisitsForAgent(agentId)` is the same set counted, read by
`account-lifecycle` for the closure review (Q21) — reported, never a blocker,
because closing the account releases those visits through the suspension a step
later.

## P-B

`visitsForPublisher(publisherId, limit)` is the visits made to one publisher —
SCHEDULED, IN_PROGRESS or COMPLETED (a declined or expired offer never
happened to them) — newest first, at most `limit` (200 at most), as
`VisitCard`s. Read by `publishers`' detail card for its activity feed, through
the port bootstrap fills, since this module reaches `publishers` through
`orders` → `users`.

## Probing

Every query in `prisma-visits.repository.ts` was run against Neon with the
`probe_` sample data: a lead booking (SCHEDULED, no clock), an ADMIN dispatch
(REQUESTED, `clockSeconds: 1500`), the TODAY window with counts, the day view
with `fieldVisits: 2`, a completion with `earned: "500.00"`, the dispatch board,
and the sweep expiring a stale request.
