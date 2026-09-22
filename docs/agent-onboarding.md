# Agent onboarding

How a person becomes an ADX field agent, and what the platform holds about
them once they are one. Built in lots from 20 September 2026 (AG-1 is the
record and the doors; the app screens, the desk workbench, the screening and
the routing follow). The brief behind it: publisher agents come from
delivery-rider networks and apply the way a Zomato or Rapido partner does;
advertiser agents are sales executives and apply the way a Justdial or
IndiaMART hire does; both are engaged "like employees, temporary style"; a
desk-set grade beside the earned tier sends the important accounts to the
stronger agents.

## Two kinds, one ladder

| | Publisher agent | Advertiser agent |
|---|---|---|
| Role | `AGENT_PUBLISHER` | `AGENT_ADVERTISER` |
| Profile | delivery-partner: vehicle, zones, platform experience (Zomato, Swiggy, Rapido, …) | sales executive: education (12th pass at least), sales years, industries, work history, references |
| Age | 18+ | 21+ |
| Papers | Aadhaar (both sides), PAN, live selfie, address proof, bank proof; licence (both sides), registration and insurance when they ride a motor vehicle; police certificate optional | Aadhaar, PAN, selfie, address proof, bank proof, education certificate, résumé; employer proof, licence, police certificate optional |
| Screening | automatic checks and the desk's paper review; no interview | automatic eligibility, a timed assessment, a desk-scheduled interview, reference calls (Lot 4) |
| Engagement on activation | GIG, open-ended | CONTRACT, six months with three months' probation, unless the desk sets otherwise |
| Starting grade | G1, G2 with strong platform experience | G2, G3 or G4 by experience and interview |

The ladder on `AgentProfile.stage`:

```
APPLIED → PROFILE → DOCUMENTS → BANK → AGREEMENT → (SCREENING → TRAINING) → UNDER_REVIEW → ACTIVE
                                                                             ↘ ON_HOLD ↔
   any of these ─────────────────────────────────────────────────────────→ REJECTED / WITHDRAWN
ACTIVE / ON_HOLD ────────────────────────────────────────────────────────→ EXITED
```

An unsubmitted application's stage is recomputed on every write from what
is done, so the app opens on the next step. SCREENING and TRAINING are shown
on the ladder and become gates in Lot 4. Every agent that existed before the
ladder is ACTIVE.

## What is collected

**Everyone:** full name, date of birth, gender (on the user), city and state,
languages, current address (with a map pin) and permanent address, an
emergency contact, how they came to ADX (`sourceKind`: SELF, FLEET,
REFERRAL, WALK_IN, JOB_PORTAL, DESK, IMPORT) and the referring agent when a
referral code was used.

**Publisher side:** vehicle type and number; rows of platform experience
(platform, partner id, years, active, a note on their rating).

**Advertiser side:** highest education with rows per qualification (degree,
institution, year); sales years, industries, notice period; rows of
employment (employer, role, dates, reason for leaving); references (name,
relation, phone, and the desk's check).

**Papers:** one row per kind in `AgentDocument`, with the number masked
(Aadhaar keeps its last four, a PAN its first five and last one) and hashed
so the same paper on two accounts is refused, an expiry where the kind has
one (licence, insurance, registration, police certificate), and its own
decision: SUBMITTED, APPROVED, FLAGGED, REUPLOAD_REQUESTED. A re-upload
restarts the review.

**Bank:** a payout method through the existing `POST /payouts/methods` (bank
or UPI). The ladder asks only that one is on file; the desk verifies it, and
the penny drop joins when Cashfree's verification suite is reachable.

**Agreement:** the side's engagement terms, `AGENT_PUBLISHER_PLATFORM` or
`AGENT_ADVERTISER_PLATFORM`, accepted in the app with the click's IP and
user agent through the agreements module. The kinds are seeded as drafts at
boot; ops publish a version at Settings › Agreements before the ladder can
be completed (503 `NO_ACTIVE_TEMPLATE` until then).

## The desk

The queue (`GET /agents/applications?stage|group&side&q`) lists every profile
by stage with per-stage counts, the side, the source and how many papers are
filed or flagged; `group` names a chip — IN_PROGRESS (the applicant's four
steps), WITH_DESK (under review, screening, training), CLOSED. The record
(`GET /agents/:id/application`) is the same view the applicant sees plus the
identity verdict and the applicant's `userId` (the owner named on a paper the
desk uploads for them).

