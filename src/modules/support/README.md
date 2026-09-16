# support

Support tickets raised by users, and the message thread on each one.

## Responsibilities

- List, read and raise a user's own tickets.
- Append replies, keeping the ticket's `updatedAt` in step.
- Open and close tickets.

## Owned routes

All mounted at `/api/v1/support`, all `authenticate`d, all scoped to the
caller. Lot I's two SSE routes are the one exception to the router-wide
layer: they run `authenticateStream` instead, which takes the bearer header
or a single-use `?t=` stream token, and they check the caller against the
ticket in the handler.

| Method | Path | Status |
| --- | --- | --- |
| GET | `/tickets/queue` | 200 — ADMIN; the list contract with the desk's facets (Lot D); E7-3: each row carries `requester: { userId, name, role, displayId }`; E10-1: `teams[]` beside the page — the distinct teams across the whole queue, not the page, sorted |
| GET | `/tickets` | 200 |
| POST | `/tickets` | **201** |
| GET | `/tickets/:ticketId` | 200 — carries `sla`, and (Lot I) `channel`, `requesterSeenAt` / `agentSeenAt`, `firstResponseAt`, `assignedAdmin { id, name }`, and each message's `kind` / attachment / `seenAt`; an owner's read drops internal notes. I4-B: `plan: { name, reason } \| null` — on a LIVE_CHAT thread, the entitlement the requester holds *now* (`liveChatEntitlement`); null on an ordinary ticket, which asks nothing |
| GET | `/tickets/:ticketId/requester` | 200 — ADMIN; E7-3: the rail — `{ user, party: { type, id, displayId, name, kycStatus } \| null, walletBalance, openOrders, openTickets, recentActivity: [{ action, at }] }`; 404 when the ticket does not exist |
| POST | `/tickets/:ticketId/reply` | **201** — `{ message, internal?, attachmentFileId? }`; `internal` is ADMIN-only; Lot I: `attachmentFileId` is a private SUPPORT_ATTACHMENT file and the message lands with `kind: ATTACHMENT`; the text may be empty when a file rides on it |
| PATCH | `/tickets/:ticketId/status` | 200 — the owner's `OPEN \| CLOSED` |
| PATCH | `/tickets/:ticketId` | 200 — ADMIN; `{ status, priority, team, assignedAdminUserId }` (Lot D) |
| POST | `/tickets/:ticketId/assign` | 200 — ADMIN; the field agent on the request |
| GET | `/live/status` | 200 — Lot I; the entitlement, whether anybody is on, the expected wait, the hours and the next opening — `nextOpening` as an instant **and** (I4-B) `nextOpeningLabel` as a person reads it in the desk's zone (`9:00 am IST on Tue 15 Sep`), both null while open. **Not** behind `requireFeature` on purpose — see Live chat |
| POST | `/live/start` | **201** (200 when it continues a chat already running) — `{ message, relatedOrderId?, attachmentFileId? }`; **403 NOT_ENTITLED** with `details: { reason, plan, upsell }`; `{ fallback: 'TICKET', nextOpening }` when the door is shut, and the SYSTEM line on the thread names the opening in the desk's zone (I4-B), never as an ISO instant |
| PUT | `/presence` | 200 — ADMIN; `{ online }`, a Redis member with a 90 s life |
| POST | `/presence/heartbeat` | 200 — ADMIN; every 30 s from an open desk |
| GET | `/presence` | 200 — ADMIN; every operator on, with their open-chat counts, lightest first |
| GET | `/live/inbox` | 200 — ADMIN; the list contract over OPEN live chats — requester, `plan: { name, reason } \| null` (I4-B: the entitlement each requester holds now, resolved for the page in one batch — `liveChatEntitlementsFor`), assignedAdmin, lastMessageAt, waitingSince, firstResponseBreached, unread |
| GET | `/live/inbox/events` | 200 — ADMIN; SSE over `support:inbox` (new chat, message, breach); bearer header **or** `?t=<stream token>`; `Last-Event-ID` or `?lastEventId=<ms>` (I4-B) |
| POST | `/live/inbox/stream-token` | **201** — ADMIN; the inbox stream's five-minute single-use token |
| GET | `/canned` | 200 — ADMIN; `?team=`, `?includeInactive=` |
| POST | `/canned` | **201** — ADMIN, audited `SUPPORT_CANNED_REPLY_CREATED` |
| PATCH | `/canned/:cannedId` | 200 — ADMIN, audited `SUPPORT_CANNED_REPLY_UPDATED` |
| DELETE | `/canned/:cannedId` | 200 — ADMIN, audited `SUPPORT_CANNED_REPLY_DELETED` |
| GET | `/tickets/:ticketId/events` | 200 — the thread as SSE; bearer header **or** `?t=<stream token>`; resumes from `Last-Event-ID` or, when the header cannot be sent, `?lastEventId=<ms>` (I4-B; the header wins when both are there); registered above the router's `authenticate` |
| POST | `/tickets/:ticketId/stream-token` | **201** — the requester's or an ADMIN's; five minutes, single use, bound to this ticket; the person's status and roles are read again when it is spent (I4-B), so a removed role or a deactivated login opens no stream |
| POST | `/tickets/:ticketId/typing` | 200 — `{ typing }`; throttled to one publish per 2 s per person, never persisted |
| POST | `/tickets/:ticketId/seen` | 200 — stamps `requesterSeenAt` or `agentSeenAt` and the messages under it |
| POST | `/tickets/:ticketId/reassign` | 200 — ADMIN; `{ adminUserId }`, audited `SUPPORT_CHAT_REASSIGNED`; **409 CONFLICT** `That ticket is not a live chat` on an ordinary ticket, the same refusal `/convert` gives (I4-B) — an ordinary thread's ops owner moves through `PATCH /tickets/:id` and never gets a "joined" line |
| POST | `/tickets/:ticketId/convert` | 200 — ADMIN; `{ to: 'TICKET' }`, audited `SUPPORT_CHAT_CONVERTED` |

