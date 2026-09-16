# order-milestones

The per-order fulfilment checklist an agent works through on site, and the
templates and plans it is built from.

```
order-milestones/
  templates/  OrderMilestoneTemplate — a reusable step with requirements
  plans/      MilestonePlan — an ordered set of templates
  order/      OrderMilestone — the steps attached to one order
  agent/      the agent-facing execution flow
  order-milestones.evidence.ts  pure requirement-vs-evidence matching
```

## NOT the agent milestone board

`agents` also has "milestones": `AgentMilestone` and `MilestoneTemplate`, which
are gamification — targets, rewards, tiers. This module owns
`OrderMilestoneTemplate`, `MilestonePlan`, `MilestonePlanItem`,
`OrderMilestone` and `OrderMilestoneEvidence`. Different tables, different
routes, different owner. They share only the word.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| POST/GET/GET/PATCH | `/api/v1/milestone-templates[/:id]` | ADMIN writes, any read |
| POST/GET/GET/PATCH/PUT | `/api/v1/milestone-plans[/:id][/items]` | ADMIN writes, any read |
| GET/POST/PATCH/DELETE | `/api/v1/orders/:orderId/milestones[/:milestoneId]` | ADMIN |
| GET/GET/POST/POST | `/api/v1/agent/milestones[/:milestoneId][/start|/complete]` | AGENT_PUBLISHER \| AGENT_ADVERTISER |
| POST | `/api/v1/agent/milestones/:milestoneId/update-location` | AGENT_PUBLISHER \| AGENT_ADVERTISER, the milestone's assigned agent only (404 / 403) — G12-B: the order lane's position ping (`{ latitude, longitude }`, numbers; 400 `latitude and longitude required` with no details, as `POST /orders/:id/update-location`), answering `{ success: true }` with no `data` key. A milestone has no location column and is a step on one order, so the ping is written onto that order's `agentLatitude` / `agentLongitude` / `agentLocationUpdatedAt` through `orders.updateAgentLocation` — the store the publisher's `GET /orders/:id/agent-location` reads. A ping, not a state change: a frozen order is not refused |

`/orders/:orderId/milestones` is mounted **after** the order router, so requests
pass through that router's `authenticate` layer first and are authenticated
twice. That is existing behaviour and the route inventory pins it.

## Owned Prisma entities

`OrderMilestoneTemplate`, `MilestonePlan`, `MilestonePlanItem`,
`OrderMilestone`, `OrderMilestoneEvidence`.

## Dependencies

- `orders` — `getOrderSummary`, for the finalised-order guards; G12-B:
  `updateAgentLocation`, the position ping written onto the milestone's order.
- `agents` — `requireAgentProfile`, `agentExists`.
- `listings` — `getListingById`, to resolve a plan.
- `app-config` — `getCategoryPlanId`, the per-category default plan.

`releaseAgentMilestones(agentId, reason)` leaves the module for `suspension`'s
STOP_OPEN_WORK; `countDispatchedMilestones(agentId)` is the same set counted,
for `account-lifecycle`'s closure review (Lot A, Q21). Reported, never a
blocker: the closure releases them a step later.

## Invariants

- **Assigning is dispatching, so a suspended agent is refused.** Naming an
  agent on a PENDING milestone dispatches it, and Lot A's BLOCK_NEW refuses
  that with 409 `AGENT_SUSPENDED` before anything is written. Skipping is not a
  dispatch and is not checked. `releaseAgentMilestones` is the reverse:
  STOP_OPEN_WORK sends everything DISPATCHED to that agent back to PENDING and
  unassigned, through the same `reject` the expiry sweep uses, and tells the
  admins.
- **Finalised orders freeze their milestones.** `COMPLETED` and `CANCELLED`
  reject adds, edits and agent work. Removal additionally rejects
  `VERIFICATION` — an order under verification still accepts edits, just not
  removals. That asymmetry is inherited.
- Only **active** templates can be added to an order or a plan.
- `replacePlanItems` validates everything — duplicate `order` values, unknown
  templates, inactive templates — **before** writing, then deletes and recreates
  in one transaction, so a plan is never left half-rebuilt.
- Adding a milestone without an explicit `order` appends to the end.
- Assigning an agent to a `PENDING` milestone auto-dispatches it in the same
  write. Setting `SKIPPED` takes priority and drops `assignedAgentId`, so
  skipping never also assigns.
- Only `PENDING` or `DISPATCHED` milestones can be removed, enforced with a
  **conditional delete** rather than check-then-delete, because the status can
  change in between.
- `startMilestone` is idempotent — the agent app retries it, so a second start
  returns current state rather than erroring.
- Completion flips the status **conditionally** inside a transaction; a
  concurrent second completion gets **409**, not a duplicate evidence set.
