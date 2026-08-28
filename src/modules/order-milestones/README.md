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

`/orders/:orderId/milestones` is mounted **after** the order router, so requests
pass through that router's `authenticate` layer first and are authenticated
twice. That is existing behaviour and the route inventory pins it.

## Owned Prisma entities

`OrderMilestoneTemplate`, `MilestonePlan`, `MilestonePlanItem`,
`OrderMilestone`, `OrderMilestoneEvidence`.

## Dependencies

- `orders` — `getOrderSummary`, for the finalised-order guards.
- `agents` — `requireAgentProfile`, `agentExists`.
- `listings` — `getListingById`, to resolve a plan.
- `app-config` — `getCategoryPlanId`, the per-category default plan.

## Invariants

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
    never submittable, and never counted as missing.
- Requirements are loose JSON: rows that no longer parse are **dropped**, not
  thrown on, so an unreadable requirement cannot make an existing milestone
  impossible to complete.
- `?isActive=` filters only on the exact strings `'true'`/`'false'`; anything
  else means no filter.

## autoAssignMilestones has no callers

`order/order-milestones.service.ts` exports `autoAssignMilestones`, which
materialises an order's milestones from the listing's plan or its category
default. Nothing calls it today — it is wired for a future automatic dispatch
step. It is deliberately silent about every miss (no plan, no listing, inactive
plan, milestones already present), so it can never block an order progressing.

## Tests

```bash
npx vitest run src/modules/order-milestones
```

## Suggested ownership

Shares an owner with `orders`, or its own if the checklist system grows.
