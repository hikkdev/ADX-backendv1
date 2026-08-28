# integrations

The admin screen over third-party provider credentials: SMS, email, storage,
KYC, Twilio, Resend, Google Maps, Razorpay, Stripe and branding.

## This module owns the screen, not the storage

Resolving effective configuration — stored override falling back to `.env`, with
a Redis cache — lives in **`shared/integrations`**, not here. It has to:
`shared/sms`, `shared/email` and `shared/storage` all read it, and shared
infrastructure may not import a business module. This module is the HTTP surface
over that resolver.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/integrations` | `authenticate` + ADMIN |
| PUT | `/api/v1/integrations` | `authenticate` + ADMIN |

The guard is applied to the whole router, not per route, because every endpoint
here exposes or mutates credentials.

## Owned Prisma entities

None directly. Configuration is one `AppConfig` row, written through
`shared/integrations`.

## Public exports (`index.ts`)

- `integrationsRouter`.

## Files

- `integrations.mapper.ts` — builds the GET response. **Every secret is masked
  here and nowhere else**, so there is one place to audit that a raw credential
  never leaves the server.
- `integrations.schema.ts` — `sectionSchema` and the per-section `patchSchemas`,
  typed against `IntegrationsConfig` so a new config section cannot be added
  without a matching validator.

## Invariants

- Secrets are returned masked (`••••` + last 4), never raw. Values of 4
  characters or fewer mask completely.
- `branding` is **not** masked — it is not secret.
- `infra` is read-only and never editable from this UI: changing the database
  URL or a JWT secret live would either need a restart or invalidate every
  active session, including the editor's own. The database URL is returned with
  its password masked; the secrets report the literal string `configured`.
- `PUT` takes `{ section, patch }`. A field omitted from `patch` keeps its
  stored value — necessary because the client never receives the real secret
  and so cannot round-trip it, only supply a deliberately entered new one.
- An unknown `section` is **400**, distinguished from an invalid `patch`, which
  is also 400 but with the section's own field errors.
- Every successful update writes an `INTEGRATION_CONFIG_UPDATED` activity log
  recording the section and the field names — never the values.

## Tests

```bash
npx vitest run src/modules/integrations
```

## Suggested ownership

Platform team. Credential handling — review changes to the mapper carefully.
