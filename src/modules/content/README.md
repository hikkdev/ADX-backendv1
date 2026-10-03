# content

CT-1 (24 September 2026) — the pages ADX writes itself. The owner asked for
"some sort of CMS to manage the legal pages and other pages where it is
required"; the legal pages already had one, and this is the other half.

## What it owns

`ContentPage` and `ContentPageCategory`. Where `legal` holds thirteen fixed
kinds — each one a legal deliverable with its own slot — this holds
everything else a page can be: a help article, a guide, a policy outside
those thirteen, a page the website needs. A page is addressed by its
**slug** rather than by a kind, so ops add one without a deploy, which is
the whole point of it.

## Routes

```
GET    /content?surface=&category=&tag=   public — every published page, no bodies
GET    /content/:slug                     public — the live version with its body
GET    /content/pages?slug=               ADMIN  — every version
POST   /content/pages                     ADMIN  — a new version (or live, with publish: true)
GET    /content/pages/:id                 ADMIN
PATCH  /content/pages/:id                 ADMIN  — a draft's text
DELETE /content/pages/:id                 ADMIN  — a draft
POST   /content/pages/:id/publish         ADMIN  — make it live; the rollback too
POST   /content/pages/:id/unpublish       ADMIN  — take the page down
```

## Versioning

The rules are the legal module's, because they were right there: a version
is a draft until it is published, only a draft's text may change, publishing
retires whatever was live, and numbers only go up. Publishing an older
version is how a page is rolled back — the service does not care which
number it is.

A **version** is `DRAFT`, `PUBLISHED` or `RETIRED`. There is deliberately no
fourth state: a retired row cannot know whether a newer version replaced it
or the whole page was taken down, so whether the page is live is read from
its versions together (`pageLive`), not guessed from one row.

## Invariants

- **The public reads carry no token.** The website is read by people who
  have never signed in, and a help article behind a session is not help.
- **The slug is the address and never moves.** It is held to
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`; a title typed into the field is slugified
  rather than refused. `pages` and `index` are reserved, because
  `/content/pages` is the desk's own prefix — the router mounts it above
  `/:slug` as well, so neither shadows the other.
- **A page must name a surface before it can be published.** WEBSITE,
  APP_USER, APP_AGENT, CONSOLE. A page on no surface reaches nobody, and
  publishing one is almost always a mistake mid-edit.
- **A version that was ever live is kept.** Only a draft may be edited or
  discarded; to remove a live page, take it down. The slug then 404s until
  something is published there again.
- Every draft, edit, publish, take-down and discard is audited
  (`CONTENT_PAGE_DRAFTED` / `_EDITED` / `_PUBLISHED` / `_TAKEN_DOWN` /
  `_DISCARDED`).
- **No placeholders.** `legal` seeds one per kind because the apps must
  always have a policy to show; a page nobody has written should simply not
  exist, and its slug should 404.

## Where it is read

- **The console:** Content, beside Legal documents — the pages down the left
  grouped by kind, the chosen page's live version and its history on the
  right, the same shape as the legal screen.
- **The website:** `website/build-pages.mjs` is the press. The site is
  static, and should stay static — a policy page that needs an API call to
  render is a policy page that is blank when the API is down. So the script
  reads the live text over HTTP, renders the Markdown into the site's own
  layout, and writes the files: publish in the console, run it, push. Every
  file it writes carries a marker comment, and a file without that marker is
  somebody's hand-written page and is never overwritten. Tests:
  `node --test website/*.test.mjs`.
- **The apps** can read `/content?surface=APP_USER` the same way they read
  `/legal` today; nothing in them calls it yet.

## Dependencies

`shared/audit`, `shared/auth`, `shared/errors`, `shared/http`,
`shared/database` (repository only). No other business module.

## Tests

`__tests__/ct1-content.test.ts`.
