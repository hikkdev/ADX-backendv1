# forms

FM-1 (27 Sep 2026): the form builder — Content › Forms — and its door.
The owner: forms get "their OWN builder (Content › Forms) built on the flow
field vocabulary but never writing into a platform record."

A **form** (`Form`) is its plumbing: a key a page's Form block names, a
title, where answers go (`destination` LEAD | SUPPORT | INBOX, with
`leadSide` for LEAD), who may answer (`audience` PUBLIC | SIGNED_IN) and who
is emailed (`notifyEmails`). Its **questions** are versions (`FormVersion`),
on the `layouts` rules: one draft at a time, numbers only up, publishing
retires the live one, a restore publishes a copy as the newest version. An
**answer** (`FormSubmission`) is stored whole, with the contact and place
fields lifted into columns, and never written into a publisher, listing,
advertiser or any other record.

## Definition (`form-schema.ts`)

`{ screens: [{ key, title?, description?, fields: [{ id, kind, label, hint?,
placeholder?, required?, options?, min?, max?, maxLength?, accept?,
dependsOn?: { fieldId, equals } }] }], submitLabel?, successMessage,
consentText, contactMap?: { name?, email?, phone? } }`

- 1–10 screens, ≤ 40 fields in all, ids unique, a `dependsOn` names an
  earlier field and a value it can answer (an option, or `"true"`/`"false"`
  for a tick box).
- Kinds: `text, textarea, email, phone, number, select, multiselect,
  checkbox, date, city, category, location, file`. `select`/`multiselect`
  take 1–50 options; `number`/`multiselect` take numeric bounds, `date` takes
  `YYYY-MM-DD` bounds, `text`/`textarea` a `maxLength`; `file` only on a
  SIGNED_IN form (uploads go through `POST /upload` with purpose
  `FORM_UPLOAD` — private; the answer is the file's URL).
- **Aadhaar is never a field**: an id or label matching
  `/aadha?ar|\buid\b|uidai/i` is refused with 400 `FORBIDDEN_FIELD` before
  anything else is checked.
- Every other problem is a 400 `VALIDATION_ERROR` with `details.issues[]`
  (`fieldId`, `path`, `message`), all at once. A draft may be saved with no
  fields; it may not be published with none.
- `GET /forms/field-kinds` → `[{ kind, label, takesOptions, takesRange, signedInOnly }]`.

## Answers (`form-answers.ts`, `submissions.service.ts`)

`POST /app/forms/:key/submissions { answers: { [fieldId]: value }, consent:
true, source?, captchaToken? }` → 201 `{ id, message }` (the version's
`successMessage`).

- The guard is the form's own (`submissionGate`): a PUBLIC form passes
  `formSubmitLimiter` (10 per 10 minutes per IP) and `verifyCaptcha` (a no-op
  with no `TURNSTILE_SECRET_KEY`); a SIGNED_IN form needs a token.
- Every answer is checked against the published definition: required, the
  kind's shape, options, ranges; a field whose condition is not met is
  dropped, an answer to a field the form lacks is dropped; a `city` id and a
  `location.cityId` must be in the catalogue. `consent` must be `true` and
  becomes `consentAt`.
- Lifted into columns: `contactMap`'s fields (else the first `email` and
  `phone` field answered), the first `location` (`latitude`, `longitude`,
  `address`, `cityId`) else the first `city`; `ipHash` is sha256 of the
  address; `userId` when signed in.
- Destination, best effort and never failing the submit: **LEAD** →
  `leads.inboundLead` (channel LINK, source `form:<key>`, the answers as
  "Label: value" lines for the message; needs a phone; an existing account's
  number is logged and makes no lead) → `leadId`; **SUPPORT** →
  `support.createTicket` (ISSUE, category OTHER, raised by the caller or the
  system user, file answers as attachments) → `ticketId`; **INBOX** →
  nothing more. Then each of `notifyEmails` gets "New answer: <title>"
  through `shared/email.sendEmail`, fire-and-forget, failures logged.

## Routes