- Evidence rules (`order-milestones.evidence.ts`, pure and testable):
  - unknown `kind` values are rejected;
  - entries dedupe by `(kind, label)`, last one wins;
  - `photo` and `checklist_item` must match the requirement's **label**;
  - a `checklist_item` value must normalise (trim + lowercase) to `'true'`;
  - `contact_details_visible` is informational — requestable by a template but
    never submittable, and never counted as missing;
  - a `photo` or `checklist_item` marked `optional: true` is never counted as
    missing either, and is skipped whole rather than checked-then-forgiven, so
    an optional checklist item answered "no" is recorded as that answer instead
    of failing the visit. The flag is absent on every requirement written before
    it existed, which reads as mandatory. The agent app's Mandatory/Optional
    marker on each guided proof is this flag and nothing else.
- Requirements are loose JSON: rows that no longer parse are **dropped**, not
  thrown on, so an unreadable requirement cannot make an existing milestone
  impossible to complete.
- `?isActive=` filters only on the exact strings `'true'`/`'false'`; anything
  else means no filter.

## Where a plan is issued

`order/order-milestones.service.ts` exports `autoAssignMilestones`, which
materialises an order's milestones from the listing's plan or its category
default. It is called from `getAgentMilestones` — reading the agent's work queue
issues the plans that agent's live jobs are still owed. Nothing called it at
all until then, which is why this lane was built, routed and empty: an agent saw
no milestones unless ops hand-created and dispatched each one.

Lazily, and from this module, because the dependency runs one way. This module
reads `orders` (`getOrderSummary`, `getAgentOrderIdsAwaitingWork`); `orders`
must never read this one, so issuing from the agent's accept would close a cycle
that `npm run arch` rejects. The first queue read is in any case the first
moment the plan is needed.

Only for orders in `SLOT_PROPOSED`, `SLOT_CONFIRMED` or `IN_PROGRESS` — an agent
holds the job and the site work is still ahead. Milestones are created
`DISPATCHED` and assigned to `order.agentId`; issued before an agent exists they
would be dispatched to nobody, and the already-present guard would then stop the
real agent ever getting them.

It stays deliberately silent about every miss (no plan, no listing, inactive
plan, milestones already present), so it can never block an order progressing,
and the caller logs and swallows anything it throws.

## Visit offers (A12)

DR 01 draws the advertiser-side lane as three sheets (3424:26829, 3458:28301,
3424:26873): a dispatched visit arrives as an OFFER that "Expires in 25
Minutes", is accepted or rejected with the same five coded reasons the order
lane uses, and — once accepted — the agent picks one of the derived
"Available slots". On `OrderMilestone` that is `offeredAt` / `offerExpiresAt`,
`acceptedAt`, `rejectionReason`, `scheduledStart` / `scheduledEnd`.

- Ops assigning an agent to a PENDING milestone (`PATCH /orders/:id/milestones/:mid`)
  dispatches it as an offer with the window stamped. Milestones issued to the
  order's own agent (`autoAssignMilestones`) are accepted on creation — they
  already hold the job.
- `POST /agent/milestones/:id/accept` — inside the window only; `OFFER_EXPIRED`
  after it. `POST /:id/reject` — `{ reason, note? }`, OTHER needs the note; the
  milestone returns to PENDING with the reason kept, unassigned, and admins are
  told. `GET /:id/slot-candidates` — the orders module's derived bands inside
  the order's dates, minus starts other milestones on the order already hold.
  `POST /:id/schedule` — `{ start }` from those candidates; sets the slot and
  the due date. `start` refuses an unaccepted offer.
- `jobs/agent-timer` sweeps offers whose window closed in the last tick:
  rejected as `EXPIRED`, unassigned, admins told — the clock on the sheet is
  the clock ADX keeps.

## Tests

```bash
npx vitest run src/modules/order-milestones
```

`__tests__/order-milestones.evidence.test.ts` covers the matching rules on their
own — no database, because `checkEvidence` is pure.

## Suggested ownership

Shares an owner with `orders`, or its own if the checklist system grows.

## The re-install (Lot D, Q54/Q92)

`raiseReinstallMilestone({ orderId, disputeId, agentId? })` — exported for
`disputes` — puts an INSTALLATION milestone on the order a dispute names:
built from the first active INSTALLATION template (409 when there is none),
appended after the order's other steps, stamped `reinstallOfDisputeId`, and
DISPATCHED as an offer with the 25-minute window to the agent who did the
work (the order's `agentId`) unless ops name another; a suspended agent is
refused (BLOCK_NEW). An order that never had an agent gets a PENDING,
unassigned visit and the admins are told. The order's own status is not
touched.

**The finalised-order freeze is relaxed for exactly these rows** (`isFrozen`):
a milestone whose `reinstallOfDisputeId` is set may be edited, removed,
accepted, started and completed on a COMPLETED or CANCELLED order — that is
what it is for. Every other milestone freezes as before.

`findMilestoneStatuses(ids)` is the narrow read `disputes` uses to say
"re-install pending" until the visit is COMPLETED or SKIPPED.
