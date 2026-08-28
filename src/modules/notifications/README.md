# notifications

In-app notification feed and per-user delivery preferences.

## Responsibilities

- Serve a user their own notification feed with an unread count.
- Mark one or all notifications read.
- Store and report per-type delivery preferences.
- Raise notifications on behalf of other modules.

## Owned routes

All mounted at `/api/v1/notifications`, all `authenticate`d, all scoped to the
calling user.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | `limit`, `offset`, `unreadOnly`, `type` query params |
| PATCH | `/read-all` | |
| GET | `/preferences` | |
| PUT | `/preferences` | |
| GET | `/:notificationId` | 404 if the notification belongs to someone else |
| PATCH | `/:notificationId/read` | 404 if the notification belongs to someone else |

`read-all` and `preferences` are registered ahead of `/:notificationId` so they
are not captured as ids. Do not reorder.

## Owned Prisma entities

`Notification`, `NotificationPreference`.

## Public exports (`index.ts`)

- `notificationRouter` — mounted by `bootstrap/register-modules`.
- `createNotification(data)` — the one behaviour other modules may call.
- `NewNotification` type.

Everything else is internal. Importing `notifications/notifications.service`
from another module is a lint error.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repository only).
- No other business module.

## Consumers

`orders`, order assignment, publisher KYC and `jobs/publisher-timer` all call
`createNotification`.

## Invariants

- A notification is readable only by `notification.userId`. Ownership is checked
  before both read and mark-read; a mismatch is a 404, never a 403, so the
  endpoint does not leak whether an id exists.
- `GET /preferences` always returns a row for every notification type,
  defaulting to `enabled: true` when the user has never saved one.
- `PUT /preferences` is an upsert per type; types omitted from the body keep
  their stored value.

## Tests

```bash
npx vitest run src/modules/notifications
```

## Suggested ownership

Small and self-contained — a good first module for a new team member.
