# app-config

The single `AppConfig` row (`key: 'main'`) holding the enum catalogue and the
flow-editor definitions the agent app boots from.

## Three different things called "config"

| | what | where |
| --- | --- | --- |
| **app-config** (this) | enums + flow definitions, edited by the flow editor | `AppConfig` row `main` |
| `src/config/` | process environment validation | `.env` via Zod |
| `integrations` | third-party provider credentials | a different `AppConfig` row |

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/config` | **none** |
| PUT | `/api/v1/config` | `adminSecretOrAdminRole` |

`GET` is deliberately public: the agent app fetches it on boot, before anyone
has signed in.

`PUT` accepts **either** credential (`app-config.policy.ts`):

1. the `x-admin-secret` header, used by the standalone flow editor, which has no
   login and no JWT to present;
2. a normal ADMIN access token.

The header is checked first; when absent or wrong the request falls through to
the JWT path and produces the usual 401 or 403.

## Owned Prisma entities

`AppConfig` (the `main` key).

## Public exports (`index.ts`)

- `configRouter`.
- `APP_ENUMS` — the fallback enum catalogue, also read by `scripts/seedConfig`.

## Invariants

- `GET` responds with `Cache-Control: no-store`. The agent app polls this after
  edits; a cached copy would serve a stale flow definition.
- With no row written yet, `GET` serves `{ enums: APP_ENUMS, flows: {} }` so a
  fresh install still boots.
- `PUT` requires `flows` and `enums` to both be plain objects, and **replaces**
  the row wholesale — it is not a merge.
- `PUT` validation is hand-rolled, not Zod, and its error envelope is
  `{ success: false, error: "<string>" }` — a plain string, **not** the
  `{ code, message }` object every other endpoint returns. The flow editor
  depends on this shape; do not normalise it without changing that client.

## Tests

```bash
npx vitest run src/modules/app-config
```

## Suggested ownership

Platform team, alongside `integrations`.
