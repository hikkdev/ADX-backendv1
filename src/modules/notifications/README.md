# notifications

In-app notification feed and per-user delivery preferences — and, since Lot E
(decisions 87, 128, 147), the **dispatcher**: the one path every outbound
email and SMS leaves by, the templates it renders from, and the masked
delivery log behind `/comms`.

## Responsibilities

- Serve a user their own notification feed with an unread count.
- Mark one or all notifications read.
- Store and report per-type, per-channel delivery preferences.
- Raise notifications on behalf of other modules (`createNotification`).
- **Dispatch** (Lot E): `notify(event, userId, vars, opts)` writes the in-app
  row and one `NotificationDelivery` per outbound channel the event's ACTIVE
  template names and the person's preference allows; the sender renders and
  sends; a rail's delivery report lands on the row.
- The comms desk: the templates, the delivery log, the resend, the
  unsubscribe link.
- **Push** (G6, Q103/133): the device registry under `/users/me/devices`,
  FCM as the dispatcher's third outbound channel, and the silent
  `FLAGS_CHANGED` push every phone gets when a feature flag moves.

## Owned routes

`/api/v1/users/me/devices` — G6 (Q103/133), `deviceRouter`, mounted at
`/users` by bootstrap beside `account-lifecycle`'s router and ahead of
`userRouter`. Guard per route (`authenticate`), for the reason that router's
README gives: a router-wide layer on `/users` would 401 `bootstrap-admin`.

| Method | Path | Notes |
| --- | --- | --- |
| PUT | `/me/devices` | `{ token, app: USER \| AGENT, platform: ANDROID \| IOS, appVersion? }` — the phone's FCM registration, sent on every boot and every token refresh. **Upsert on the token**: a new row is **201**, a refresh 200, and a token that belonged to another login **moves to the caller** (200, `moved: true`) — a phone that changed hands must not keep hearing the old person's notices. Answers `{ id, app, platform, appVersion, tokenSuffix, lastSeenAt, createdAt, moved }` — the last six characters, never the token. A new row or a move is audited (`DEVICE_REGISTERED` / `DEVICE_MOVED`, target `DeviceToken`); a refresh is not. |
| GET | `/me/devices` | The caller's own devices, tokens masked to their suffix. |
| DELETE | `/me/devices/:token` | Sign-out on this phone. The caller's own row only; a token that is not theirs — or not on file — is **404**, never a 403 that confirms it exists. Audited `DEVICE_REMOVED`. |

