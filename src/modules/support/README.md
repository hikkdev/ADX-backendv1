# support

Support tickets raised by users, and the message thread on each one.

## Responsibilities

- List, read and raise a user's own tickets.
- Append replies, keeping the ticket's `updatedAt` in step.
- Open and close tickets.

## Owned routes

All mounted at `/api/v1/support`, all `authenticate`d, all scoped to the caller.

| Method | Path | Status |
| --- | --- | --- |
| GET | `/tickets` | 200 |
| POST | `/tickets` | **201** |
| GET | `/tickets/:ticketId` | 200 |
| POST | `/tickets/:ticketId/reply` | **201** |
| PATCH | `/tickets/:ticketId/status` | 200 |

## Owned Prisma entities

`SupportTicket`, `TicketMessage`.

## Public exports (`index.ts`)

- `supportRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repository only).
- No other business module.

## Invariants

- A ticket is visible only to `ticket.userId`.
- Reading a ticket that exists but belongs to someone else returns **404**;
  replying to one returns **403**. That asymmetry is inherited from the original
  controller and is deliberately preserved — changing it would change the API.
- A reply and the parent ticket's `updatedAt` are written in one transaction, so
  the list ordering (`updatedAt desc`) can never disagree with the thread.
- The first message of each ticket is included in list responses (`take: 1`);
  the full thread only in single-ticket responses.

## Known cross-boundary read

`findAuthorDisplayName` reads the `User` row to label a reply author
(`name ?? mobile ?? 'Agent'`). `User` belongs to the `users` module. Support was
migrated before `users`, so the query lives here for now; it should become a
call to the `users` module's public lookup. Tracked in
`docs/backend-modules.md`.

## Tests

```bash
npx vitest run src/modules/support
```

## Suggested ownership

Small and self-contained; pairs naturally with `notifications`.