| Method | Path | Guard | |
| --- | --- | --- | --- |
| GET | `/api/v1/app/forms/:key` | `publicReadLimiter` | `{ key, title, description, audience, version, definition }`; 404 unless published and not archived |
| POST | `/api/v1/app/forms/:key/submissions` | the form's own (above) | 201 `{ id, message }` |
| GET | `/api/v1/forms` | ADMIN `content.view` | `[{ id, key, title, destination, leadSide, audience, live, draft, submissionsNew, archivedAt, updatedAt }]` |
| GET | `/api/v1/forms/field-kinds` | ADMIN `content.view` | the kinds for the builder |
| POST | `/api/v1/forms` | ADMIN `content.edit` | `{ key, title, description?, destination?, leadSide?, audience?, notifyEmails? }` → the form + an empty draft v1 |
| GET | `/api/v1/forms/:key` | ADMIN `content.view` | the settings + `{ live, draft, versions }` |
| PATCH | `/api/v1/forms/:key` | ADMIN `content.edit` | the settings; PUBLIC is refused (409) while a version asks for a file |
| PUT | `/api/v1/forms/:key/draft` | ADMIN `content.edit` | `{ definition, changeNote? }` → the draft (created or replaced) |
| DELETE | `/api/v1/forms/:key/draft` | ADMIN `content.delete` | |
| POST | `/api/v1/forms/:key/publish` | ADMIN `content.approve` | `{ changeNote? }`; re-checked; the live one retires |
| GET | `/api/v1/forms/:key/versions` | ADMIN `content.view` | newest first |
| POST | `/api/v1/forms/:key/versions/:number/restore` | ADMIN `content.approve` | publishes a copy as the newest version |
| POST | `/api/v1/forms/:key/archive` | ADMIN `content.delete` | the door closes; history and answers stay |
| POST | `/api/v1/forms/:key/restore-form` | ADMIN `content.edit` | back from the archive |
| GET | `/api/v1/forms/:key/submissions?status&from&to&cityId&page&pageSize` | ADMIN `content.view` | `{ items, total, page, pageSize, fields }` — `fields` from the live (else draft) definition |
| GET | `/api/v1/forms/:key/submissions.csv` (same filter) | ADMIN `content.view` | one column per field id across every version |
| GET | `/api/v1/forms/:key/submissions/map?bbox=w,s,e,n` | ADMIN `content.view` | `[{ id, latitude, longitude, contactName, createdAt }]`, ≤ 2000 |
| PATCH | `/api/v1/forms/:key/submissions/:id` | ADMIN `content.edit` | `{ status: NEW \| READ \| ARCHIVED }` |

Every write is audited: `FORM_CREATED`, `FORM_UPDATED`, `FORM_DRAFTED`,
`FORM_DRAFT_DISCARDED`, `FORM_PUBLISHED`, `FORM_RESTORED`, `FORM_ARCHIVED`,
`FORM_UNARCHIVED`, `FORM_SUBMISSION_STATUS`.

## The Form block

`layouts` resolves a page's `form { formKey }` block through a port
(`registerFormResolver` in `layouts/resolve.service.ts`) that this module
fills at load with `publishedFormView` — `{ key, title, description,
audience, version, definition }` or `null` — so `layouts` never imports
`forms`. Feature: `content.forms`.

## Starter forms (`npm run seed:starter-forms`)

FM-2 (28 Sep 2026): `src/scripts/data/starter-forms.ts` holds four forms —
`contact-adx` (SUPPORT), `advertise-with-us` and `promote-your-event` (LEAD,
ADVERTISER), `list-your-space` (LEAD, PUBLISHER) — and where each sits on the
website (`WEB_HELP`, `WEB_ADVERTISE`, `WEB_PUBLISHERS`). The script writes
them through this module's `createForm` + `saveDraft` and the layout desk's
`saveDraft`, as DRAFTS only; nothing is published. A form whose key exists and
a page that already has a draft are left alone; a page is drafted from its
live version (blocks and SEO) or its defaults. `-- --check` says what it would
write and writes nothing.
