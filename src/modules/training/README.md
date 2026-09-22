# training

The flat library two apps read (`GET /training`, unchanged) and, since
DR 05, the curriculum beside it: ordered modules with a lesson, a transcript
and takeaways; questions whose correctness never crosses the wire; per-agent
progress; attempts; and the ADX-CERT certificate.

Moved out of `agents/milestones`, which used to answer the library routes.
`TrainingResource` is untouched — the agent app and the publisher pane both
read it, guarded by a session and no role, and neither had to change.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /training` | any session | The library. **Unchanged.** |
| `POST /training` | ADMIN | A library resource. **Unchanged.** |
| `GET /training/curriculum` | any session | The index: modules with this agent's state, the resume card, the certification. |
| `GET /training/modules/:id` | any session | Lesson body, transcript, takeaways, resume position, the next module. Opening a module is its first progress. 409 while locked. |
| `POST /training/modules/:id/progress` | any session | `{ percent (0–99), positionSec? }`. Only climbs. |
| `GET /training/modules/:id/quiz` | any session | Questions and options. No `isCorrect`. |
| `POST /training/modules/:id/quiz` | any session | `{ answers }` → score, the line, the module, the next one, the certification. **201.** |
| `GET /training/certification` | any session | The certificate, or what is left. |
| `GET /training/modules` | ADMIN | Every module with its question count, active or not. |
| `POST /training/modules` | ADMIN | A module. **Inactive by default.** |
| `GET /training/modules/:id/admin` | ADMIN | The module with its questions, correctness included. |
| `PATCH /training/modules/:id` | ADMIN | Any subset. A module can only wait on one before it. |
| `PUT /training/modules/:id/questions` | ADMIN | The whole set; exactly one correct option per question. |
| `GET /training/certifications` | ADMIN | Everyone certified, with revocations. |
| `POST /training/certifications/:id/revoke` | ADMIN | `{ reason }`; logged. T-B: answers the list's row — `agentDisplayId`, `agentName` beside the revoked certificate (the same include on the write). |

## AG-4 (20 Sep 2026): a curriculum per side, and the assessment

`TrainingModule.audience` (ALL, PUBLISHER_AGENT, ADVERTISER_AGENT) and
`kind` (LESSON, ASSESSMENT), with `timeLimitMins` for an assessment's
clock. An agent's curriculum is the active modules for the sides they hold
(`repository.agentSides`); the certificate counts the lessons alone, and
only a lesson pass mints it. An assessment is the sales applicant's
screening test — scored on the same quiz door, the best attempt kept, never
certified; `getAssessmentStanding(agentId)` (on the agents port) says
whether one is published for the side and whether it is passed. The quiz
view carries `kind` and `timeLimitMins`; the app counts down and submits
what is answered at zero.

## Invariants

- **Decision 12 — the curriculum is the exam.** There is no separate exam:
  every module has a quiz, attempts are unlimited, the best one counts, a
  failed quiz locks nothing, and the certificate is minted the moment the
  last active module is passed. "Certification progress 4 of 8" is passed
  modules over active modules. The index's "Certification exam" row is the
  certification itself — locked until the last pass.
- **Decision 13 — there is no PDF.** Nothing in the platform renders one. The
  certificate is a record with an identifier the apps share as text and the
  console prints; the Download PDF button is not drawn.
- **`ADX-CERT-1109-2601`, not `ADX-CERT-2214`.** The frame's four digits are a
  placeholder; the id is minted through `identifiers` (`CERTIFICATE`, prefix
  `ADX-CERT`) so it is issued once, never derived, and dated by its own shape
  like every other number ADX prints.
- **Four row states, from three facts.** `COMPLETED` (a passed quiz, and never
  locked afterwards), `LOCKED` (`unlockAfterOrdinal` not yet passed),
  `IN_PROGRESS` (opened), `NOT_STARTED`. The first module is always open.
- **Progress only climbs, and stops at 99.** `nextPercent` refuses to go
  backwards and refuses 100; only a passed quiz completes a module. The app
  reports the steps it can honestly claim — opened (10), video opened (40),
  lesson read (70) — because there is no in-app video player, so a scrub bar
  and a resume second would be fiction (A6). `lastPositionSec` is stored for
  the day one exists.
- **Correctness never crosses the wire to an agent.** `getQuiz` strips
  `isCorrect`; the quiz frame shows no feedback on purpose. The desk's read
  (`/admin`) is the only one that carries it.
- **A stale quiz is not an error.** An answer to a question that is no longer
  on the quiz scores nothing rather than throwing.
- **A module created through the API is inactive** until switched on, so it
  does not appear on every agent's index before it has questions.

## Probing

Every query in `prisma-training.repository.ts` was run against Neon with
`probe_` modules: the index with the four states, opening a module, a failed
attempt, a passed one completing the module and unlocking the next, and the
last pass minting `ADX-CERT-…` through the identifier counter.
