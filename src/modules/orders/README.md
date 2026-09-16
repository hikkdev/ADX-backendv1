# orders

The campaign booking lifecycle: placement, publisher acceptance, agent
assignment, slot negotiation, installation, completion OTP, admin approval.

The largest module in the codebase and the one with real state-machine rules.

```
orders/
  placement/     placing an order against a listing
  assignment/    choosing an agent; escalation after three rejections; reassignment
  scheduling/    publisher accept/reject and slot negotiation
  fulfilment/    installation — agent-led, and publisher self-install
  verification/  completion OTP, admin approval, cancellation
  tracking/      site check-in and live agent location
  ops/           Lot D: the desk acting for a party who is not answering
```

Split by **lifecycle stage**, not by layer, because that is how the rules
cluster: everything about slot negotiation is in one file, everything about
agent selection in another.

## The state machine

```
PENDING_PUBLISHER ─accept→ PENDING_PRINT ─print-ready→ ┬→ PENDING_AGENT ─accept→ SLOT_PROPOSED
        │                                              │        ↑                     │
        └─reject→ PUBLISHER_REJECTED                   │   (reassign)          confirm ↓
                                                       │        │              SLOT_CONFIRMED
                        installBy = PUBLISHER ─────────┘        │                     │
                                     ↓                    reject-condition   collect-prints
                                SELF_INSTALL                    │                     ↓
                                     │                          └──────────────  IN_PROGRESS
                                     │                                                │
                                     └──────────────→ PENDING_APPROVAL ←─ OTP ── PENDING_OTP
                                                              │
                                                    approve ↓        cancel → CANCELLED
                                                        COMPLETED
```

## Owned routes

The routes under `/api/v1/orders` (`docs/route-inventory.json` is the count),
all `authenticate`d. `/my` and `/calendar` are registered **ahead of** `/:id`
or they would be read as an order id.

Role split: `ADVERTISER` places; `PUBLISHER` accepts, chooses fulfilment,
negotiates slots and self-installs; `AGENT_PUBLISHER` accepts assignments,
installs and verifies; `ADMIN` marks prints ready, assigns, reassigns,
approves, cancels, ends campaigns, and (Lot D) acts for a party who is not
answering. `GET /:id/agent-location` is `PUBLISHER` or `ADMIN` — the console's
live map reads the same ping.

`GET /:id/evidence` is deliberately open to anyone who may read the order: the
agent needs it to know what is still missing, and the publisher needs it to see
what was filed against their spot.