AG-3: the desk runs the same ladder for someone standing in front of it.
`POST /agents { asApplication: true }` (the Add-agent dialog's default) starts
them at PROFILE with `sourceKind: DESK`; `PATCH /agents/:id/application/profile`
writes the details for them — the person's own name, date of birth and gender
included, which the app writes through `/users/me`; `PUT …/documents/:kind`
files a paper (marked DESK; the console uploads it under purpose KYC in the
applicant's name); `POST …/application/agreement` records the terms shown on
paper as accepted at the desk, in the admin's name and with the version shown;
`POST …/application/submit` submits for them, refused with what is missing
exactly as the app is. A hold placed before submission resumes onto the real
rung, not PROFILE. Then the desk's own steps — decide each paper, and decide
the application:

- **ACTIVATE** needs every required paper filed and none flagged, and the
  identity verified: the KYC set VERIFIED, every identity paper APPROVED, or
  `identityCheckedInPerson` (the desk saw the originals; the SUBMITTED
  identity papers are approved "seen in person"). It sets the grade (required),
  the engagement (type, start, end, probation; the side's defaults otherwise),
  the reporting manager (a staff record), weekly hours, territory and zone.
- **REJECT** and **HOLD** need a note, which reaches the applicant.
- **RESUME** puts a held application back under review.
- **Exit** (`POST /agents/:id/exit`) ends the engagement with a reason,
  whether the door stays open (`rehireEligible`) and a blacklist flag.

Notifications: `AGENT_APPLICATION_RECEIVED` to the applicant and in-app to
every admin on submit; `AGENT_DOCUMENT_RETURNED` when a paper is flagged;
`AGENT_APPLICATION_DECISION` on every decision.

## Screening (AG-4)

Screening is judged by side, in `screeningOf` (pure, `application.rules.ts`):

- A **field agent** is screened on paper: the identity verified (the KYC
  set, every identity paper approved, or the desk vouching in person) and
  every other required paper approved — a rider's licence, RC and
  insurance. Or the desk's tick.
- A **sales agent** sits the **assessment** — a training module of kind
  ASSESSMENT for `ADVERTISER_AGENT`, timed (`timeLimitMins`; the app submits
  what is answered at zero), scored on the quiz engine, never certified —
  and an **interview** the desk books (`POST /agents/:id/application/interviews`,
  round 1 or 2, in person / phone / video, an interviewer from the staff;
  the applicant is told the slot) and decides (`PATCH …/interviews/:id`:
  PASSED / FAILED with marks out of five, NO_SHOW, CANCELLED). A G3 or G4
  activation wants a passed second round. Or the desk's tick.
- The **tick** (`POST /agents/:id/application/screen { note }`, `{ clear:
  true }` takes it back) stands for all of it when the desk judged by hand.

The ladder's SCREENING step says who owes the next move: `ACTION_NEEDED`
when the assessment is the applicant's, `WAITING` when the desk owes the
paper check or the interview. A submitted application settles onto
SCREENING, then TRAINING, then UNDER_REVIEW as the screen and the
certificate come in (`stageForSubmitted`; a curriculum not yet published for
the side does not hold it at TRAINING).

**Gates at activation** (`activationGaps`): the screen done (409
`SCREENING_INCOMPLETE`) and the side's curriculum certified (409
`TRAINING_INCOMPLETE`, only when a lesson is published for the side). The
desk may waive either with `waiveScreening` / `waiveTraining` and a reason
in the note; the waiver is logged on the decision.

**Training per side:** `TrainingModule.audience` (ALL, PUBLISHER_AGENT,
ADVERTISER_AGENT) and `kind` (LESSON, ASSESSMENT). An agent's curriculum is
the modules for the sides they hold; the certificate counts the lessons
alone, and only a lesson pass mints it.

## Papers that run out (AG-4)

A driving licence, an insurance, a police certificate, a passport, an RC —
`EXPIRING_KINDS`. The sweep (`agent-document-expiry` job, every six hours;
`POST /agents/applications/expiry-sweep` by hand) reminds the agent thirty
and seven days out (`AGENT_DOCUMENT_EXPIRING`, once per window) and on the
day marks the paper EXPIRED (`AGENT_DOCUMENT_EXPIRED`): an applicant's
ladder shows it as theirs to renew; a working agent is put ON_HOLD with the
reason, `heldFromStage: ACTIVE`. A renewed paper filed over it and approved
lets them back to ACTIVE by itself (`resumeIfRenewed`), and a hold the desk
places on a working agent resumes to ACTIVE too — the hold remembers where
it came from.

## Verification seams (AG-4)

`shared/integrations/cashfree-verification.ts` speaks Cashfree's
Verification Suite — the client pair from `CASHFREE_VERIFICATION_CLIENT_ID`
/ `_SECRET`, falling back to the payouts pair; sandbox in test mode. Every
answer is `ok: true` with the facts and the raw payload, or `ok: false` with
UNCONFIGURED / REFUSED (an unwhitelisted IP, an unknown number) /
UNAVAILABLE — never a throw. Cashfree must whitelist the server's IP first
(submitted 20 Sep 2026); until then every check is a 409
`VERIFICATION_UNAVAILABLE` the desk reads and answers by hand.

- **Vehicle RC** (`GET /verification/vehicle-rc`): the desk checks an
  agent's VEHICLE_RC (`POST /agents/:id/application/documents/VEHICLE_RC/verify`
  — the owner-name match against the applicant, stamped on the paper as
  `verifiedVia: CASHFREE_VRS` with the payload) and a vehicle put up as a
  listing (`Listing.vehicleNumber`; `POST /listings/:id/vehicle-rc/verify`,
  kept on the listing; `ListingDocumentKind.VEHICLE_RC`).
- **Bank** (`POST /verification/bank-account/sync`): a PENNY_DROP on a bank
  payout method (`POST /finance/payout-methods/:id/verify { via: PENNY_DROP }`)
  runs the check — a live account is VERIFIED with the reference and the
  name-match score; a dead one, a refusal or no pair is a 409.

## The gate

Nothing offers work below ACTIVE. `agentAcceptsWork` reads the stage beside
the suspension, so offers, site visits, milestones and leads refuse with
`AGENT_NOT_ACTIVE`. The agent-initiated doors (onboarding a publisher,
completing an onboarding) require a working agent, and the attribution
points (QR claims, assisted bookings, listings and rate cards on a
publisher's behalf, listing imports) treat an inactive agent as not an
agent, so an applicant who is also a publisher or an advertiser keeps their
own rights. Withdrawals are not gated: an applicant has no wallet, and an
exited agent must still be able to settle.

## Routing by grade (AG-5)

The band ops sets on an account — a publisher's `sizeBand` (Lot B's
withdrawal ladder reads it too) and, since AG-5, an advertiser's; both set
from the desk alone through `PATCH /publishers/:id/band` and
`PATCH /advertisers/:id/band` — and a lead's `importance` (STANDARD, KEY,
ENTERPRISE) map to the agent grade the work is routed to. The map lives in
the routing settings (`GET/PUT /agents/routing-settings`, AppConfig key
`agent-routing`; Settings › Agent routing in the console): INDIVIDUAL → G1,
SMALL_AGENCY → G2, LARGE_AGENCY → G3; STANDARD → G1, KEY → G3, ENTERPRISE →
G4 by default, and `enforce`.

