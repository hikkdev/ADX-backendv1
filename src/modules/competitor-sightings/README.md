# competitor-sightings

VA-2 (23 Sep 2026 — the owner: "Our agents can also go around taking photos
of hoardings of our competitors and we can collect that for analysis and
training purposes"): the photographs our agents take of other people's
advertising, kept as a corpus with what the agent read at the kerb and, when
the desk asks, what the vision model read from the picture.

```
competitor-sightings/
  competitor-sightings.schema.ts        the formats, the file/list/export shapes (zod)
  competitor-sightings.repository.ts    the port — create, list (paged, faceted), listAll (export), recordAnalysis, brands
  prisma-competitor-sightings.repository.ts
  competitor-sightings.service.ts       logSighting, listSightings, getSighting, sightingBrands, analyseSighting, exportSightings
  competitor-sightings.controller.ts
  competitor-sightings.routes.ts        mounted at /api/v1/competitor-sightings
  features.ts                           `competitors.sightings`
```

## Routes

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/competitor-sightings` `{ photoFileId, brand?, category?, format?, note?, latitude?, longitude?, address?, city?, capturedAt? }` | AGENT_PUBLISHER, AGENT_ADVERTISER | an agent files what they photographed; **201** the row; audited `COMPETITOR_SIGHTING_LOGGED` |
| GET | `/competitor-sightings?q=&brand=&format=&agentId=&city=&from=&to=&analysed=&page=&pageSize=` | ADMIN | the desk's list on the list contract; `counts` = ALL / ANALYSED / UNANALYSED over the same filter without the `analysed` facet |
| GET | `/competitor-sightings/brands` | ADMIN | `[{ brand, count }]` — the brand facet, the model's reading counted when the agent left it blank |
| GET | `/competitor-sightings/export?format=csv\|jsonl&brand=&city=&from=&to=` | ADMIN | the corpus as a file (`Content-Disposition: attachment`) |
| GET | `/competitor-sightings/:id` | ADMIN | one sighting |
| POST | `/competitor-sightings/:id/analyse` | ADMIN | ask the vision model; the answer is kept on the row and the row comes back; audited `COMPETITOR_SIGHTING_ANALYSED` |

## What an agent files

The photo is taken with the shared ADX camera (`mobile/shared/components/camera`)
with the GPS stamp **on** — the field app's "Log a competitor hoarding" door
under the + disc opens the viewfinder with `gpsDefault` — and uploaded under
the purpose `COMPETITOR_CAPTURE` (private; folder `competitor-captures`;
`uploads` stamps and records the fix, GC-1). Then `POST /competitor-sightings`
names that file id and whatever the agent could read: the brand, the
category, the format (one of `SIGHTING_FORMATS` — HOARDING, WALL,
BUS_SHELTER, VEHICLE, DIGITAL_SCREEN, SHOP_FRONT, BANNER, OTHER) and a note.

`logSighting` refuses a file that is not the agent's own upload (**404**), and
fills what the body left out from the file's own stamp: `latitude`,
`longitude` and `capturedAt` come off the `UploadedFile` row GC-1 wrote when
the body has none, and `capturedAt` falls back to now. The agent's city key
(`cityId`) is copied from their profile so the desk can facet by city.

## What the desk does

`analyseSighting` reads the file through `uploads.readImageForModel`
(downscaled to 1,024 px, JPEG, with its perceptual hash), asks the configured
vision provider (`shared/ai` — `images` on the completion request; Anthropic,
OpenAI-shaped and Google shapes all take it) with `SIGHTING_ANALYSIS_SYSTEM`,
and holds the answer to `analysisSchema`: `brand`, `category`, `format`,
`estimatedSize`, `illuminated`, `condition` (NEW / GOOD / WORN / DAMAGED /
UNKNOWN), `text` (the legible copy, verbatim), `summary`, `confidence`. The
answer is stored on the row as `analysis` (with `provider`, `model` and the
`perceptualHash`) and `analysedAt`; the brand, category and format the agent
**left blank** are filled from it and the ones they typed are never
overwritten — what a person read off a hoarding beats a model's guess. No AI
provider configured is **503** `AI_UNAVAILABLE`; an answer the schema refuses
is **502** `AI_FAILED`; a file the image reader cannot decode is **409**
`FILE_UNREADABLE`.

`exportSightings` is the corpus: every row under the filter, as CSV (one line
per sighting: id, the agent, brand, category, format, note, the position and
address, the city, capturedAt, the model's reading, `photoUrl`) or as JSON
lines (the full view per line, one JSON object each — the shape a training
run reads). The photo itself is reached through its private `/files/:id` URL
with the desk's token; the export carries the URL, not the bytes.

## Owned Prisma entities

`CompetitorSighting` (agent, photo file, what the agent read, position,
`analysis Json?`, `analysedAt`).

## Dependencies

- `uploads` — `findUploadedFile` (whose file it is, and the GC-1 stamp),
  `readImageForModel`.
- `agents` — the agent profile behind the user (id and city).
- `shared/ai`, `shared/audit`, `shared/auth`, `shared/http`, `shared/errors`,
  `shared/pagination`, `shared/database` (repository only).

## Invariants

- A sighting is always an agent's own photo, and always a file uploaded under
  `COMPETITOR_CAPTURE`; the desk cannot file one.
- The agent's reading is never overwritten by the model's; blanks are filled,
  and both are on the row for whoever reads the corpus.
- The model is asked on demand and never in a job; nothing here decides
  anything.
- The training corpus is ADX's own photographs of public advertising. The
  advertisers' **creatives** are a different matter — see the campaigns
  README (VA-1) and the OPEN-TASKS consent decision.

## Tests

`__tests__/sightings.test.ts` — filing from the stamp, the ownership
refusal, the list facets, the analysis held to its schema and the blanks
filled without overwriting, the CSV and JSONL shapes, the export headers.