## Owned Prisma entities

`SupportTicket`, `TicketMessage`, `CannedReply` (Lot I).

## Public exports (`index.ts`)

- `supportRouter`.
- `raiseAccountTicket({ userId, title, description })` — used by
  `account-lifecycle` when somebody asks for their account to be closed from
  the Privacy screen (Lot A, Q21). A thin wrapper over `createTicket` with
  category `ACCOUNT`, deliberately not a second creation path: the number, the
  admin fan-out and the thread are the ones every other ticket gets, so ops
  works one queue.
- `countOpenTicketsForUser(userId)` — the closure review's open-tickets line.
- Lot I: `sweepLiveChats(now)` — what `jobs/live-chat-sla.job.ts` runs every
  minute; `supportAttachmentViewer(viewerUserId, fileId)` — what bootstrap
  fills into `uploads.FileAccessPort.supportPartyMayView`;
  `liveChatEntitlement(userId)` — the read the console's subscriber rail and
  the apps' chat button both ask; `liveChatEntitlementsFor(userIds)` (I4-B)
  is the same answer for a page of them, one query per source.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repository only).
- `users` — `getUserDisplayName` for reply author labels, `listAdminUserIds` to tell
  the desk a ticket was raised, `findUserSummaries` for the requester rail and
  (I4-B) to read a stream grant's person again when the token is spent.
- `identifiers` — `allocateIdentifier('TICKET' | 'FEEDBACK')`.
- `notifications` — `createNotification`.
- `app-config` — `getPlatformSettings().support.sla`, the targets per priority, and (Lot I) `support.liveChat`.
- Lot I only: `publishers`, `advertisers`, `revenue`, `packages` (the
  entitlement — the per-login reads `entitledSubscriptionForPublisher`,
  `entitledPackageForAdvertiser` (Lot J2: grace-aware), and since I4-B their
  batch forms `findPublisherLabelsForUsers`, `findAdvertiserLabelsForUsers`,
  `entitledSubscriptionsForPublishers`, `entitledPackagesForAdvertisers` for
  the inbox), `uploads` (the attachment record), `feature-flags` (the kill
  switch inside the status read).

## DR 07, wave 2

- A ticket has a **kind** — `ISSUE` or `FEEDBACK` ("Suggest a feature" is a ticket
  wearing its own number and categories, not a second system) — a **displayId**
  (`TKT-1109-2601` / `FB-1109-2601`, minted through `identifiers` on create) and the
  **attachmentUrls** it was raised with (files already stored through `POST /upload`).
- **Categories are pinned** (`support.schema.ts`): issues are `APP_BUG | ORDER |
  PAYMENT | LISTING | ACCOUNT | ACCESS | OTHER`, feedback is `IDEA | PROBLEM |
  CONTENT`. Known synonyms and lower-case plurals fold in; anything else is 400.
