# announcements

A broadcast from ops — Lot E (decisions 64 and 130). Not to be confused with
`notifications`, which owns the bell and the dispatcher this module sends
through, or with `app-config`'s `app-status` banner, which is one line every
app reads before anyone signs in.

## Responsibilities

- The desk: draft an announcement for an audience (optionally one city),
  preview how many people each channel would reach, send it now or at a time,
  cancel it.
- The fan-out: on the job's tick, walk the audience in batches of 500 through
  `notifications.notify` — an in-app `ANNOUNCEMENT` row for everyone, email to
  those with an address who have not unsubscribed, SMS only when CRITICAL —
  marking each (person, channel) once.

## Owned routes

`/api/v1/announcements` — `authenticate` + ADMIN at the router; `comms.view`
to read, `comms.edit` to write.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | List contract: `q` over the title, `status` chips (DRAFT, SCHEDULED, SENDING, SENT, CANCELLED), `audience`, `sort=newest\|oldest`. |
| POST | `/` | `{ title, body, audience?, city?, channels?, importance?, scheduledAt? }` → DRAFT. `IN_APP` is always added; `SMS` on a NORMAL announcement is **400** (Q130); `PUSH` (G10) goes through the dispatcher's push rail to everyone in the audience with a device on file — a member without one is a SKIPPED mark. Audited `ANNOUNCEMENT_CREATED`. |
| GET | `/:id` | |
| POST | `/preview-count` | E10-2. `{ audience?, city?, channels[], importance? }` — the same answer as `GET /:id/preview-count` over a draft body, persisted nowhere, for the desk while the announcement is still being typed. A NORMAL draft naming SMS is not refused here as a create is: `sms: 0` with the reason in `smsNote`. `comms.view`. |
| GET | `/:id/preview-count` | `{ audience, inApp, email, sms, push, smsNote }` — in-app = the audience; email = those with an email and no `emailUnsubscribedAt`; sms = the audience only when CRITICAL **and** `ANNOUNCEMENT_CRITICAL` is registered on a rail, else 0 with the reason in `smsNote`; G11-2: push = the `DeviceToken` rows whose owner is in the audience (devices, not people — one per phone), when `PUSH` is a channel, else 0. Both previews carry it. |
| POST | `/:id/send` | `{ scheduledAt? }`. A future time → SCHEDULED (audited `ANNOUNCEMENT_SCHEDULED`); otherwise SENDING now (audited `ANNOUNCEMENT_SEND_REQUESTED`). From DRAFT or SCHEDULED only; 409 otherwise. G10: behind `requireFeature('comms.announcements')` — 503 FEATURE_OFF while the switch is off; a draft is still written and read. |
| POST | `/:id/cancel` | From DRAFT, SCHEDULED or SENDING → CANCELLED; a running send stops between batches. Audited `ANNOUNCEMENT_CANCELLED`. |

## Owned Prisma entities

`Announcement`, `AnnouncementDelivery` (unique per announcement, user,
channel — the idempotency mark).

The audience queries (`audienceCounts`, `audiencePage`) read `User`,
`UserRole` and the `city` column on `Publisher`, `Advertiser` and
`AgentProfile` **read-only**, in this module's repository — the same
arrangement `admin-overview` has across the ledger. An audience is a live,
verified account (`isActive`, no `closedAt`, `mobileVerifiedAt` set) holding
the audience's roles; ALL is publishers, advertisers and both agent roles —
never admins or partners. A city matches the profile of the audience in
question, case-insensitively.

## Public exports (`index.ts`)

- `announcementRouter` — mounted by `bootstrap/register-modules`.
- `sendDueAnnouncements(now)` — for `jobs/announcement-sender.job.ts`.

## The fan-out

```
tick (every 30 s, Redis lock held up to 10 min)
  ├─ SCHEDULED with scheduledAt <= now → SENDING
  └─ for each SENDING announcement:
       recipientCount = audience size
       page the audience by id, 500 at a time:
         re-read the announcement — CANCELLED? stop
         existing marks for these users
         for each user, the channels not yet marked:
           notify('ANNOUNCEMENT', userId, { title, body, unsubscribeUrl },
                  { type: 'ANNOUNCEMENT', channels: [EMAIL?, SMS?], inApp?: {...} })
           marks: IN_APP DELIVERED, EMAIL/SMS QUEUED or SKIPPED
         write the marks (skipDuplicates)
       SENT with sentAt, deliveredByChannel = marks by channel and status
       audit ANNOUNCEMENT_SENT (actor = createdById)
```

- **SMS is CRITICAL only** (Q130): `smsAllowed()` says yes for CRITICAL at
  any hour and no for NORMAL; the quiet-hours rule (21:00–09:00 IST,
  `isSmsQuietHour`) is wired underneath for the day the policy widens. The
  `ANNOUNCEMENT` template's `smsKind` is `ANNOUNCEMENT_CRITICAL`; unregistered,
  the dispatcher skips the SMS and the preview says so.
- **Email carries an unsubscribe link** — `GET /comms/unsubscribe/:token`,
  minted by `notifications.unsubscribeUrlFor`. The dispatcher skips an
  `ANNOUNCEMENT` email to anyone with `emailUnsubscribedAt`; transactional
  email is unaffected.
- **Idempotent**: the (announcement, user, channel) mark is written after the
  send is queued, and a batch never re-sends a marked pair, so a crashed tick
  resumes on the next with nobody messaged twice.

## Dependencies

- `notifications` (`notify`, `unsubscribeUrlFor`), `shared/sms`
  (`isSmsKindRegistered`), `shared/audit`, `shared/pagination`, `shared/http`,
  `shared/auth`, `shared/errors`, `shared/database` (repository only).

## Invariants

- Every announcement has `IN_APP` in its channels: the row in the bell is the
  record.
- A NORMAL announcement never reaches SMS, whatever its channels say.
- `recipientCount` is the audience size at send time; `deliveredByChannel` is
  the count of marks by channel and status when the walk finished.
- A cancel is honoured between batches, never mid-batch.

## Tests

```bash
npx vitest run src/modules/announcements
```

## Suggested ownership

Platform — with `notifications`, since every announcement goes through it.