`/api/v1/notifications` — all `authenticate`d, all scoped to the calling user.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | `limit`, `offset`, `unreadOnly`, `type` query params. E9: every row carries `relatedType` (what `relatedId` names) and `payload` (the modal's facts) — null where a notice has none; the unread count rides beside the rows; E10-1: `readCount` beside `unreadCount`, both over the whole feed |
| PATCH | `/read-all` | |
| GET | `/preferences` | |
| PUT | `/preferences` | |
| GET | `/:notificationId` | 404 if the notification belongs to someone else. E9: `relatedType` and `payload` on the row |
| PATCH | `/:notificationId/read` | 404 if the notification belongs to someone else |

`read-all` and `preferences` are registered ahead of `/:notificationId` so they
are not captured as ids. Do not reorder.

`/api/v1/comms` — Lot E. The unsubscribe link is public; everything else is
`authenticate` + ADMIN with the comms tiers (`comms.view` to read,
`comms.edit` to change).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/unsubscribe/:token` | **Public.** The link on an announcement email; HMAC-signed user id. Stamps `User.emailUnsubscribedAt`, answers an HTML page. Idempotent; a bad token is 404. |
| GET | `/events` | E10-2. The catalogue of events the code raises: `[{ event, variables[], raisedBy[], via, sensitive?, note?, templates: [{ key, status, channels }] }]` — `variables` are what the raising `notify()` call supplies (the registry `EVENT_REGISTRY` in `templates.ts`; `event-registry.test.ts` fails when a module raises an event not listed there, or a seeded template names a variable its event does not supply); `templates` is the copy on file for the event, any status. A template whose event nothing raises is listed last with no variables. |
| GET | `/sms-kinds` | E10-2. `{ kinds: SMS_KINDS, rails: SMS_RAIL_NAMES }` off `shared/sms`, so the console stops mirroring them. |
| GET | `/templates` | List contract: `q` over key / event / subject, `status` chips (DRAFT, ACTIVE, RETIRED), `sort=key\|newest`, `event`. Each row carries `variables[]` — the `{{names}}` its bodies use — and, E10-2, `stats: { sent30d, delivered30d, failed30d, deliveryRate }` from `NotificationDelivery` by `templateKey` over the last 30 Indian days (one grouped query for the page): `sent30d` = SENT + DELIVERED (what left), `delivered30d` = DELIVERED (what a rail confirmed — email has no report, so it stays 0 there), `failed30d` = FAILED, `deliveryRate` = sent / (sent + failed) to two places, null when nothing was attempted; QUEUED and SKIPPED count nowhere. |
| POST | `/templates` | `{ key, event, channels[], subject?, emailBody?, smsKind?, smsBody?, isSensitive?, transactional?, pushTitle?, pushBody?, status? }`. Key is a slug, event UPPER_SNAKE. An SMS channel needs a registered `smsKind` and an `smsBody`; email needs `emailBody`. Lot G (Q117): `transactional` defaults to **true**; `false` puts the copy under the quiet hours and the weekly cap (see below). G10 (Q103): `pushTitle` (200) and `pushBody` (1,000) are the push copy of its own — the same `{{vars}}`; null or absent, a push shows `subject` / `smsBody`. 409 on a taken key. Audited `NOTIFICATION_TEMPLATE_CREATED`. T-B: answers the list's row — `variables[]` and `stats` beside the stored row (`templateView`, one grouped stats query beside the write). |
| GET | `/templates/:key` | Carries `transactional`, `pushTitle`, `pushBody`; `variables[]` reads the push copy too; T-B: `stats` as on the list. |
| PATCH | `/templates/:key` | Any field but the key, `transactional`, `pushTitle` and `pushBody` included; **bumps `version`**. Audited `NOTIFICATION_TEMPLATE_UPDATED` with the diff. T-B: answers the list's row (`variables[]`, `stats`). |
| POST | `/templates/:key/send-test` | Lot G (Q117). `comms.edit`. The template rendered with **sample variables** (`sampleVariablesFor` in `comms-rules.ts` — a believable fake per known placeholder, `[name]` for one it does not know) and sent to the **signed-in operator's own email and mobile**, read from their user row — never to an address the body names: the body is `{ channels?: ('EMAIL'\|'SMS')[] }` and strict, so a `to` or an `email` in it is a 400. Any template status (a DRAFT is what one tests) and any sensitivity (samples are not credentials). Bypasses the preference matrix, the quiet hours and the weekly cap; the rows are ordinary deliveries with the operator as the recipient, attempted in the request. Answers **201** `{ templateKey, variables, deliveries: [{ channel, deliveryId, status, skipped? }] }`; 409 when the operator has no address for any channel the template names. Audited `NOTIFICATION_TEMPLATE_TEST_SENT` against the template key. |
| GET | `/deliveries` | List contract: `channel`, `status` chips (QUEUED, SENT, DELIVERED, FAILED, SKIPPED), `templateKey`, `userId`, `from`, `to`, `q` — an exact address is hashed and matched, a 64-hex string is taken as a hash, anything else is a contains on the mask. E10-2: the page carries `byChannel` (IN_APP, PUSH, EMAIL, SMS) beside `counts`, counted with the channel facet removed the way `counts` drops the status facet. |
| GET | `/deliveries/export.csv` | E10-2. ADMIN + `comms.view`. The log under the same filters and `sort` (no page) as a streamed CSV — a thousand rows a batch, 50,000 at most — columns `id, createdAt, templateKey, channel, status, recipientMasked, userId, notificationId, attempts, provider, providerMessageId, lastError, sentAt, deliveredAt`: the masked recipient only, never the hash and never the variables, whatever the template. E12-B: `lastError` leaves with any email or ten-digit / +91 number the provider quoted masked the way the recipient column is (`maskAddressesIn` in `recipient.ts`), and the walk is by keyset — `(createdAt, id)` under a fixed order, each batch continuing strictly past the last row of the one before — never skip/take, so a row the sender writes mid-stream can neither duplicate nor skip a row. Audited `COMMS_DELIVERIES_EXPORTED` before the first byte, the way the audit export is. |
| GET | `/deliveries/:id` | Both reads mask the **values** of a sensitive template's variables (`{ code: '•••' }`): an OTP or a payment link in the log would be a credential a comms desk could use. The row keeps the values for the sender's retries until the 7-day purge. Lot G: every row of the list and this read carries `scheduledFor` (Q117 — the instant a quiet-hours deferral waits for, null otherwise), and this read carries `attemptRows` (Q121 — one `DeliveryAttempt` per try, oldest first: `{ attempt, provider, providerMessageId, ok, responseText, error, at }`, the rail's raw answer with any address inside it masked by `maskAddressesIn`, cut to 1,000 characters). |
| POST | `/deliveries/:id/resend` | A fresh row for the same person and variables, attempted now. **409** for a sensitive template, purged variables, or an address no longer available. Audited `NOTIFICATION_RESENT`. |

`/api/v1/webhooks` — Lot E, no token.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/msg91` | MSG91's delivery report; matched on the request id. |
| POST | `/twilio` | Twilio's status callback; `X-Twilio-Signature` checked in the adapter, **401** when it fails or no auth token is on file. |

## Owned Prisma entities

`Notification`, `NotificationPreference`, (Lot E) `NotificationTemplate`,
`NotificationDelivery`, (Lot G, Q121) `DeliveryAttempt`, and (G6, Q103)
`DeviceToken`. This module also writes **one column on `User`**:
`emailUnsubscribedAt`, through the unsubscribe link — the same exception
`suspension` and `account-lifecycle` make, for the same reason: the stamp and
the link are one act. It reads `User.email / mobile / emailUnsubscribedAt /
isActive / closedAt` to address a delivery (`findRecipient`), narrowly, and
writes nothing else there.

## Public exports (`index.ts`)

- `notificationRouter`, `commsRouter`, `commsWebhookRouter` — mounted by `bootstrap/register-modules`.
- `createNotification(data)` — the in-app row: signature and callers as before; E9 adds the optional `relatedType` and `payload`.
- `RELATED_TYPES`, `isRelatedType`, the payload types (`KycDecisionAgentPayload`, `IncentiveRecordedPayload`, `AnnouncementPayload`, `StatementReadyPayload`) — E9, see below.
- `mayDeliver(userId, type, channel)` — the preference rule.
- `notify(event, userId | null, vars, { inApp?, type?, recipient?, channels?, immediate? })` — the dispatcher.
- `unsubscribeUrlFor(userId)` — for `announcements`' email.
- `ensureTemplates()`, `sendQueuedDeliveries()`, `purgeDeliveries()` — for bootstrap and `jobs/notification-sender.job.ts`.
- `NOTIFICATION_CHANNELS`, `NOTIFICATION_TYPES`, `NewNotification`.
- G6 (Q103/133): `deviceRouter` — mounted at `/users` by bootstrap;
  `broadcastFlagsChanged({ key?, changeId? })` — what bootstrap hands
  `feature-flags.registerFlagChangePort`, the silent `{ type: 'FLAGS_CHANGED' }`
  data push to every device on file, walked by keyset in batches of 500;
  `sendPushToUser(userId, message)` — one push outside the dispatcher (nothing
  uses it today; prefer `notify` with a template that names PUSH).

E10-2, internal to the module: `EVENT_REGISTRY` / `isRegisteredEvent` in
`templates.ts` (the events catalogue), `templateStats` / `eventCatalogue` /
`iterateDeliveryRows` / `deliveryCsvLine` in `dispatch.service.ts`.

Everything else is internal. Importing `notifications/notifications.service`
from another module is a lint error.

## `relatedType` and `payload` (E9)

`Notification.relatedType` says what `relatedId` names, so a push or a tap
opens the right record; `Notification.payload` carries the structured facts
behind a notice the apps draw as a modal, beside the prose. Both are written
as the caller sends them and returned on every row of the feed; a notice
with neither has both null. The vocabulary is closed — the eleven records an
app screen can open — and the payload shapes are documented in
`notifications.types.ts`:

| `relatedType` | `relatedId` is | Raised by |
| --- | --- | --- |
| `ORDER` | the order | `orders/orders.notify` (every order notice, incl. `ORDER_AGENT_REASSIGNED`), `jobs/publisher-timer` |
| `PUBLISHER` | the publisher | `publishers` — the agent's `KYC_DECISION_AGENT` notice (payload `{ publisherId, publisherName, status, decidedAt }`), the publisher's own `KYC_DECISION`, re-upload request, Digio restart, the Digio webhook's agent notice; `payouts` `INCENTIVE_RECORDED` for a `PUBLISHER_ONBOARDED` row |
| `ADVERTISER` | the advertiser | `payouts` `INCENTIVE_RECORDED` for an `ADVERTISER_ONBOARDED` row |
| `CAMPAIGN` | the campaign | `campaigns` (ready-to-pay, venue approval, creative decisions, landing page taken down, end-of-flight review ask), `payments` (received / failed, when the payment is a campaign's), `payouts` `INCENTIVE_RECORDED` for a `CAMPAIGN_ASSIST` (payload `{ event, amount, campaignId, partyName }`) |
| `STATEMENT` | the statement | `invoices` `STATEMENT_READY` (payload `{ statementId, month, net }`) |
| `WITHDRAWAL` | the withdrawal | `payouts` `PAYOUT_PAID` |
| `TICKET` | the support ticket | `support` (new ticket, reply, waiting, closed / reopened, assigned) |
| `DISPUTE` | the dispute | `disputes` (opened, reply, evidence, status, decision, credit released, reopened) |
| `ANNOUNCEMENT` | the announcement | `announcements` (payload `{ announcementId, importance, title, body }`) |
| `LISTING` | the listing | `listings` (taken off the market), `pricing` (repriced), `rate-cards` (below the floor), `reviews` (new review), `supply` (verified, awaiting publish) |
| `WORK` | the work task | `work/work.notify` — every `WORK` notice (assigned, review requested, sent back, due tomorrow, overdue, comment); AB-B |
| `LEAD` | the lead | `leads/map.service` — LH5's three pushes (`LEAD_NEARBY_HOT`, `LEAD_CLAIM_LAPSING`, `LEAD_LINK_OPENED`); LH6's two (`LEAD_REPLY_RECEIVED`, `LEAD_CALLBACK_REQUESTED`); `deepLink` `adx://lead/<id>` rides the push data too |

A `relatedId` that is none of these carries **no** `relatedType`: the
advertiser's own KYC notices (the KYC case), a fraud case, a safety alert, a
package sale, a corrected spot, a visit, a payment refund and the ops notices about a captured-but-unapplied or mismatched payment (the payment), an
erasure request, the restore-drill key, the `integrations` settings key,
the mobile-change notice (the user). The id is still there for the screen
that raised it; nothing in the apps is told to open it.

## The dispatcher (Lot E)

```
notify(event, userId, vars, opts)
  ├─ opts.inApp && userId  → createNotification(...)            (the in-app row, as always)
  ├─ ACTIVE template for `event`?  none → done
  ├─ recipient = opts.recipient ?? User(userId)
  └─ for each channel in template.channels ∩ {EMAIL, SMS, PUSH} ∩ opts.channels:
        no address            → skipped NO_ADDRESS   (PUSH: no login, or no device on file → NO_DEVICE)
        account closed        → skipped ACCOUNT_CLOSED
        SMS with no smsKind   → skipped NO_SMS_KIND
        ANNOUNCEMENT email to an unsubscribed user → skipped UNSUBSCRIBED
        !mayDeliver(type)     → skipped PREFERENCE_OFF
        else                  → NotificationDelivery QUEUED { recipientMasked, recipientHash, variables }
                                 address → Redis `comms:addr:<id>` for 48h
  opts.immediate → attemptDelivery(row) now; a failure is left for the job
```

- **The row never holds the rendered text** (decision 87): the template key and
  the variables, the recipient masked (`+91 98450 •••23`, `j***@x.com`) and
  hashed — Lot F: a **keyed HMAC-SHA256** of the canonical address under
  `JWT_ACCESS_SECRET` (the key the unsubscribe token already uses), so a
  leaked table cannot be brute-forced back into ten-digit mobiles: without
  the key there is nothing to compare a guess against, and the `?q=<address>`
  search still works because the server hashes the query the same way
  (rows hashed before Lot F no longer match an address search; the mask
  does). The address the sender needs is
  stashed in Redis for two days and resolved from the user row after that —
  only if it still hashes the same.
- **Sending** (`attemptDelivery`): email renders `subject` and `emailBody`
  (values HTML-escaped) and goes by the ONE door, `shared/email`'s
  `sendEmail` (AE-B) — SMTP, Resend or the Ethereal test inbox, as the
  integrations row says (`email.primary`, `email.mode`); the door's answer
  is mapped onto the row: `provider` in the log's lower-case spelling
  (`smtp`, `resend`, `ethereal`), `providerMessageId`, and the attempt row's
  `responseText` with an Ethereal preview URL appended
  (`… | preview: https://ethereal.email/message/…`) so the Delivery log
  shows where a test message can be read. SMS goes
  by `sendSms({ kind: template.smsKind, vars, body })`. Success → SENT with
  `provider` and `providerMessageId`; a rail that declines the kind → SKIPPED;
  a door that answers `configured: false` → SKIPPED `EMAIL_UNCONFIGURED`;
  a throw → QUEUED with `lastError` until the third attempt, then FAILED.
- **The job** (`jobs/notification-sender.job.ts`): every 30 s under a Redis
  lock, every QUEUED row under the cap, oldest first; once a day the purge —
  `variables` nulled at 90 days (7 for `isSensitive`), rows deleted at 180.
- **Immediate**: the OTPs — the admin second factor (SMS and email), the
  email login code, the invite, the package link — are attempted in the
  request; the job is their retry.
- **Preferences**: `SYSTEM` on SMS and EMAIL and `ANNOUNCEMENT` on SMS are
  mandatory (a sign-in code and a service notice are not preferences);
  `ANNOUNCEMENT` email defaults on and is governed by the unsubscribe link.
- **Templates**: `templates.ts` seeds one ACTIVE row per message that already
  left the platform — `login-otp`, `login-otp-email`, `two-factor-sms`,
  `two-factor-email`, `admin-invite`, `package-link`, `kyc-decision`,
  `payout-paid`, `visit-offer`, `announcement`. `ensureTemplates()` runs at
  boot, writes only missing keys, never overwrites. In-app copy is **not**
  templated; it stays in the code that raises the event. G10: the seeded
  `announcement` names `PUSH` beside EMAIL and SMS with `pushTitle`
  `{{title}}` / `pushBody` `{{body}}` — on a fresh database; an existing
  row is ops' and keeps its channels. Lot V adds `city-withdrawn`
  (`CITY_WITHDRAWN`, EMAIL + PUSH, transactional — `city`, `detail`): the
  hourly city wind-down (`geo`) tells each publisher whose live listings it
  took down, and each agent in the city, once; the in-app row rides the
  same `notify()` call.
- **Sensitive** (`isSensitive`): an OTP, a sign-in link, a payment link.
  Never resent from the log; variables purged in a week.

Lot F: `renderHtml` turns a newline inside a **value** into `<br>` after
escaping, so an announcement typed as paragraphs reads as paragraphs. The
seed also carries `statement-ready` (`STATEMENT_READY`, EMAIL — `month`,
`net`, `url`, `partyName`, `reference`), raised by `invoices`'
`runMonthlyStatements` once per advice and governed by PAYOUT × EMAIL — the
matrix is per type, not per event.

E9: the seed also carries `mobile-changed` (`MOBILE_CHANGED`, SMS, kind
`CHANGE_MOBILE` — `newMasked`, `date`): `auth/mobile-change` sends it to the
**old** number after the swap, in the request, with the in-app row beside it;
a dead rail or an unregistered kind is logged and skipped, never a failed
swap.

Callers today: `auth` (2FA SMS through `TWO_FACTOR_SMS`, 2FA email through
`TWO_FACTOR_EMAIL`, email login through `LOGIN_OTP_EMAIL`, the invite through
`ADMIN_INVITE`, the moved number through `MOBILE_CHANGED`), `packages` (`PACKAGE_LINK` to the advertiser's own contact
details, no user needed), `announcements` (`ANNOUNCEMENT`), and — Lot F — the
three Lot E1 left behind: `kyc` and `publishers` (`KYC_DECISION`), `payouts`
(`PAYOUT_PAID`), `visits` (`VISIT_OFFER`), plus `invoices` (`STATEMENT_READY`).
The ordinary login OTP SMS is a direct `sendSms({ kind: 'LOGIN_OTP' })`.

## The comms rules (Lot G, Q117) and the attempt rows (Q121)

Two platform settings govern **non-transactional** copy — a template whose
`transactional` is false; the seed marks `announcement` and
`statement-ready` so, and `ensureTemplates()` also stamps the flag on a
seeded row nobody has edited (`version` 1), since the column arrived
defaulting to true. An OTP, a decision, a payment, a service notice is
transactional and ignores both rules.

- **`comms.quietHours`** `{ from: '21:00', to: '08:00', tz: 'Asia/Kolkata' }`:
  a non-transactional email, SMS or push raised inside the window is written
  **QUEUED with `NotificationDelivery.scheduledFor`** at the window's end
  (`quietHoursDeferral` in `comms-rules.ts`: the minutes left in the window,
  cut to the whole minute, so every message deferred in one night leaves
  together; a window that crosses midnight is an evening-through-morning one,
  one that does not is an afternoon; equal edges are no window). G10: the
  column is the deferral — `findQueued(limit, now)` picks only rows whose
  `scheduledFor` is null or `<= now` (index `(status, scheduledFor)`), so
  there is no release step and nothing derives anything: the list and the
  read carry the column as the row holds it. **One release**: a row written
  before the column carried the instant in `lastError` as
  `QUIET_HOURS until <iso>` (`DEFERRAL_MARKER`, `readDeferral`); the sender
  tick's first step, `foldLegacyDeferrals` (500 a tick, `folded` in the
  tally), moves it onto the column and clears the marker — a marker that does
  not parse is scheduled for now — and `findQueued` leaves such a row alone
  until it is folded. Once no row carries the marker the fold, the constant
  and `readDeferral` go. The address stash outlives the longest window.
- **`comms.weeklyCapPerUser`** (default 5): the person's non-transactional
  rows this **Indian week** (`weekWindowIST`: Monday 00:00 IST to the next
  Monday) across every channel, every status but SKIPPED, counted by
  `userId` — or by `recipientHash` for an address with no login. The ruling
  is made once per `notify()` call and the counter moves by the rows the
  call writes, so a message on two channels spends two, and the row beyond
  the cap is born **SKIPPED with `lastError: 'WEEKLY_CAP'`** — it is in the
  log, so the desk can see what was withheld — and answered as
  `{ deliveryId, skipped: 'WEEKLY_CAP' }`. The cap is judged before the quiet
  hours: a capped row at night is skipped, not deferred.
- **Attempt rows**: `attemptDelivery` writes one `DeliveryAttempt` per try,
  whatever the try came to — `{ attempt, provider, providerMessageId, ok,
  responseText, error }` — including a try that never reached a rail
  (`TEMPLATE_MISSING`, `RECIPIENT_UNAVAILABLE`, `EMAIL_UNCONFIGURED`, a
  declined kind). `responseText` is what the door answered: nodemailer's
  `response` line or Resend's body (`shared/email` now returns a
  `MailSendReceipt`), MSG91's JSON or Twilio's `{ sid, status }` (the rails'
  `SmsSendResult.responseText`), masked and cut to 1,000 characters. The row
  never decides the outcome — one that cannot be written is logged. A
  delivery report from a rail is not an attempt.

