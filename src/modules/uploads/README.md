# uploads

The single ingest point for files.

Every other module takes **URLs, not files**: `kyc`, `employees`, `publishers`
and `orders` all expect a client to POST the file here first and send the
returned URL onward. Keeping that one-way rule is what stops multipart handling
spreading across the codebase.

## Owned routes

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/api/v1/upload` | `authenticate` | **201** |

Chain: `authenticate` → `handleUploadMiddleware` → `uploadFileHandler`.
`handleUploadMiddleware` must stay a distinct layer ahead of the handler —
multer has to consume the multipart body before anything can read `req.file`.

## Owned Prisma entities

`UploadedFile`.

## Public exports (`index.ts`)

- `uploadRouter`.

## Dependencies

- `shared/storage` — the provider adapter (local disk or Cloudflare R2, chosen
  from the integrations config).
- `shared/http`, `shared/auth`, `shared/errors`, `config/env`,
  `shared/database` (repository only).
- No other business module.

## Invariants

- Accepted types: JPEG, PNG, WebP, HEIC, SVG, PDF. Anything else is **400**,
  not 415.
- Maximum 10 MB; multer's own errors are translated into the API envelope, so a
  rejected upload is a 400 rather than a bare 500.
- Files land in `uploads/tmp` first and the temp file is removed in a `finally`
  block, so a failed upload cannot leak it. Deletion failure is non-fatal.
- An unrecognised `purpose` falls back to `OTHER` rather than failing the
  upload; the folder for an unknown purpose is `misc`.
- The response is deliberately narrow — `{ url, id }` only, never the whole row.
- `baseUrl` comes from `BASE_URL`, falling back outside production to the
  request's **Host header** rather than `req.hostname`, because `req.hostname`
  strips the port and would produce unreachable dev URLs.

## Tests

```bash
npx vitest run src/modules/uploads
```

## Suggested ownership

Platform team — it is infrastructure with one route.
