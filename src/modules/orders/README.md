# orders

The campaign booking lifecycle: placement, publisher acceptance, agent
assignment, slot negotiation, installation, completion OTP, admin approval.

The largest module in the codebase and the one with real state-machine rules.

```
orders/
  placement/     placing an order against a listing
  assignment/    choosing an agent; escalation after three rejections
  scheduling/    publisher accept/reject and slot negotiation
  fulfilment/    installation — agent-led, and publisher self-install
  verification/  completion OTP, admin approval, cancellation
  tracking/      site check-in and live agent location
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
                        agentCanInstall = false ───────┘        │                     │
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

29 routes under `/api/v1/orders`, all `authenticate`d. `/my` is registered
**ahead of** `/:id` or it would be read as an order id.

Role split: `ADVERTISER` places; `PUBLISHER` accepts, negotiates slots and
self-installs; `AGENT_PUBLISHER` accepts assignments, installs and verifies;
`ADMIN` marks prints ready, assigns, approves, cancels and ends campaigns.

`/api/v1/orders/:orderId/milestones` is **not** here — it belongs to
`order-milestones` and is mounted separately, after this router.

## Owned Prisma entities

`Order`, `OrderAgentAssignment`, `CheckIn`, `SiteVerification`.

## Public exports (`index.ts`)

- `orderRouter`.
- `findPublisherTimerExpired`, `shortId` — used by `jobs/publisher-timer`.

## Dependencies

- `listings` — read a listing when placing; flip `availableNow` as a campaign
  starts and ends.
- `agents` — `requireAgentProfile`, `getAgentWithUser`, `findAssignableAgent`.
- `notifications` — every state change notifies someone.
- `users` — `listAdminUserIds` for platform alerts.

Orders writes to no other module's tables; each of the above is a narrow export.

## Invariants

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
- **Self-install has no OTP** — it goes straight to `PENDING_APPROVAL` for an
  admin to review.
- **Notifications are fire-and-forget** (`.catch(() => {})`). A notification
  failure must never fail the state transition that triggered it.
- **Check-in records distance, it does not enforce it.** The QR token must match
  the listing's, but a bad GPS fix never blocks a check-in; a listing with no
  coordinates yields distance 0.
- `POST /:id/checkin` returns terse validation messages with **no** `details`
  payload, unlike every other route here. `POST /:id/update-location` answers
  `{ success: true }` with **no** `data` key. Both inherited.
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
