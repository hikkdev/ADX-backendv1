# site-pages

PB-1 (27 Sep 2026): the site's pages, their addresses, and where the old
addresses go. The owner: "edit the layout of existing and create whole new
pages, also assign proper URLs to the new pages and edit existing URLs as
well" — and "Only admins can change the addresses."

Two kinds of **page** (`SitePage`, keyed by a stable `key`):

- **SYSTEM** — the nine the website draws itself (`home /`, `explore
  /spaces`, `listing /spaces/:id`, `categories`, `formats`, `how-it-works`,
  `advertise`, `publishers`, `help`), seeded by migration. Each is drawn by a
  Next route (`internalPath`) and laid out under a layout surface; this
  module owns only its title and its public address (`path`). The home's
  address is locked.
- **CUSTOM** — Studio's, built from content blocks and versioned by
  `layouts` under `{ pageId }`; drawn by the website at `/pg/<key>` behind
  its address and by the apps on the Page screen, on the channels it names
  (`WEBSITE`, `APPS`). Live once something is published; archived, it leaves
  the site but keeps its address and its history.

An **address** follows `paths.ts` (pure, tested): `/segment/segment` of
lowercase letters, digits and single hyphens, ≤ 5 segments, ≤ 120 characters,
no trailing slash, no dot, no query; only the home lives at `/`; a first
segment the site or the API owns is refused; a `:param` only where a SYSTEM
page's own route has one, in the same place, and a SYSTEM page keeps its
parameter count. Pages and redirect sources share one namespace.

A change of address writes `SiteRedirect { fromPath: old, toPath: new,
reason: ADDRESS_CHANGE, pageId }`, re-points every redirect whose `toPath`
was the old address (no chains), and — when the page moves back onto one of
its own old addresses — drops that redirect instead of refusing. A
**redirect** written by hand (`reason: MANUAL`) goes from a custom-shaped
address to a site path (a query allowed) or an https URL; `permanent`
chooses 308 over 307.

## Routes

Public (`publicReadLimiter`, in-process cache 60 s under `layouts`' cache,
forgotten on every write here and on every publish there):

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v1/app/site/routes` | `{ version, pages: [{ key, kind, title, path, internalPath, channels }], redirects: [{ fromPath, toPath, permanent }] }` — live, unarchived pages (a CUSTOM page once published); `version` is a hash of the table |
| GET | `/api/v1/app/site/sitemap` | `[{ path, updatedAt }]` — WEBSITE pages that are live, without a `:param`, and not `meta.noindex` |
| GET | `/api/v1/app/pages/:key?side=&city=&cityId=&stage=&preview=` | `authenticateOptional`; `{ key, title, path, channels, version, isDefault, meta, blocks }` resolved exactly as `layouts` resolves a surface; 404 when archived or nothing published (a SYSTEM page answers its surface's live version or its defaults); a valid preview token for this page answers the draft, falling back to live, with `preview: true` and `Cache-Control: no-store` |

The desk (`authenticate` + `requireRole('ADMIN')`):

| Method | Path | Permission | |
| --- | --- | --- | --- |
| GET | `/api/v1/site/pages` | `content.view` | every page: `live {number, publishedAt}`, `draft {number, updatedAt}`, `redirectCount` … |
| POST | `/api/v1/site/pages` | `content.edit` | `{ key, title, path, channels?, template?: blank\|event\|landing }` → a CUSTOM page + draft v1 from `templates.ts` (201) |
| POST | `/api/v1/site/pages/from-content/:slug` | `content.edit` + `content.approve` | PB-6: a WEBSITE content page → a CUSTOM page `key = slug`, `path = /<slug>`, one `rich_text { contentSlug }` block, its SEO title and description, published at once (201) |
| GET | `/api/v1/site/pages/:key` | `content.view` | the page + `{ live, draft, versions[], defaults }` in `layouts`' `LayoutVersionView` shape (with `meta`) |
| PATCH | `/api/v1/site/pages/:key` | `content.edit`; **`content.addresses` for `path`** | `{ title?, channels?, path? }` — 403 `FORBIDDEN` "Only an admin with content.addresses may change an address" without it; 409 when `addressLocked`; a SYSTEM page stays a website page |
| POST | `/api/v1/site/pages/:key/archive` | `content.delete` | CUSTOM only |
| POST | `/api/v1/site/pages/:key/restore-page` | `content.edit` | back on the site |
| PUT | `/api/v1/site/pages/:key/draft` | `content.edit` | `{ blocks, meta?, changeNote? }` — `validateBlocks('CUSTOM', …)` for a custom page, the surface's rules for a system one |
| DELETE | `/api/v1/site/pages/:key/draft` | `content.delete` | |
| GET | `/api/v1/site/pages/:key/preview?version=draft\|<n>&side=…` | `content.view` | the public shape for that version |
| POST | `/api/v1/site/pages/:key/preview-token` | `content.view` | `{ token, expiresAt }` (24 h) |
| POST | `/api/v1/site/pages/:key/publish` | `content.approve` | `{ changeNote? }` |
| GET | `/api/v1/site/pages/:key/versions` | `content.view` | newest first |
| POST | `/api/v1/site/pages/:key/versions/:number/restore` | `content.approve` | publishes a copy as the newest version |
| GET | `/api/v1/site/redirects` | `content.view` | `[{ id, fromPath, toPath, permanent, reason, page: {key,title}\|null, createdAt }]` |
| POST | `/api/v1/site/redirects` | `content.addresses` | `{ fromPath, toPath, permanent? }` (201); linked to the page it lands on |
| DELETE | `/api/v1/site/redirects/:id` | `content.addresses` | |

The version routes call `layouts`' desk with the page's key — a SYSTEM page
under `{ surface }`, a CUSTOM page under `{ pageId }` — so one draft at a
time, numbers only up, publish retires, restore publishes a copy, all hold
here too. A bad `:key` is a 404, not a 400.

Every write is audited under module `site-pages`: `SITE_PAGE_CREATED`,
`SITE_PAGE_UPDATED` (with a diff), `SITE_PAGE_ADDRESS_CHANGED` (the old and
new address, how many redirects were re-pointed), `SITE_PAGE_ARCHIVED`,
`SITE_PAGE_RESTORED`, `SITE_REDIRECT_CREATED`, `SITE_REDIRECT_DELETED` — and
the layout ones for versions. Errors: 400 `VALIDATION_ERROR` with
`details.field` for an address or redirect that breaks a rule (the message
names the rule), 409 `CONFLICT` for a taken key or address, the home's
address, a system page archived, an archived page edited.

## Feature

`content.site-pages` (routes `/api/v1/site`, `/api/v1/app/site`,
`/api/v1/app/pages`; surfaces WEBSITE, APP_USER, APP_AGENT, CONSOLE). The
contract named `content.pages`, but that key is `content`'s (CT-1) and a
feature is declared once.

`LayoutVersion` belongs to `layouts`, `ContentPage` to `content`; this
module reads the current version rows through its own repository and the
published text through `content`'s index, and calls `layouts` for
everything to do with versions and resolution — never the other way round.