### The job ladder as data (Lot G, Q126/Q141)

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/job-ladder` | any session | the A1–A8 checklist the agent app draws — `{ label, description, version, steps: [{ key, number, title, subtitle?, hint?, cta?, proofs: [{ key, label }] }], source: 'config' \| 'code' }`. Literal path, ahead of `/:id` |

`fulfilment/job-ladder.ts` holds `CODE_AGENT_JOB_LADDER` — the frames' own
eight steps (OFFER, PICKUP, TRAVEL, CHECK_IN, BEFORE, INSTALL, AFTER,
COMPLETE) — and `jobLadder()`, which reads `flows.agent-job` through
`app-config`'s `getFlow`, checks it against `agentJobLadderSchema`, and serves
the code ladder when the key is absent, does not fit, or cannot be read (a
config outage must not stop a submission). **`fulfilmentEvidence` builds its
`requirements` from the ladder's proofs** — each `{ key, label, step, met }`
— so the submit gate and the phone's checklist read the same list, and the
evidence carries `ladder: { version, source }`. What a proof means is fixed
here (`CHECK_IN` the scan or the self-install stamp, `CONDITION` /
`INSTALLATION` / `PICKUP` photographs of those kinds on file); the ladder
says which a job waits for and what to print while one is missing. The
console cannot drop CHECK_IN, CONDITION or INSTALLATION — the vocabulary
refuses it — but may add PICKUP to the gate.

### The agent's offer (DR 01)

- **The window is 25 minutes** (`AGENT_RESPONSE_WINDOW_MINUTES`, one constant),
  the figure the sheet prints. `accept-agent` refuses a tap after
  `agentTimerExpiry` (`OFFER_EXPIRED`, 400); `jobs/agent-timer` sweeps every
  minute, records silence as `EXPIRED` on the assignment and re-offers the job
  through `autoAssignAgent`, which escalates to ops after three refusals.
- **`reject-agent` takes one of five reasons** (`AGENT_REJECTION_REASONS`:
  TOO_FAR, NOT_AVAILABLE, NO_EXPERTISE, AT_CAPACITY, OTHER — OTHER needs a
  `note`). Stored on `OrderAgentAssignment.rejectionReason` as the code, or
  `OTHER: <note>`.
- **The agent's tap is also their signature (Lot D, Q123).** `accept-agent`
  records a `JOB_TERMS` acceptance of the live template through
  `agreements.recordAcceptance` — the agent's own profile and user, this
  order, the tap's IP and user agent — before the assignment changes hands,
  and never on their behalf. No live job terms refuses the tap with 503
  `NO_ACTIVE_TEMPLATE`, the same stall the other parties meet.
- **Nothing prints until the artwork is approved (Lot D, Q120).**
  `print-ready` asks the `CreativeGatePort` (`creative-gate.port.ts`, filled
  by bootstrap from `campaigns.creativeGateForOrder`) before the pickup code
  is minted and before either fork, and refuses 409 `CREATIVE_NOT_APPROVED`
  — its own code, so the console routes to the creative review queue.
  Unregistered, the port answers "approved": an order with no campaign has
  no artwork to gate.
- **The pickup code (A9).** `print-ready` on the agent path mints an `ORDER`
  QR with `purpose: PICKUP` (one live per order; `qr` owns the row);
  `GET /:id/pickup-code` (ADMIN, or the holding agent) returns `{ qrId }` or
  null, and the image is `GET /qr/:id/image.png`. `collect-prints` takes an
  optional `qrId` and refuses one that is not this order's
  (`PICKUP_CODE_MISMATCH`).
- **`GET /:id/slot-candidates`** (holding agent, order at SLOT_PROPOSED with no
  time) returns the bands the drawn picker offers: three two-hour bands a day in
  IST over seven days, inside the booking's dates, minus bands in which the same
  publisher already has an agent confirmed. Derived, not a calendar — no
  publisher preference is recorded anywhere yet. See `scheduling/slot-candidates.ts`.

`/api/v1/orders/:orderId/milestones` is **not** here — it belongs to
`order-milestones` and is mounted separately, after this router. Neither are
`POST /orders/:id/rate-agent` and `GET /orders/:id/rate-agent/eligibility`
(Lot D, Q112) — they belong to `reviews`, mounted **ahead of** this router,
and read the order through `getOrderSummary`.

### The booking calendar (Lot G, Q114)

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/orders/calendar` | ADMIN — `?from&to&city&category&q&page&pageSize`. A **listings-first** read: every ACTIVE listing in the filter (paged on the list contract, the chips by listing category `INDOOR / OUTDOOR / TRANSIT / MEDIA` counted with the category facet removed), each carrying the orders overlapping the window on it, so a site with nothing booked appears as an empty row. `items[]` are `{ listing: { id, displayId, title, city, category, slotsTotal }, orders: [{ id, campaign: { id, reference, name }, status, from, to, slot }] }` — the campaign resolved through the order's `campaignSpot` (a direct booking has only the name typed on the order; `id`/`reference` null), `from`/`to` the flight, `slot` the confirmed installation appointment. The orders on a row are the ones that hold a slot over the window (`listings.slotHoldingOrdersWhere` — nothing drafted, cancelled or refused, a COMPLETED order until its `endDate`), so the grid shows exactly what placement counts against. The window defaults to today for thirty days, a `to` alone runs from today, and a span past 366 days or a `to` before `from` is 400. `q` searches the spot — title, address, city, display id — not the orders. Literal path, registered ahead of `/:id`. |

### Slots (Lot G, Q116/136)

