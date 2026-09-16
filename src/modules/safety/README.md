# safety

DR 07 wave 4 (11 September 2026). The one place in DR 07 where a screen does something
irreversible: an agent reporting that a site is unsafe.

## What it owns

`SafetyAlert`, `SafetyAlertKind` (`UNSAFE_SITE`, `HARASSMENT`, `ACCIDENT`,
`LOCATION_SHARE`, `OTHER`), `SafetyAlertStatus` (`OPEN`, `ACKNOWLEDGED`, `CLOSED`), and the
`SFT-` series on the identifiers counter.

## Routes

```
POST   /safety/alerts          raise one (any signed-in person)
GET    /safety/alerts/mine     what I reported
GET    /safety/alerts          ADMIN — the queue, open first, oldest first
PATCH  /safety/alerts/:id      ADMIN — acknowledge, note, close; T-B: answers the queue's row (`raisedBy`, `order`)
```

## Invariants

- **A blocking report blocks the job.** DR 07's own words are that reporting an unsafe site
  *blocks the job and alerts ops*, so it does both: `UNSAFE_SITE`, `HARASSMENT` and
  `ACCIDENT` take the agent off the order and put it back to `PENDING_AGENT` with
  `agentEscalated`, which is a state the dispatcher already works. Not cancelled — the
  advertiser's order is still owed. `LOCATION_SHARE` blocks nothing: the agent is asking to
  be watched, not to be pulled off.
- **The job leaves the agent's hands before anybody is told**, so an ops notification never
  points at a job the agent is still holding.
- **Every admin is notified, and the raiser hears back** when ops acknowledge or close it.
- Raising and every ops action are logged (`SAFETY_ALERT_RAISED`, `SAFETY_ALERT_UPDATED`).
- The emergency number is **not** in the app: it comes from the `CONTACT_INFO` legal
  document (`meta.safetyLine`), so it can change without a release.

## Dependencies

`identifiers` (the SFT- number), `notifications`, `users`. The order is read and released
through this module's own Prisma repository: `orders` exports no such write, and a safety
release is not an order-lane decision.

## Tests

`__tests__/safety.service.test.ts`.
