# branding

QR-11 (17 Sep 2026): the brand manager behind the console's **Settings ›
Brand & theme** — the place the logo, the colours, the words and the website
kit are changed for every surface at once: the two apps, the console and
the website when it exists.

## Draft, live, history

Two brands exist at any moment.

- **The draft** is the `branding` section of the integrations row
  (`shared/integrations`, `BrandingConfig`) — what the page edits. A save
  lands there and nobody outside the console sees it.
- **The live brand** is the latest `BrandRelease` — a frozen copy of the
  draft made by **Publish**. `GET /app/branding` (app-config, public,
  5-minute cache) resolves it with DR 11 filling every field the release
  did not set, and that is what the console's `BrandProvider` and the
  phones' `readBrand` draw. Until the first release, DR 11 is live whatever
  the draft says.
- **The history** is append-only. **Restore** copies an old release's
  config onto the draft (every field — what that release did not set is
  cleared) and publishes it again as a new release, so the trail never
  loses what a phone once wore.

Legibility is checked on the draft (`brandChecks` in `shared/integrations/
branding.ts`): button labels on the primary, links on the page, body text
on the page, the white mark on the deep colour — WCAG's 3 : 1 and 4.5 : 1
bars as `ok` / `warn` / `fail`. Publish is never refused on a check; the
console shows them and asks, and the trail records which were flagged.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/branding` | ADMIN — `{ draft (every key, null = DR 11), draftBrand (resolved), live (resolved), release: { number, version, note, publishedAt, publishedBy, colours, wordmarkUrl, markUrl, live } \| null, dirty, checks[] }` |
| PUT | `/api/v1/branding/draft` | ADMIN + `settings.edit` — the strict patch: `platformName` ≤ 60, `tagline` ≤ 120, the four colours `#rrggbb`, the five logo URLs and the kit's three image URLs (absolute — what `POST /upload` purpose `BRANDING` answers), `taglines[]` (≤ 6 × 80); QR-12: `appIconUrl` (the 1024² launcher PNG for the next build), `consoleTitle` ≤ 40, `siteTitle` ≤ 70, `siteDescription` ≤ 160. Blank keeps; `null`, `''` or `[]` clears back to DR 11. Audited `BRAND_DRAFT_UPDATED` (the fields, before/after). Answers the manager view |
| POST | `/api/v1/branding/publish` `{ note? }` | ADMIN + `settings.edit` — the draft becomes release N+1; **409 `NOTHING_TO_PUBLISH`** when its resolved `version` equals the live one. Audited `BRAND_PUBLISHED` (number, note, `flaggedChecks`). 201 with the manager view |
| GET | `/api/v1/branding/releases?page&pageSize` | ADMIN — the history, newest first, each with the colours and the two logos to recognise it by and `live` on the current one |
| POST | `/api/v1/branding/releases/:number/restore` | ADMIN + `settings.edit` — release N's config onto the draft, published again as N+k; 404 on an unknown number. Audited `BRAND_RESTORED` (`restoredFrom`, `number`). 201 with the manager view |

## Owned Prisma entities

`BrandRelease` — `number` (unique, 1…), `config` (the `BrandingConfig`
snapshot), `version` (the resolved brand's hash), `note`, `publishedById`,
`publishedAt`.

## Files

- `branding.types.ts` — the release row, the summary, the manager view.
- `branding.schema.ts` — the draft patch, publish, the history query.
- `branding.service.ts` — `readManager`, `updateDraft`, `publishDraft`,
  `listReleases`, `restoreRelease`.
- `prisma-branding.repository.ts` behind `branding.repository.ts`.
- `features.ts` — `system.brand-manager` (CONSOLE).

## What reaches where

- Console: logos, name, tagline, the primary as `--primary` /
  `--primary-foreground` (`onPrimaryColor`), the moment a release is
  published.
- Phones: the logos and the tagline at the next launch; the colours at the
  launch after (they cache the brand and boot on it — `mobile/shared/theme/
  palette.ts`). Launcher icons and the OS splash are baked into the build.
- Website: `website: { taglines[], heroImageUrl, ogImageUrl, faviconUrl,
  title, description }` on the same read, DR 11's three lines and the tile
  by default.
- QR-12, per surface: `apps.iconUrl` (the launcher PNG the NEXT build
  bakes — null means DR 11's from `brand/generated`) and `console.title`
  (the tab title's suffix and the login heading; "ADX Admin" by default).
  The console page is laid out by surface — Shared identity, Apps, Admin
  panel, Website — each slot carrying the format, the size and the
  proportions it needs and where every surface draws it; a raster file of
  the wrong size is refused before it uploads (the rules live in the
  console's `settings/brand/image-size.ts`).