`placeOrder` no longer refuses on the first booking: it counts the listing's
slots held over the order's own flight (today, when it has no dates) against
`Listing.slotsTotal` — 1 for a static wall, a screen's loop above it — and
refuses `LISTING_NOT_AVAILABLE` ("No slot left on this listing for those
dates", 400) only when fewer are left than the order takes.
`PlacementInput.forCampaignId` (what `campaigns` passes at authorise) keeps the
campaign's own reservation out of the count, and (G10)
`PlacementInput.quantity` — the campaign spot's, 1 for an order placed on its
own — is how many it takes; neither reaches the row.

**G10 — the count and the insert are one act** (the Lot G verifier's first
major): both run inside `repository.placeUnderListingLock(listingId, run)`,
one Prisma transaction whose first statement is
`SELECT pg_advisory_xact_lock(hashtext(listingId))`, released with the
transaction. `run` is handed a `PlacementLock` — `slotsHeld(window, options)`
(`listings.slotsHeldWith` on the transaction client, quantities summed) and
`create(data, accepted?)` — so two placements racing for the last slot queue
at the lock and the second counts the first's row. `campaigns`'
`holdReservations` takes the same lock on the same key, so a reservation and
a placement on one listing never pass the count together. The
instant-acceptance decision (the flag, the meeting place) is made before the
lock; the availability flag is squared inside it. `availableNow` stays a switch on a
static wall — the finished-campaign check that frees it is unchanged — and on a
loop it is derived: `listings.setListingAvailability(id, false)` (what
`confirm-slot` and `approve` call) writes it only when the screen is full
today, so one confirmed slot of six never reads "occupied".

### Instant booking (Lot D, Q6/Q105)

`placeOrder` asks three things of the listing before the row is written: the
publisher opted the spot in (`Listing.instantBooking`), ops still have the
`instant-booking` flag on for that publisher, and the publisher's record
still yields a meeting place (`meetingPointFor`, the accept screen's own
fallback). When all three hold the order is born `PENDING_PRINT` with
`publisherAcceptedAt = autoAcceptedAt = now`, `publisherTimerExpiry` null and
`meetingPlace` set, and the same fan-out `publisherAcceptOrder` sends goes
out — the advertiser's "Order accepted", ops' "Order ready for print" — plus
"Booking accepted for you" to the publisher, who did not tap. Any of the
three failing means the order simply waits for the publisher as before: a
quiet fallback, never a refused booking. Who installs is still asked
(`choose-fulfilment`; `installBy` null falls to ADX).

### The publisher's side of a booking (G6, Q110)

`/api/v1/publishers/me/bookings` — `publisherBookingRouter`, mounted by
bootstrap **ahead of** `publisherRouter` the way the publisher's invoices
are. Lives here because `publishers` cannot import `orders` (`users` reaches
`publishers`; this module reaches `users`). `authenticate` +
`requireRole(PUBLISHER, AGENT_PUBLISHER)` at the router; whose booking it is
is the service's question on every call — the listing's publisher, or an
AGENT_PUBLISHER under a **live grant** on that publisher (PROFILE or
LISTINGS; attribution alone is 403). An unknown order is 404; a booking
with no publisher on file 403.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/:orderId/report.pdf` | The booking report: the spot, the campaign (name and reference), the flight, the booking's own steps and the milestone plan's rows with their times, the proof photos as embedded thumbnails (the agent's PICKUP / CONDITION / INSTALLATION photos, the self-install photos, the milestones' `photo` evidence — at most 12, JPEG/PNG read through `uploads.openStoredFile` for a `/files/:id`, off the local disk for `/uploads/`, fetched for a public URL; one that cannot be read is a caption, never a refused report), the earnings line (gross, ADX commission, tax withheld, net, cleared/held) and the ledger status (`NOT_POSTED / PARTLY_POSTED / POSTED` over the spot's accruals; accrual `NOT_ACCRUED / ACCRUING / ACCRUED`). Rendered with pdfkit (`publisher-report/booking-report.pdf.ts`), stored PRIVATE as `BOOKING_REPORT` **owned by the publisher** (the id rides back in `X-ADX-File-Id`; a store failure is logged and the PDF still served), streamed `inline`. Audited `BOOKING_REPORT_GENERATED` on the `Order` with `via: OWNER \| GRANT`, the grant id and the net. |
| GET | `/:orderId/insights` | `{ scans, estimatedReach, interactions }` scoped to the spot — `scans` the sum over the spot's tracking codes, `estimatedReach` publisher-stated daily footfall × days run × faces (null with no footfall), `interactions` every `TrackingEvent` on those codes that is not the scan itself (CLICK, VIEW, CTA_CLICK, FORM_SUBMIT, REDEMPTION). **403 `FEATURE_OFF`** unless `isFeatureEnabled('publisher-spot-insights', publisherId)` — the flag is evaluated for the publisher, never the caller, so an agent sees what the publisher would. |

The read is `publisher-report/prisma-booking-report.repository.ts`: the
order with the listing and its publisher, the agent's name, the campaign
spot with its campaign, codes and accruals, the photos, the milestones with
their evidence, the verification and the check-in — read-only across the
narrow slices of `listings`, `campaigns`, `order-milestones` and `earnings`
it joins, the arrangement `publishers/book` and `admin-overview` make.

## Owned Prisma entities

`Order`, `OrderAgentAssignment`, `CheckIn`, `SiteVerification`, `OrderPhoto`.

## Public exports (`index.ts`)

G11-1: `openOrderExposureFor(scope)` — for `fraud`'s linked-accounts rail:
the non-terminal orders (anything but COMPLETED / CANCELLED) on one party,
counted and valued (`Order.budget` summed, as money, "0.00" when none
carries one) in one aggregate. `scope` is `{ publisherId }` (through the
listings), `{ advertiserUserId }` (`Order.advertiserId` is a User id) or
`{ agentId }` (the jobs the profile holds).

- `orderRouter`.
- `findPublisherTimerExpired`, `shortId` — used by `jobs/publisher-timer`.
- `findOpenOrdersForListings`, `cancelOrder`, `releaseAgentOffers` — used by
  `suspension` for Lot A's STOP_OPEN_WORK.
- `findOpenOrdersForAdvertiserUser`, `countPendingAgentOffers` — used by
  `account-lifecycle` for Lot A's closure review (Q21): the same two questions
  from the demand and the agent side, read rather than acted on.
  `Order.advertiserId` is a **User** id, which is why the first is named for
  one.
- `registerPrintJobPort`, `resetPrintJobPort`, types `PrintJobPort`,
  `PickupPoint`, `OrderPrintJob` — Lot B (B4b), E9 adds `pickupsFor(orderIds)`
  for the paged reads: the port `print-partners`
  fills. `getOrderSummary` is what that module reads.
- `registerCreativeGatePort`, `resetCreativeGatePort`, types
  `CreativeGatePort`, `CreativeGateVerdict` — Lot D (Q120): the port
  `campaigns` fills with `creativeGateForOrder`, because `campaigns` raises
  orders and the import cannot run the other way.

### The print job (Lot B, B4b)

`orders` never imports `print-partners`; that module reads orders to gate a
job on the order's status, so the two things an order needs from the job come
through the **`PrintJobPort`** (`print-job.port.ts`, filled by bootstrap from
`print-partners.registerPrintPartnersModule`):

- `markPrintReady` stamps the partner's address (`pickup`) into the PICKUP
  code's metadata beside `purpose`, and `GET /:id/pickup-code` prints it —
  from the stamp, or from the job as it stands today — so the agent's
  collect-prints step knows where to go. `GET /:id` carries `printJob`
  (`{ id, status, quotedCost, actualCost, requestedAt, readyAt, collectedAt, pickup }`,
  null when no partner is printing the order).
- `POST /:id/collect-prints` and the publisher's `self-install/collect-prints`
  tell the port the material has left the shop; the job goes COLLECTED.

Unregistered, the port answers "no job" and records nothing, and a port that
throws never fails the agent's step or the print-ready — logged, and the order
moves. The job's own routes (`/orders/:id/print-job*`) are `print-partners`'
and are mounted at `/orders` after this router, like the milestones.

## Dependencies

- `listings` — read a listing when placing; flip `availableNow` as a campaign
  starts and ends.
- `agents` — `requireAgentProfile`, `getAgentWithUser`, `findAssignableAgent`.
- `agreements` — `recordAcceptance` for the agent's JOB_TERMS on accept (Lot D).
- `notifications` — every state change notifies someone.
- `users` — `listAdminUserIds` for platform alerts.
- G6 (Q110), the publisher's booking report: `access-grants` (`liveGrantFor`),
  `feature-flags` (`isFeatureEnabled`), `uploads` (`storeGeneratedFile`,
  `openStoredFile`, `fileIdFromUrl`).

Orders writes to no other module's tables; each of the above is a narrow export.

## Invariants

- **A suspended agent is not offered work, not even their own publisher's.**
  The priority-1 shortcut — the agent who onboarded the publisher — is taken
  only when `agents.agentAcceptsWork` says yes; otherwise the order falls
  through to the ordinary sweep, which skips them too. `releaseAgentOffers`
  hands back every offer a suspended agent has not answered, through the same
  reject-and-re-offer a decline takes, so the history reads true and no order
  is left sitting on somebody who cannot act on it.

- **Sentinel errors.** Services throw bare `Error('WRONG_STATUS')` and the like;
  `orders.errors.ts` is the single place they become status codes. Keep services
  free of HTTP concerns.
- **Placement frees a stale listing.** An occupied listing whose previous
  campaign has already ended is freed and allowed through — nothing else resets
  `availableNow`, so otherwise a finished campaign would block the slot forever.
- **The listing is marked occupied at `SLOT_CONFIRMED`**, not at completion, so
  a second order cannot be placed against the same slot. `approveOrder`
  re-asserts it because the self-install path never passes through that step.
- **Three strikes escalates.** After three agent rejections the order sets
  `agentEscalated` and admins are alerted instead of the assigner cycling
  forever. An admin assignment clears the flag.
- **Agent priority**: the agent who onboarded the publisher first, then any
  active agent-publisher who has not already rejected this order.
- **Slot counters are capped at 3**, then `COUNTER_LIMIT_REACHED`. Countering
  clears `slotTime` without changing status — the order returns to "awaiting a
  proposal".
- **Idempotent installation steps.** Re-collecting prints when already
  `IN_PROGRESS` is a no-op, not an error, because the agent app retries on a
  flaky connection. Condition and installation photos are still stored after the
  order has moved on, so evidence can be corrected without reopening it.
- **The completion OTP is stored in plaintext too** (`completionOtpPlain`)
  alongside its bcrypt hash so support can read it back; both are cleared on
  successful verification. TTL 10 minutes.
- **The fulfilment fork is the publisher's answer, not the listing's.**
  `POST /:id/choose-fulfilment` writes `Order.installBy` and `markPrintReady`
  reads it. It used to read `Listing.agentCanInstall`, which defaults to `true`
  and which nothing ever wrote — so the condition was constant and `SELF_INSTALL`
  was unreachable. `installBy` null falls to ADX, matching what every order did
  under the old boolean.
- **The choice locks when the prints do.** Re-answering while `PENDING_PRINT` is
  fine, and answering the same way twice is a no-op; once `printReadyAt` is set
  the fork has been taken and `FULFILMENT_LOCKED` says so rather than quietly
  stranding whoever was already acting on the first answer.
- **Self-install has no OTP** — it goes straight to `PENDING_APPROVAL` for an
  admin to review.
- **Notifications are fire-and-forget** (`.catch(() => {})`). A notification
  failure must never fail the state transition that triggered it.
- **Check-in records distance, it does not enforce it.** The QR token must match
  the listing's, but a bad GPS fix never blocks a check-in; a listing with no
  coordinates yields distance 0.
- `POST /:id/checkin` returns terse validation messages with **no** `details`
  payload, unlike every other route here. `POST /:id/update-location` answers
  `{ success: true }` with **no** `data` key. Both inherited. G12-B:
  `updateAgentLocation(orderId, coords)` is exported for `order-milestones`,
  whose `POST /agent/milestones/:id/update-location` lands a milestone
  visit's ping on its order's columns — the same store `GET /:id/agent-location`
  reads. The ownership check stays with the caller — and Lot H (the G12
  verifier's gap) gave the route its own: `POST /:id/update-location` goes
  through `agentUpdateLocation(orderId, agentProfileId, coords)`, which
  refuses **403** for anyone but the order's assigned agent (404 for no such
  order), the rule the milestone route applies. One summary read per ping.
- `GET /my` runs one of three different queries by role, checked in the order
  advertiser → publisher → agent, so a user holding several sees the first
  match.

## Tests

```bash
npx vitest run src/modules/orders
```

## Suggested ownership

Its own team. This is the core domain; the subfeature split exists so several
people can work in it without colliding.

## The installation commission (Lot B, Q102 — package B3b)

- **The quote is on the offer.** `autoAssignAgent` and `adminAssignAgent` resolve
  `payouts.installationFeeFor(order, tier)` at the candidate's tier when the offer
  is made and copy it onto `OrderAgentAssignment.quotedFee`, so a rate change or
  a mode switch after the agent accepted cannot re-price the job. A figure that
  cannot be priced is null and the offer still goes out.
- **Ops may type the per-order figure.** `POST /:id/print-ready { agentFee? }`
  and `POST /:id/assign-agent { agentId, agentFee? }` take a decimal string and
  write `Order.agentFeeAmount`; the resolver reads it only while the platform is
  on `PER_ORDER`, and falls back to the flat rate when it is blank. Both writes
  are audited by hand (`ORDER_PRINT_READY`, `ORDER_AGENT_ASSIGNED`) with the
  figure in the diff.
- **Sign-off records it.** `approveOrder` records `INSTALLATION` for
  `order.agentId` — the accepted assignment's `quotedFee`, or the resolver when
  the offer carried none — through `recordIncentiveOnce`, so a re-approved order
  is not paid twice. PENDING_VERIFICATION; finance releases it. The agent is
  told "Commission recorded — ADX finance releases it". An order with no agent
  (self-install) records nothing. A failure to record never fails the approval:
  the order is already COMPLETED, so it is logged for ops to record by hand
  through `POST /finance/incentives`. The response carries
  `incentive: { id, amount } | null` and the write is audited `ORDER_APPROVED`.
- **The agent reads it.** `GET /my` rows and `GET /:id` carry `quotedFee` — the
  accepted assignment's, as a decimal string, null until one is accepted.

## E7-2: the reads the desks and the phones lacked

- `GET /orders` (ADMIN) takes `?from&to` — orders whose slot falls in the
  window or whose `startDate..endDate` flight overlaps it, either bound alone
  open-ended — and `?advertiserId=` (the advertiser account, reached through
  the campaign spot the order was raised from), beside the facets it had.
- `GET /orders/my` rows carry `printJob: { pickup: { name, address } } | null`
  through the `PrintJobPort` `GET /orders/:id` already reads — the agent's
  offer sheet draws the pickup row. E9: **one** `pickupsFor(orderIds)` port
  call for the whole page (E7-2 made one `printJobFor` per row); an empty
  page asks nothing; a port that cannot answer leaves every row `null`.
- `GET /orders/:id` carries `autoAcceptedAt` (Lot D's instant-booking stamp)
  on the row — the detail is the whole row, pinned by a test.

## Offers, counted, and accepted in the zone

`GET /orders/agents/:agentId/offers` (ADMIN) folds every `OrderAgentAssignment`
the agent has had — accepted, waiting, declined by coded reason, left to expire —
for the console's agent page: the count behind DR 07's "frequent rejections
lower your offer priority". And DR 07's "Auto-accept in my zone" is real:
`autoAssignAgent` accepts the offer for an agent whose switch is on when the
spot is in their city and home zone (`inZone`, a plain word match), through the
same rows an answered offer leaves.

## Ops moves (Lot D, Q51/Q90)

Four ADMIN routes, each with a **mandatory reason** that goes on the audit
row, each calling the ordinary service so the order moves exactly as it would
have had the party tapped — the same status, stamps and notifications.

| Route | Gate | Calls |
| --- | --- | --- |
| `POST /:id/reassign-agent { agentId, reason }` | `PENDING_AGENT`, `AGENT_REJECTED`, `SLOT_PROPOSED`, `SLOT_CONFIRMED`, `IN_PROGRESS` — any state before the proof | `reassignAgent`: the current assignment → `REASSIGNED` (not a refusal: no strike, no priority hit), a fresh 25-minute offer to the new agent, the order back to `PENDING_AGENT` with the slot cleared, both agents told. `ORDER_AGENT_REASSIGNED`. |
| `POST /:id/ops/accept-publisher { reason, consentNote }` | `PENDING_PUBLISHER` and `publisherTimerExpiry` passed (409 `OPS_WINDOW_OPEN` before) | `publisherAcceptOrder` as the listing's publisher; the consent note rides on the audit row |
| `POST /:id/ops/confirm-slot { reason }` | `SLOT_PROPOSED`, a slot proposed, and 24 h unanswered (`SLOT_ANSWER_WINDOW_HOURS`) | `publisherConfirmSlot` as the publisher |
| `POST /:id/ops/collect-prints { reason }` | an agent on the order and a `CheckIn` row for it (409 `OPS_NO_CHECKIN` without) | `agentCollectPrints` as that agent; a no-op once `IN_PROGRESS` |

The three overrides share one audit action, `ORDER_OPS_OVERRIDE`, with
`metadata.step` naming which — so the trail for an order lists every time ADX
acted for somebody. **There is deliberately no ops path for check-in, the
photographs or the OTP**: those are the proof a person was at the site, and
ADX cannot give it for them.

`POST /:id/cancel` now **requires** a reason and writes `cancelledAt`,
`cancelledByUserId` and `cancellationReason` on their own columns (Q51) —
`notes` is the advertiser's brief and is no longer overwritten. `cancelOrder`
called from `suspension` leaves `cancelledByUserId` null: the platform did it.
`ORDER_CANCELLED` and `ORDER_CAMPAIGN_ENDED` are audited by hand beside the
three that already were. `agentOfferHistory` counts `reassigned` separately
and leaves those rows out of the priority window.
