# ai

Drafting a listing description, and translating the marketplace on the read path.

## The provider is not this module's business

`shared/ai` holds the vendor abstraction — one `complete()` over Anthropic,
OpenAI, Google, Azure OpenAI and a `custom` slot that speaks the OpenAI
chat-completions shape against any base URL. It lives in `shared` rather than
here because translation is applied by the listing read path, and shared
infrastructure may not import a business module.

Which vendor, which model, which key, and both quota numbers are one section of
the `integrations` config — so switching providers is a form change on
`/settings/integrations`, not a deployment. The `custom` slot is the answer to
"room for our own later": it needs a URL and a key, not an adapter.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/api/v1/ai/listing-description` | `authenticate` + PUBLISHER or AGENT_PUBLISHER |
| GET | `/api/v1/ai/listing-description/quota` | same |

ADMIN is deliberately absent: nobody at ADX writes a publisher's words for them.
An agent sitting beside a publisher works on that publisher's account through
the delegated-access grant, which is why the agent role is here.

## Owned Prisma entities

- `AiGeneration` — one row per draft. A row rather than a counter, so "how many
  has this publisher had" and "what did the model actually say" are the same
  question.
- `Translation` — cached by the SHA-256 of the source text and the target
  language, so one sentence written across forty listings is paid for once.

## The two rules

**Blank field only.** A generation into a field that already holds text is
refused with `FIELD_NOT_EMPTY` (409). This is the one way the feature can
destroy work, and an undo in the client is not a defence — the request is
already paid for and the words are already gone. Clearing the field is the
deliberate act that says the old wording is finished with.

**Three free, ten paid.** Per description, not per publisher and not per month.
The bucket is the listing once one exists, and the wizard's own draft key before
that — a description is regenerated while it is still being written. The
publisher id is always part of the bucket key, because a draft key comes from
the client and without the owner in the key one publisher could spend another's
allowance by guessing one.

Both numbers are configurable. `PublisherSubscription` decides which applies: a
subscription that has started and not ended is "paid".

**The advertiser's landing page (E7-2, Lot E addendum 2).** `AiGeneration`
now takes either owner — `publisherId` is nullable, `advertiserId` exists,
and the kind `LANDING_PAGE` is real — so a campaign's page draft is a row
here like a description draft, under the same two numbers: the bucket is
the campaign (`subjectKey` = campaign id) and "paid" is a `PackageSale`
ACTIVE for the advertiser. `campaigns.generateLandingPage` calls
`assertLandingPageQuota` before the model and `recordLandingPageGeneration`
after it answers (429 `QUOTA_EXHAUSTED` when spent); the row is recorded
only after the model answers, as for descriptions.

## Invariants

- A draft is recorded only after the model answers, so a vendor outage does not
  spend one.
- `AI_UNAVAILABLE` (503) and `AI_FAILED` (502) are separate codes. The first is
  an operator's settings problem, the second is somebody else's outage;
  reporting both as a failed generation makes the first look like a bug.
- Translation failure is never an error. The marketplace renders the original
  text — a description in the wrong language beats a page that will not load.
- The prompt is never logged. A listing description is a publisher's own words
  about their own property.
