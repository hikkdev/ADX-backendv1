# legal

The read documents — DR 07 wave 4 (11 September 2026). The ten policies AG-66 to AG-74
draw (privacy, terms, refund, content, community guidelines, commission structure, code of
conduct, legal disclaimer, contact info, about) plus the three the same screens need: FAQs,
Safety guidelines, Open source licenses.

## What it owns

`LegalDocument` and `LegalDocumentKind`. Versioned the way `AgreementTemplate` is: a
version is a draft until activated, only a draft's text may change, activation retires the
live version, numbers only go up. Read, not accepted — which is why these are not
`AgreementKind` values (every one of those has acceptance rows behind it).

## Routes

```
GET    /legal                          public — every kind with a live version (no bodies)
GET    /legal/:kind                    public — the live version with its body and meta
GET    /legal/documents?kind=          ADMIN — every version
POST   /legal/documents                ADMIN — a new draft (or live, with activate: true)
GET    /legal/documents/:id            ADMIN
PATCH  /legal/documents/:id            ADMIN — a draft's text
DELETE /legal/documents/:id            ADMIN — a draft
POST   /legal/documents/:id/activate   ADMIN — make it live; the rollback too
```

## Invariants

- **The public reads carry no token.** A force-update gate or a sign-in screen that needs a
  session to show the terms is useless.
- **Contact info and FAQs are structured.** `meta` carries the office, lines, email and
  registration block the Contact frames draw, and `meta.items` the FAQ accordion's
  questions, answers and tags. The markdown `body` is the long form.
- **Content is not ours to write (decision 7).** On the first read of an empty table every
  kind is seeded with one clearly-marked placeholder version, active, so the screens have a
  document and nothing is invented. `meta.placeholder: true` marks the structured ones. ADX
  Legal supplies the final text through the console's `/legal` editor.
- Every create and activation is logged.

## Tests

`__tests__/legal.service.test.ts`.
