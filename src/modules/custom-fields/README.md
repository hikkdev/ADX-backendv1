# custom-fields

CF-1 (27 Sep 2026): extra questions on a record type — a publisher, an
advertiser, a listing or a lead — kept beside the record and never in its
columns, so nothing the platform relies on can break.

A **definition** (`CustomFieldDef`, unique per `entity` + `key`) says what is
asked: `label`, `kind`, `options` (for a choice), `hint`, `required`, where
it is shown (`showOnDesk`, `showInApps`, `showOnWebsite`), whether the
record's owner may answer it (`editableByOwner`) and its `sortOrder`. The
key is made from the label when left out (`Preferred contact time` →
`preferred_contact_time`) and never changes; neither does the kind — the
stored values depend on both. A **value** (`CustomFieldValue`, unique per
`defId` + `entityId`) is one record's answer, as JSON.

Kinds: `text, textarea, number, select, multiselect, checkbox, date, email,
phone, url, location` (`{ latitude, longitude, address?, cityId? }`).
`field-values.ts` checks a value against its definition, pure; `null`
clears one.

## Routes

| Method | Path | Guard | |
| --- | --- | --- | --- |
| GET | `/api/v1/custom-fields?entity=&includeArchived=` | ADMIN `settings.view` | the definitions, live ones unless asked for all |
| POST | `/api/v1/custom-fields` | ADMIN `settings.edit` | `{ entity, key?, label, kind, options?, hint?, required?, showOnDesk?, showInApps?, showOnWebsite?, editableByOwner?, sortOrder? }`; 409 on a repeated key |
| PATCH | `/api/v1/custom-fields/:id` | ADMIN `settings.edit` | everything but the entity, key and kind |
| POST | `/api/v1/custom-fields/:id/archive` | ADMIN `settings.edit` | the question stops being asked; its answers stay |
| POST | `/api/v1/custom-fields/:id/restore` | ADMIN `settings.edit` | asked again |
| GET | `/api/v1/custom-fields/values/:entity/:entityId` | ADMIN, the record's group `.view` | `{ entity, entityId, values: { [key]: value }, fields: [def + value] }`; 404 when the record does not exist |
| PUT | `/api/v1/custom-fields/values/:entity/:entityId` | ADMIN, the record's group `.edit` | `{ values: { [key]: value } }` — keys named are written, `null` clears, keys left out stay |
| GET | `/api/v1/app/custom-fields/:entity` | any session | the definitions shown to owners (`showInApps` or `showOnWebsite`); a lead has none (403) |
| GET | `/api/v1/app/custom-fields/values/:entity/:entityId` | any session, own record | the same view, the owner's fields only |
| PUT | `/api/v1/app/custom-fields/values/:entity/:entityId` | any session, own record | only `editableByOwner` fields; anything else is an issue |

**The record's group**: a publisher and its listings are `supply`, an
advertiser is `demand`, a lead is `marketplace` — chosen per request from
`:entity` (`requireEntityPermission`), an unknown entity a 404 first.

**Own record**: PUBLISHER = the caller's publisher, LISTING = a listing of
the caller's publisher (`Listing.publisherId`), ADVERTISER = the caller's
advertiser; LEAD never (`assertOwner`, 403 otherwise).

A write is refused whole (400 `VALIDATION_ERROR`, `details.issues[]` with
`key` and `message`, every problem at once) for a key the entity does not
have, a value that fails its kind, a required field cleared, or — for the
owner — a field that is not theirs to change.

Every write is audited: `CUSTOM_FIELD_CREATED`, `CUSTOM_FIELD_UPDATED`,
`CUSTOM_FIELD_ARCHIVED`, `CUSTOM_FIELD_RESTORED`, `CUSTOM_FIELD_VALUES_SET`
(the record as the target, the keys in the metadata). Feature:
`settings.custom-fields`.