- **Dispatch** (`shared/dispatch/grade-bands.ts`, `rankCandidates`): the
  sweep asks for the grade the spot's publisher band wants and where the
  spot is. Agents below the grade are dropped when enforced (ranked last
  when not); among the rest the closest fit comes first — a G2 spot goes to
  a G2 before a G4, so the senior agents stay free — then the higher tier,
  then DR 07's lane and decline rate, then the nearer agent (both fixes
  known), then the lighter load, then seniority. An agent from before the
  grade reads as G1.
- **Leads**: an agent's own list (`GET /leads/near`) shows only the bands
  their grade may take when enforced; the desk's list shows every band, and
  every card carries `importance` and `requiredGrade`.
- **The desk's override**: `adminAssignAgent` and a lead assignment go
  through whatever the desk chose; an agent below the band's grade is
  logged as an override, never refused.

## Fleet partners (AG-5)

`FleetPartner` (the fleet or its manager — platform, contact, city) and
`FleetInvite` (one per number on a pasted list). `POST /agents/fleet-partners/:id/invites`
normalises the numbers, skips the ones already on the partner's list,
returns the rows that were not numbers, and texts each fresh one
(`AGENT_FLEET_INVITE`, the app link from `PLAY_STORE_URL`, else the site).
When a person with an invited number applies, `apply()` stamps the
application `sourceKind: FLEET`, names the partner in `sourceNote`, sets
`fleetPartnerId` and marks the invite APPLIED; activation marks it
ACTIVATED. No partner fee (decision 9). Agents › Fleet partners in the
console.