- **ADX may read and answer any ticket.** `getVisibleTicket` admits the raiser or
  an ADMIN; an ADMIN's reply is signed `ADX Support` and the raiser is notified
  (`MESSAGE`); an ADMIN closing a ticket notifies the raiser too. Every admin is
  notified (`SYSTEM`) when a ticket is raised. Before this the console could list
  the queue and read nothing, which made the agent's Support Chat a monologue.

## Invariants

- A ticket is visible to `ticket.userId` and to ADMIN, and to nobody else.
- Reading a ticket that exists but belongs to someone else returns **404**;
  replying to one returns **403**. That asymmetry is inherited from the original
  controller and is deliberately preserved — changing it would change the API.
- A reply and the parent ticket's `updatedAt` are written in one transaction, so
  the list ordering (`updatedAt desc`) can never disagree with the thread.
- The first message of each ticket is included in list responses (`take: 1`);
  the full thread only in single-ticket responses.

## Cross-module dependency

Reply authors are labelled via `getUserDisplayName` from the `users` module's
public index, falling back to `'Agent'` when the user has neither a name nor a
mobile. Support does not query `User` itself.

## Tests

```bash
npx vitest run src/modules/support
```

## Suggested ownership

Small and self-contained; pairs naturally with `notifications`.

## The SLA (Lot D, Q53/Q91)

Two clocks on every ticket, in `support.sla.ts`:

- **Targets per priority** come from the platform settings row
  (`support.sla`), defaulting to URGENT 1h/4h, HIGH 4h/24h, NORMAL 8h/72h,
  LOW 24h/7d (first response / resolution). `slaFirstResponseDueAt` and
  `slaResolutionDueAt` are stamped at creation and recomputed on a priority
  change — **from the creation time**, never from now, so re-prioritising a
  ticket that has sat for a day does not hand it a fresh clock.
- **Priority defaults from the category** (`defaultPriorityFor`): SAFETY and
  PAYMENT → HIGH, everything else → NORMAL, feedback → LOW. Ops may set it
  explicitly on the PATCH.
- **WAITING pauses both.** `PATCH /tickets/:id { status: 'WAITING' }` stamps
  `slaPausedAt` and tells the requester; the requester's next reply (or ops
  moving the status) sets it back to OPEN, banks the wait into `slaPausedMs`
  and moves both due dates by the same amount. An ADX reply on a WAITING
  ticket does not lift the pause — it is the requester ADX is waiting on.
- **`firstRespondedAt`** is stamped by the first non-internal ADMIN reply.
- **Breach is derived on read, never stored** — `slaView(ticket, now)` →
  `{ firstResponseBreached, resolutionBreached, paused, dueIn, firstResponseDueAt, resolutionDueAt }`,
  with a running pause added to the due dates first. It rides on every read
  and every queue row as `sla`. `?breached=true` on the queue applies the
  same rule in SQL (`slaPausedAt IS NULL` and either clock past).
- **Internal notes** (`POST /reply { internal: true }`, ADMIN only) are ops
  talking to ops: never in the owner's thread or list, never a first
  response, never a notification. Audited `SUPPORT_TICKET_NOTE_ADDED`.
- **The queue** is on the list contract — `?q=&status=&sort=OLDEST|NEWEST|DUE&page=&pageSize=`
  plus `kind`, `priority`, `team`, `unassigned` (no field agent), `mine` (the
  caller as ops owner) and `breached` — with `counts` by status over the
  filter minus the status facet.
- `assignedAdminUserId` / `assignedAdminAt` / `team` are the ops owner and
  desk, distinct from `assignedAgentId`, which is the field agent a
  delegated-access grant is later bound to. The PATCH is audited
  `SUPPORT_TICKET_UPDATED` with the columns that moved. `countOpenTicketsForUser`
  counts anything not CLOSED, WAITING included.

## E7-3: who raised it

- **The queue row's `requester`** — `{ userId, name, role, displayId }`: the
  account through `users.findUserSummaries` (one query per page) and the
  party record through `RequesterPort` (`requester.port.ts`, one round trip
  per page). `role` is the console's vocabulary — the party record's type
  when the login has one (`PUBLISHER | ADVERTISER | AGENT`), else the
  account's primary role folded to it (`AGENT_*` → `AGENT`; `PARTNER`,
  `ADMIN`), null for an account with none. `name` is the party's, else the
  user's, else their mobile. A login holding more than one record is printed
  as the one its primary role names.
