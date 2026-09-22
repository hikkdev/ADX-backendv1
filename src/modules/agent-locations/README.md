# agent-locations

LT-1 (live agent tracking, 22 Sep 2026 — OPEN-TASKS §0 item 5, "after this
we can go for agents tracking"): where every working agent is, and the ops
live map that watches it.

```
agent-locations/
  agent-locations.rules.ts        the arithmetic — haversine, thinning, state, alerts, ETA (pure)
  agent-locations.store.ts        the live fix per agent in Redis (`agentloc:last:<id>`, a day's TTL) + the index
  agent-locations.repository.ts   the trails (Postgres) and the narrow reads a trip needs (destination, slot, agent)
  agent-locations.service.ts      the ping, the live list, the trail, the order timeline, the sweep
  agent-locations.stream.ts       the live map's SSE (`shared/http/sse`), single-use stream token like the live chat's
```

## What the agent app sends

`POST /agent-locations/me` `{ latitude, longitude, accuracy?, speed?,
heading?, at?, context?: { kind: ORDER | MILESTONE | FIELD_VISIT, id } }` —
every `tracking.pingMovingSec` (45 s) on the move, every `pingStillSec`
(300 s) standing still, **while the app is in the foreground and the agent
is active** (`tracking.mode` WHILE_USING; BACKGROUND is a switch for the
day a foreground-service module is added to the build — the app declares
no such module today). The app reads the intervals once a session from
`GET /agent-locations/me/settings`, which also carries the consent line the
agent agreement should say (`TRACKING_CONSENT_LINE`). The answer names the
next interval, the state, and the trip — with its ETA and whether the
geofence was reached.

## What one ping does

1. **The live record** (Redis): position, speed, heading, the trip, when
   the position last moved more than 50 m (`movingAt`), and the trip's
   first fix (`tripStart`, for the off-route corridor). No history.
2. **The trail** (Postgres, `AgentTrail` + `AgentLocationPoint`) when the
   ping names a trip that is the agent's and still open — an ORDER whose
   status is SLOT_PROPOSED / SLOT_CONFIRMED / IN_PROGRESS / PENDING_OTP, a
   MILESTONE DISPATCHED / IN_PROGRESS, a FIELD_VISIT SCHEDULED /
   IN_PROGRESS. Opened on the first ping (destination and label read off
   the row: an order's print partner until the handover scan, then its
   site; a milestone's site; a visit's business), the fix kept only when
   it is 25 m or 60 s from the last one kept (`worthKeeping`), the arrival
   stamped the first time a fix lands within `tracking.geofenceRadiusM`
   (150 m) of the destination — per leg, since the destination moves at
   the handover. A closed context is ignored: the ping is recorded with no
   trip, and the trail is left to the sweep (`endTrip` closes it when a
   module wants to).
3. **The order's own position** (`Order.agentLatitude/Longitude`, the
   parties' tracking screens) through the `OrderPositionPort` orders fills
   at bootstrap — this module sits above `orders`.

## What the desk reads

- `GET /agent-locations/live?city=&side=&state=&q=` — every ACTIVE agent
  (with or without a fix), each with `state` (`OFFLINE` — no fix for
  `offlineAfterMin`; `AVAILABLE` — fresh fix, no trip; `TRAVELLING`;
  `STILL`; `ON_SITE` — arrived), the fix and its age, the trip with its
  ETA, and `alerts`: `IDLE` (not moved for `idleAlertMin` on a trip),
  `LATE` (`lateGraceMin` past the slot, not arrived), `OFF_ROUTE` (more
  than `offRouteKm` off the straight line trip-start → destination),
  `OFFLINE` (on a trip, no fix). Alerts first, then by state.
- `POST /agent-locations/stream-token` then `GET /agent-locations/stream?t=`
  — a `snapshot` event every 5 s while the fingerprint (states, fix times,
  arrivals, alerts) changed; a comment otherwise. A bearer works too.
- `GET /agent-locations/agents/:agentId/trail` — the current trip's trail
  (else the newest open one) with up to 2,000 points: the polyline behind
  the marker.
- `GET /agent-locations/orders/:orderId/timeline` — the two legs of an
  install folded from the print job (ready, handover), the trail (started,
  arrived) and the installation milestone: print ready → en route to the
  partner → pickup scan → en route to the site → arrived → installed; the
  order's trails with points; the agent's live row.

The parties' `GET /orders/:id/agent-location` gained `eta` (minutes and
metres, straight line at a city drive) when `tracking.partiesSeeEta`.

## Settings, feature, job

Platform settings `tracking` (`Settings › Live tracking` on the console):
`pingMovingSec`, `pingStillSec`, `mode`, `retentionDays` (30), `geofenceRadiusM`
(150), `idleAlertMin` (15), `lateGraceMin` (15), `offRouteKm` (2),
`offlineAfterMin` (10), `partiesSeeEta` (true). Feature `ops.live-map` — off,
the ping and the desk's routes answer FEATURE_DISABLED. Job
`agent-trail-retention` (hourly tick, once a day) deletes points and trails
older than `retentionDays`; the live record expires by itself.

## Where it shows

Console: Ops › Live map (`/live-map`, the stream with a 30 s poll while it
is down), Settings › Live tracking (`/settings/tracking`), the Journey card
on an order's detail (`GET .../orders/:id/timeline`, behind `FeatureGate`).
Agent app: `features/home/live-tracking.ts` — the ping loop on the home,
foreground only, cadence read once from `/me/settings`; the consent line
under Account. User app: the ETA line on Track installation. The two agent
engagement placeholder drafts carry a "Location sharing" clause with the
same wording (`agreements.service.ts`), for the lawyer's text to keep.

## Dependencies

`agents` (the profile behind the ping), `app-config` (the settings),
`feature-flags`, `shared/*`. Nothing imports this module but bootstrap and
the retention job — it sits on top of `orders`, `visits` and
`order-milestones`, which is why the order position goes through a port and
the destinations are read narrowly here.