## The exit and the purge (AG-5)

`POST /agents/:id/exit` now settles through the agents port: the sessions
ended (`revokeSessions`), the live access grants closed
(`revokeLiveGrantsForAgent`), the agent QR deactivated, and the wallet's
balance raised as the closing withdrawal (`requestClosingWithdrawal` — the
same door an account closure uses; a balance with no verified payout method
is noted for Finance). The answer carries the `settlement`, the agent is
told, and the profile's `status` goes SUSPENDED so nothing offers work.
Ninety days after the exit (decision 10) the `agent-document-expiry` tick
purges the papers: the files through the uploads module, the rows deleted,
`documentsPurgedAt` stamped.

## The two axes

**Tier** (BRONZE to PLATINUM, levels I to III) is earned through milestones
and drives incentives and the leaderboard. **Grade** (G1 Field, G2 Senior
field, G3 Key accounts, G4 Enterprise) is set by the desk at activation from
education, experience, assessment and interview, may move at a renewal
(`PATCH /agents/:id/grade`), and is the routing axis: importance bands on
publishers, advertisers and leads map to a required grade, and dispatch
prefers grade, then tier, then distance (Lot 5).

## Data protection

Aadhaar and other numbers are stored masked and hashed, never plain. Images
go to private storage. Documents are purged 90 days after an exit (Lot 5's
sweep). The application records who uploaded and who reviewed each paper.

## What is still to come

- Lot 2: the application screens in the agent app, replacing "This account
  is not an agent" with "Apply to work with ADX"; a document picker for the
  résumé.
- Lot 3 (built, AG-3): Agents › Applications in the console — the queue
  with its chips, the workbench (ladder, papers with per-paper review and
  desk upload, Edit details, Record terms, Submit for review, the decision
  panel with the grade and engagement), the Engagement card on the agent
  page with grade change and exit, Add-agent starting as an application.
  Still to come there: a Settings page for grades and bands (Lot 5).
- Lot 4 (built, AG-4): the assessment on the quiz engine, interviews, the
  desk's tick, the screen and the certificate as activation gates with
  waivers, the paper-expiry sweep with ON_HOLD and the automatic resume,
  Cashfree's vehicle-RC and bank checks (live once the IP is whitelisted).
- Lot 5 (built, AG-5): importance bands and routing by grade with the
  settings page, fleet partners with bulk SMS invites and the provenance on
  the application, the exit's settlement and the purge ninety days on.
  Still open across the lots: Cashfree's live checks once the IP is
  whitelisted; real agreement text for the two agent platform kinds; a
  published curriculum and assessment per side.