- **`GET /tickets/:ticketId/requester`** (ADMIN) is the rail beside the
  thread: `user` (`users.findUserSummaries` — name, contacts, roles, primary
  role; never credentials), `party` with its `kycStatus`, `walletBalance`
  (a decimal string — the settled balance of the party's wallet — or null
  without one), `openOrders` (running orders with this login on either side),
  `openTickets` (`countOpenTicketsForUser`, WAITING included) and
  `recentActivity` — the last ten `ActivityLog` rows the account wrote, as
  `{ action, at }`, read through `shared/audit.listActivity`.
- **The port.** `RequesterPort` is declared here and filled by
  `bootstrap/register-modules.ts` from `publishers`, `advertisers`, `agents`
  (the party labels), `wallets` (`findWalletFor`), `listings` and `orders`
  (the open orders — the closure review's composition). Unregistered, the
  queue and the rail still answer; the party and the numbers are null / 0.

## Live chat (Lot I, the owner's decision of 14 Sep 2026)

Live chat is **a feature for paid subscribers**. It is not a second messaging
system: a live chat is a `SupportTicket` wearing `channel: LIVE_CHAT`, with
the same number, the same thread, the same queue and the same desk. What is
different is the pace — the requester is waiting, so the chat is put on
somebody at once, it streams, and a first response that misses the target is
an alert rather than a line in a report.

### Who is entitled

`live-chat.entitlement.ts` — `liveChatEntitlement(userId)` →
`{ entitled, reason, plan, upsell }`:

| Reason | Who |
| --- | --- |
| `PUBLISHER_SUBSCRIPTION` | a publisher on an **entitled `PublisherSubscription`** — running now, or (Lot J2) ended within the publisher policy's `graceDays` — read through `revenue.entitledSubscriptionForPublisher` (that module owns the table; the commission rate keeps reading the running row) **whose tier's plan allows it** (Lot J-B1): `revenue.publisherPlansByTier()` is read once (one query, every tier) and a plan whose `entitlements.liveChat` is `false` keeps its subscribers off live chat, the way the advertiser catalogue does; the default catalogue says no on Standard and yes on Plus and Pro, and `PATCH /revenue/plans/:tier` is where that changes. On top, `support.liveChat.publisherTiers` may narrow it (empty = every tier the plan allows). The `plan` names the catalogue plan (`Plus plan`), falling back to the tier when the catalogue has no row |
| `ADVERTISER_PACKAGE` | an advertiser on an **entitled `PackageSale`** — ACTIVE now, or (Lot J2) ended within the advertiser policy's `graceDays`, read through `packages.entitledPackageForAdvertiser` — whose plan's `entitlements` JSON does not set `liveChat: false`. The catalogue editor (`PATCH /catalogue/plans/:tier`) switches it per plan, so excluding a tier is an ops edit rather than a deploy |
| `PLAN_EXCLUDED` | paying, but on a tier the settings leave out or a plan whose entitlements say no. Distinct from `NOT_SUBSCRIBED` on purpose: a screen should not ask somebody to buy what they already have |
| `NOT_SUBSCRIBED` | a publisher or advertiser record with nothing running |
| `NOT_A_SUBSCRIBER_ROLE` | an agent, a print partner, an admin, a login with no party — they keep the ticket thread |
| `FEATURE_OFF` | ops' own switch (`support.liveChat.enabled`) or the `support.live-chat` kill switch |

A login holding both records is entitled if **either** side pays: the same
person asking the same question should not be turned away because of which
screen they asked from.

**Grace (Lot J2).** A term that has ended but is still inside its
audience's `graceDays` answers as it did while running, with
`grace: { until, note }` on the entitlement — the note reads "in grace
until 21 Sept 2026" — and `planOnDesk` prints the same note beside the
plan (`plan: { name, reason, grace }`), so the operator sees a lapsed
subscriber mid-grace for what they are. The grace covers live chat and the
other copy keys; it never touches the commission rate.

**The batch read (I4-B).** `liveChatEntitlementsFor(userIds)` answers a
whole page — the desk's inbox — with one query per source (the publisher
records, the advertiser records, the running subscriptions, the active
sales and their plans) instead of four per row, and runs the same `decide`
the single read runs, so the two cannot disagree. `planOnDesk(entitlement)`
is what both the inbox row and the LIVE_CHAT ticket read print as
`plan: { name, reason } | null` — the plan the requester holds *now* and why
it counts (`PUBLISHER_SUBSCRIPTION`, `ADVERTISER_PACKAGE`) or does not
(`PLAN_EXCLUDED`); null with nothing paid, so a lapsed subscriber mid-chat
is visible to the operator as one.

### The hours and the fallback