## Push (G6, Q103/133)

`push/` is the third rail. `shared/push/fcm.ts` is the door: FCM HTTP v1,
no firebase-admin — the service-account JSON from `FIREBASE_SERVICE_ACCOUNT_JSON`
(raw or base64) signs an RS256 JWT grant with `node:crypto`, the token
endpoint swaps it for an hour's bearer (cached, re-minted on a 401), and a
message is one POST to `projects/<id>/messages:send`. Unset, every send
answers `{ skipped: true, reason: 'FCM_NOT_CONFIGURED' }` and the log says so
once; a malformed key is `FCM_MISCONFIGURED`. No secret ever reaches a
response or a row.

- **The registry** (`push.service.ts`): `PUT /users/me/devices` upserts on the
  token and the token follows the login. A send goes to **every device the
  person holds**; a token FCM calls `UNREGISTERED` has its row deleted on the
  spot — there is nothing to retry to. Only token suffixes appear in
  responses, audit rows and attempt rows.
- **The dispatcher's PUSH channel** (`push-delivery.ts`): a template may name
  `PUSH` beside EMAIL and SMS. `notify` writes one `NotificationDelivery` per
  push, masked as the device count (`2 devices`) and hashed on the user id
  (there is no address to stash in Redis; the devices are read again at send
  time, so a phone registered in between still hears it). The phone shows
  the template's `pushTitle` and `pushBody` (G10, Q103 — push copy edited on
  its own, the same `{{vars}}`) when set, else its `subject` as the title and
  its `smsBody` (plain text) as the body — falling back to the in-app row's
  own title and message when the delivery sits beside one — and the data payload
  carries `type` (the event), `deliveryId`, and the in-app row's id, type,
  `relatedType` and `relatedId`, so a tap opens the right screen — and (Lot
  N) `deepLink` when the raise put an `adx://…` link in its variables
  (`KYC_REQUESTED` opens the party's KYC screen). Outcome
  over every device: one delivered → SENT (`provider: fcm`, the first message
  id); none and something retryable (rail down, quota, bearer refused) →
  QUEUED to the cap, then FAILED; every token stale or malformed → FAILED
  `NO_VALID_DEVICE` at once; no device or no Firebase → SKIPPED. One
  `DeliveryAttempt` per try (Q121) with the per-device tally as
  `responseText`. A push resends from the log like email and SMS.
- **Preferences**: PUSH defaults **on for every kind** — everything in-app
  is, and the kinds SMS carries by default (the security and service
  notices) — and every row stays switchable; `mayDeliver(type, 'PUSH')`
  governs it like the others.
- **The kill switch** (G10): the three device routes sit behind
  `requireFeature('comms.push')` (declared in `features.ts`, a KILL_SWITCH,
  launched on). Off, a phone cannot register a token and the routes answer
  503 FEATURE_OFF.
- **`FLAGS_CHANGED`**: `feature-flags` declares a change port; bootstrap
  fills it with `broadcastFlagsChanged`, a silent data push
  (`{ type: 'FLAGS_CHANGED', key, changeId, at }`, `content-available` for
  iOS) to every device on file, so a kill switch lands without waiting for a
  cold start. The apps answer it by re-reading `/app/flags`; nothing is
  decided from the payload. Not a delivery row — it is not a notice to a
  person — and skipped with the fleet count logged when FCM is off.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/pagination`, `shared/audit`, `shared/cache`, `shared/email`,
  `shared/sms`, `shared/integrations`, `shared/push` (G6), `shared/database`
  (repositories only).
- `app-config` — `getPlatformSettings()` for the comms rules (Lot G, Q117).

## Consumers

`orders`, order assignment, publisher KYC, `jobs/publisher-timer` and the 5xx
alert call `createNotification`; `auth`, `packages`, `announcements` and (G6)
`account-lifecycle` (`DATA_EXPORT_READY` — email and push, seeded as
`data-export-ready`) call `notify`; bootstrap wires `broadcastFlagsChanged`
into `feature-flags`' change port.

Lot I adds five transactional push events raised by `support`, all seeded
here with push copy of their own: `SUPPORT_REPLY` (ADX answered the
requester's thread — the in-app MESSAGE row rides beside it),
`SUPPORT_MESSAGE_FROM_REQUESTER` (to the operator who holds the chat),
`LIVE_CHAT_ASSIGNED` (a chat put on an operator, at start or on a reassign),
`LIVE_CHAT_BREACH` (past the first-response target, to every operator on
shift, once per chat) and `LIVE_CHAT_CONVERTED` (the chat continues as a
ticket). Transactional on purpose: each is about the person's own
conversation, so the quiet hours and the weekly cap do not hold it.

## Invariants

- A notification is readable only by `notification.userId`. Ownership is checked
  before both read and mark-read; a mismatch is a 404, never a 403.
- `GET /preferences` always returns a row for every notification type on
  every channel, defaulting where the user has never saved one; a mandatory
  row is never saved off.
- `PUT /preferences` is an upsert per (type, channel); omitted rows keep their
  stored value.
- A `NotificationDelivery` never carries a raw address or a rendered body; nor
  does a `DeliveryAttempt` — the rail's answer leaves masked.
- A device token is a credential: it leaves the module only towards FCM.
  Responses, audit rows and attempt rows carry its last six characters.
- A test send goes to the operator's own addresses and never to one the
  request names.
- `createNotification` keeps its signature; `notify` is additive.
- A template's `key` is immutable; every edit bumps `version`.

## Tests

```bash
npx vitest run src/modules/notifications
```

## Suggested ownership

Small — the feed is a good first module. The dispatcher and the desk are
Platform: every outbound message passes through here.

## WhatsApp as a channel (LH6)

`NotificationChannel` carries `WHATSAPP`. A template may name it
(`TEMPLATE_CHANNELS`); the dispatcher sends it to the person's mobile
through `shared/outreach`'s WhatsApp adapter — the Channels card's approved
template of the same key when one is mapped (a business-initiated message
must be one), else the template's `smsBody` as free text (delivered only
inside a customer-service window). No card: the row is SKIPPED
`WHATSAPP_UNCONFIGURED`. There is no WhatsApp row on the preferences
screen — it follows the person's SMS preference (`mayDeliver`). The
outreach hub's own SMS and email to *leads* leave by `LEAD_OUTREACH` (the
`lead-outreach` template, `{{body}}` the copy already rendered, transactional
so the hub's own ruling on quiet hours and the weekly cap is the only one).