`support.liveChat.hours` (09:00–21:00 `Asia/Kolkata`) is `[from, to)` on the
local clock; a window that crosses midnight is a night shift, two equal edges
are around the clock. Outside the hours — or inside them with **nobody
online** — `POST /live/start` still lands the message: as a **TICKET**, with a
SYSTEM line naming the next opening, and `{ fallback: 'TICKET', nextOpening }`
in the answer. The ticket thread is the fallback everywhere, which is why
nothing here can strand a person mid-sentence. The SYSTEM line is prose
(I4-B): `openingLabel` in `live-chat.hours.ts` prints the opening as the
desk's clock says it at the moment of writing — `Live chat is closed. ADX
opens again at 9:00 am IST on Tue 15 Sep and will reply on this ticket.` —
in the window's zone, IST when the runtime does not know the zone, never
an ISO instant for a phone to fail to convert. The status read carries the
same wording as `nextOpeningLabel` beside the instant.

### Presence and assignment

`live-chat.presence.ts` — one Redis sorted set, `support:presence`, member =
the operator, score = when their presence expires. `PUT /presence { online }`
writes now + 90 s, the desk's `POST /presence/heartbeat` (every 30 s) writes
it again, `{ online: false }` removes them. A console that crashes stops
heartbeating and drops out on its own; Redis down means nobody is online,
which is the honest answer and lands a ticket. A new chat goes to the
operator with the **fewest open chats** (ties by id, so it is deterministic),
announced on the thread with a SYSTEM `"Priya joined"` line and to that
operator in-app and by push (`LIVE_CHAT_ASSIGNED`). Ops may reassign
(`/reassign`) or end the live pace entirely (`/convert`, the same row,
`channel: TICKET`).

### The stream protocol

`GET /support/tickets/:id/events` — `text/event-stream`, `retry: 3000`, a
comment heartbeat every 25 s, and an `id` on every message event (its
`createdAt` in milliseconds) so `Last-Event-ID` resumes exactly where the
socket died. Without one the client gets the ticket's `status` and waits;
with one, every message written since is replayed first. Both SSE routes
also take the same instant as **`?lastEventId=<ms>`** (I4-B): the console's
reconnect is a fresh `EventSource` on a fresh single-use token — the spent
one would 401 forever — and a browser cannot put `Last-Event-ID` on a
connection it opens by hand, only on its own automatic retry. The header is
read first, the query second (`lastEventInstant`).

Events: `message` (`{ id, authorName, mine, kind, message, attachment | null,
createdAt }`), `typing` (`{ who, typing }`), `seen` (`{ who, at }`), `status`
(`{ status, channel }`), `assigned` (`{ name }`). An internal note is
filtered **on the way out**, per viewer, not on the publish — the same event
goes to the desk, which may see it.

**The token.** The phones open the stream with the bearer header like any
route. A browser's `EventSource` cannot set headers, so the console first
calls `POST /tickets/:id/stream-token` (an ordinary authenticated call) and
opens `…/events?t=<token>`: 32 random bytes, five minutes, **single use**
(the GET and the DEL travel in one MULTI), bound to one ticket and one
person. A token for another ticket, a second use, or one past five minutes is
401. `authenticateStream` prefers the header when both are present, and the
two SSE routes are registered **above** the router-wide `authenticate` for
that reason. **The grant does not freeze the person** (I4-B): when a token
is spent, the login's status and roles are read again through `users`
(`findUserSummaries`, one query per stream open), and a login since
deactivated, or no longer holding every role the grant was minted with, is
401 with `req.user` unset — an ADMIN whose role was removed cannot open the
inbox on a token minted a minute earlier. Nothing else about the token
changes: it stays five minutes, single use, bound to one ticket and one
person.

**The fan-out** (`live-chat.bus.ts`) is Redis pub/sub — `support:ticket:<id>`
per thread, `support:inbox` for the desk — with a local `EventEmitter` as the
delivery point, so a node keeps chatting through a Redis outage. Every event
is emitted locally *and* published; the `eid` on each one and a short memory
of those already delivered are what stop it arriving twice when Redis hands
it back. The subscriber is a second connection (`redis.duplicate()`), because
an ioredis client in subscriber mode can issue nothing else.

### Messages and attachments

`POST /tickets/:id/reply` takes `attachmentFileId` — a file already stored
through `POST /upload` with purpose **`SUPPORT_ATTACHMENT`** (a PRIVATE
purpose, added to `uploads` in this lot). It must be the caller's own, an
image or a PDF, and under `support.liveChat.attachmentMaxMb` (10); anything
else is a 400 **before** the message is written, so a rejected attachment
leaves no half-message behind. The message lands with `kind: ATTACHMENT`.
`uploads.FileAccessPort.supportPartyMayView` — filled in bootstrap from
`support.supportAttachmentViewer` — opens such a file to the requester of the
thread it sits on; the desk and the uploader are admitted by `uploads` before
the port is asked, and a file on no message opens to nobody else. The lookup
is filtered by the asking viewer (`findMessageByAttachment(fileId, viewerUserId)`),
because one file can sit on two threads — the desk reusing a screenshot — and
an unfiltered read would answer for whichever message came back first and
refuse the other requester their own attachment.

Every reply stamps `lastMessageAt`; the first agent reply stamps
`firstResponseAt` (the live clock) beside `firstRespondedAt` (the SLA's) and
pushes the requester `SUPPORT_REPLY` (transactional — a reply on your own
ticket is about your own account, and the in-app row stays); the requester's
reply tells the assigned operator `SUPPORT_MESSAGE_FROM_REQUESTER`. Typing is
published at most once per two seconds per person per chat and is never
written down; a `typing: false` always goes, because a stuck indicator is
worse than a missed one.

### The sweep

`jobs/live-chat-sla.job.ts`, every minute, Redis-locked (50 s, shorter than
the interval so a dead tick cannot hold the next one out):

- a chat past `firstResponseTargetSec` (120) with no agent reply publishes a
  `breach` to the inbox and pushes every operator on shift — **once per
  chat**, the Redis claim key is the once, so a chat waiting an hour does not
  page the desk sixty times;
- a chat **nobody is on** that **no agent has ever answered**
  (`firstResponseAt` null — the guard is that column, not whoever spoke
  last; I4-B) whose last message is 30 minutes old converts to a TICKET with
  a SYSTEM line and `LIVE_CHAT_CONVERTED` to the requester. A chat an
  operator holds is left alone: they are answering at their own pace and
  the sweep is not the judge of that. So is an unassigned chat an agent
  replied on before the requester spoke again — a conversation is going,
  however quiet, and the sweep must not turn it into a ticket behind the
  agent's back.

### The feature and the settings

`support.live-chat` (KILL_SWITCH, launch on, surfaces APP_USER + CONSOLE)
guards every live route with `requireFeature`, **except `GET /live/status`** —
that read exists to tell the phone which screen to draw, and a 503 tells it
nothing; off, it answers `entitled: false, reason: FEATURE_OFF` and the app
falls back to the ticket thread. Everything else is a platform setting under
`support.liveChat` (`enabled`, `hours`, `firstResponseTargetSec`,
`publisherTiers`, `attachmentMaxMb`), so every default above is reversible
from the console without a deploy. No new environment variables.

### Files

| File | What |
| --- | --- |
| `live-chat.entitlement.ts` | who is a paid subscriber, and what to offer whoever is not; the batch read for the inbox and `planOnDesk` (I4-B) |
| `live-chat.hours.ts` | the window, the next opening and (I4-B) `openingLabel`, the opening as a person reads it — pure, no I/O |
| `live-chat.presence.ts` | the Redis sorted set behind who is at the desk |
| `live-chat.bus.ts` | publish / subscribe, Redis with a local fallback |
| `live-chat.stream.ts` | the stream token (re-reading the person when it is spent), `authenticateStream`, the SSE writer, `lastEventInstant` (header, then `?lastEventId=`) |
| `live-chat.messaging.ts` | the attachment rule, the fan-out and the two pushes — a leaf both services share, so neither imports the other |
| `live-chat.service.ts` | the status read, starting, presence, reassign / convert, typing, seen, the inbox, canned replies, the sweep |
| `live-chat.controller.ts` | the handlers, including the two SSE ones |

### New dependencies

`publishers` and `advertisers` (the party behind a login), `revenue` (the
running subscription), `packages` (the active sale and its plan's
entitlements), `uploads` (the attachment record), `feature-flags` (the kill
switch, read inside the status handler). Each through the module's public
index; nothing in those modules imports `support`, so the graph stays
acyclic — `npx depcruise src/modules/support` says so. I4-B added the batch
forms of the same four reads (`findPublisherLabelsForUsers`,
`findAdvertiserLabelsForUsers`, `runningSubscriptionsForPublishers`,
`activePackagesForAdvertisers`) for the inbox — the last two new in
`revenue` and `packages`, the first two already there for E7-3 — and no
new edge.
