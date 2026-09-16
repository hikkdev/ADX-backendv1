# Backend modules

The backend is a modular monolith. Code is organised by **business domain**, not
by technical layer: everything about orders lives under `modules/orders`, not
scattered across `controllers/`, `routes/` and `services/`.

```
src/
  app.ts  server.ts        thin entry points
  bootstrap/               assembly: create-app, register-modules, shutdown, health
  config/                  process environment validation (Zod over .env)
  shared/                  infrastructure every module may use
  modules/                 the business domains
  jobs/  scripts/          background work and one-off tooling (scripts/backup.ts, scripts/restore.ts — Lot E)
```

## Ownership

| Module | Owns | Routes | Suggested owner |
| --- | --- | --- | --- |
| `auth` | Otp, RefreshToken, PasswordResetToken, AdminInvite, User credentials + 2FA columns; Lot F (Q18): the sign-in number moves in two codes, the old number first — `/auth/change-mobile/{start,confirm-old,verify}` | `/auth/*` | Senior — every change is a security change |
| `users` | User profile, UserRole, ImpersonationSession | `/users/*` | Senior, shared with auth |
| `access-control` | RoleConfig, UserRoleConfig | `/roles-config/*` (membership at `/users/:id/role-config`) | Platform |
| `employees` | Employee (incl. `externalHrmsId` — Lot E Q98, the HR-tool id `hrmsLink` is built from; Q143: every route ADMIN, `selfOrAdmin` retired); Lot G (Q113): `GET /employees?sort=NAME\|ROLE\|JOINED&dir=asc\|desc`; Lot G (Q122/Q140): `departmentId` → `hr`'s Department, `region`, `workMode`, `employmentType`, the record's name printed under `department`; Lot G (Q120/Q139): the workload measure — open items assigned + classed ActivityLog rows + diary entries, per week, banded by `hr.workloadThresholds` | `/employees/*` (incl. `/employees/workload`) | Platform |
| `hr` | Holiday (Lot G Q123: `kind` PUBLIC/OPTIONAL) — the one HR record kept in-house (Lot E, Q98); the people registry is a read over `employees` + `agents` (Q99), no table; `ensureHolidays()` seeds the year at boot; Lot G (Q122/Q140): Department — name/code, head, parent tree, regions, openRoles; members read through `employees`; `ensureDepartments()` turns the free strings on Employee rows into records at boot | `/hr/holidays*`, `/hr/people`, `/hr/departments*` | Platform |
| `schedule` | ScheduleEntry — the staff diary (Lot E, Q72/Q99); staff and agents both assignable; the field overlay is read from `visits.agentWorkInWindow` for the selected person only, never copied; holidays returned beside the entries; every write `SCHEDULE_ENTRY_*`; `/schedule/log` reads the trail back, no delete | `/schedule*` | Platform |
| `work` | WorkProject (PRJ-), WorkTask (TSK-), WorkTaskAssignee, WorkTaskReviewer, WorkTaskDependency, WorkTaskComment, WorkTimeLog, WorkIssue (ISS-) — Lot AA, the DR 10 Tasks section on real tables, essentials only (Q70): projects by department or city, tasks with sub-tasks (a parent's progress is the mean of its children's), people from `employees` + `agents` (anyone else 422), reviewers and approvers (a task with no reviewers verifies on completion; every approver's mark verifies; REJECT files the note as a comment and sends it back), prerequisites with the cycle check (TODO → IN_PROGRESS is 409 while one is unfinished), comments, hours as a number (an assignee's own, or `work.edit`), issues (an OPEN CRITICAL one flags the task `blockedByIssue` on read), the overview, the board (100 per column + `more`), `/work/me/*` for a person's own tasks (any employee or agent session), recurrence spawning the next TODO copy on VERIFIED, `jobs/work-due.job.ts` at 08:00 IST telling assignees of due-tomorrow and overdue tasks once per task per day (NotificationType WORK, events `WORK_*`); every status change `WORK_TASK_STATUS_CHANGED` with a diff so `/audit/targets/WorkTask/:id` is the history. NOT here (Q70): baselines, buffer, slack, overtime, Gantt, payroll — coordination only, a task never pays | `/work/*` | Platform |
| `qr` | QrCode, QrScan | `/qr/*` | Platform |
| `publishers` | Publisher, PublisherKyc; PublisherImport, PublisherImportRow (Lot D, Q86) | `/publishers/*` (incl. the KYC desk under `/publishers/kyc-queue/*` — per-document decisions, re-upload asks, assignment as a filter; the legacy-book import under `/publishers/import`, `/publishers/imports/*`), `/webhooks/digio` | Supply-side |
| `listings` | Listing, ListingPhoto, SavedListing (Lot D, Q5); Lot E: `GET/POST /listings/me/:id/{suggested-rate,accept-suggested-rate}` (the publisher takes the advisory offer), `belowFloor` on the admin rows, `updateListing` / `unpublishListing` handed to pricing's and rate-cards' ports by bootstrap; E10-2: `GET /listings/:id/reprice-log`, the LISTING_REPRICED_BY_FACTOR rows shaped for the Pricing tab; E11-2: `shareUrl` on every browse card (`PUBLIC_WEB_URL` + `/s/:displayId`) and the public spot page it opens (`spot-page.service.ts` — one self-contained document for an ACTIVE listing, the app deep link and the store links from env); G7 (Q109): AudienceSnapshot — `GET /listings/:id/audience?period=YYYY-MM` (`audience.service.ts`: ADMIN, the publisher's side, or an advertiser who has the spot in a non-draft campaign; the vendor behind `shared/audience` asked once per (listing, vendor, month), stored until a week past the month's end) and `audienceForSpots` for campaigns' analytics; Lot G (Q116/136): `Listing.slotsTotal` — a digital screen's loop, 1..24, gated on the sub-type or media type naming a screen; browse cards carry `slotsTotal`/`slotsLeft` for the asked window; the slot-hold rule (`slot-holds.ts`) is what `orders` and `campaigns` count with | `/listings/*`, `/advertisers/:id/saved`, `/s/:displayId` (the public spot page, root-mounted after packages' `/p/:token`) | Supply-side |
| `supply` | ListingAttempt, ListingDocument, ListingVerification, ListingClaim, ComplianceCase, EarningsHold; writes the publisher's PLATFORM and LISTING acceptances (the template lifecycle is `agreements`'; the legacy `/supply/agreements/templates` pair is retired — Lot D) | `/supply/*` | Supply-side |
| `agreements` | AgreementTemplate (draft / live / superseded, `requiresReacceptance` — Lot D Q55) and AgreementAcceptance for the transaction kinds (Lot D Q123): INSERTION_ORDER per campaign (rendered server-side, through `/advertisers/:id/agreements/insertion-order`), PACKAGE_SALE per sale, JOB_TERMS per order on the agent's own tap; `isCurrentAcceptance` is the one re-acceptance rule the platform gates apply; `GET /agreements/stale` is the stale-terms report | `/agreements/*` | Platform — the words every party accepts, and who accepted which version |
| `identifiers` | IdentifierFormat, IdentifierCounter | `/identifiers/*` | Platform |
| `advertisers` | Advertiser (Lot G Q119: `industry` from the `ADVERTISER_INDUSTRIES` picklist), Brand, AccountActivity, Wallet, WalletEntry, WalletHold, WalletRefundRequest, WalletTopUp (Lot B) | `/advertisers/*` (incl. `/industries`, `/mine`, `/:id/summary`, `/:id/activity`, `/:id/brands`, `/:id/wallet/top-ups`, `/:id/wallet/refund-requests` (E6), `/refund-requests/:id/{mark-paid,fail}`), `/finance/refund-requests`, `/finance/top-ups` (E6) | Demand-side |
| `campaigns` | Campaign and its spots, POIs, creatives, tracking codes, daily metrics; CampaignRefund (Lot B, Q41); Lot D: creative moderation (`moderation.service.ts` — IN_REVIEW at upload with the DIMENSIONS_MATCH / VENUE_STANCE checks and the flags, the desk under `/campaigns/creatives/*`, the ADX-design tap-accept, the hard gate on print and SCHEDULED→LIVE — Q44/Q120/Q138), the insertion-order gate at authorisation (Q123), tracking codes minted before the order loop with an optional destination and the landing-page interactions on `POST /t/:code/e` (Q7/Q139); Lot E (Q7/Q106): LandingPage — the builder under `/campaigns/:id/landing-page/*` (`landing-page.service.ts`, drafted from the brief through `shared/ai`, blocks validated as a closed vocabulary), the ADMIN review list at `/campaigns/landing-pages`, the public page rendered server-side at `GET /p/:slug` with the beacon, and `/t/:code` redirecting there when the campaign gave no destination; G7 (Q109): `audience` on `GET /campaigns/:id/analytics` — the vendor's panels over the booked spots through `listings.audienceForSpots`, folded by `foldAudience` (footfall summed, shares weighted by days × quantity), PANEL provenance and the vendor's name, null when the provider is NONE | `/campaigns/*`, `/t/*` (tracking), `/p/:slug` (the landing page, ahead of packages' `/p/:token`), `/finance/campaign-refunds/*` | Demand-side — the booking flow |
| `packages` | AdvertiserPackage, PackageAddOn (the catalogue — editable at `/packages/catalogue/*`, ADMIN, audited; a sale keeps its snapshot and entitlements stay copy — Lot D Q94), PackageSale, PackageSaleLine; the PACKAGE_SALE terms accepted at `/sales/:id/accept-terms` before either payment door (Lot D Q123) | `/packages/*`, `/p/:token` (the payment link) | Demand-side — the four-step sale beside the booking flow |
| `wallets` | the wallet primitives every party shares — `move()` is the one door money goes through, publisher, agent, advertiser and print partner alike (Lot B; the fourth owner is B4b) | none | Finance |
| `ledger` | LedgerAccount, LedgerTransaction, LedgerLeg — double entry under every wallet; the chart in `ledger.service.ts` | none (read through `/finance/ledger*`) | Finance |
| `payouts` | PayoutMethod, WithdrawalRequest, EarningAccrual (gross = rate × quantity, commission from the spot's stamp — Lot B, B1), AgentIncentive, the limits and tax rates; PayoutBatch and BankAccount (Lot B, Q85/Q140 — approval reserves, release debits; Lot G, Q124: `jobs/payout-batch-draft.job.ts` drafts one batch a week on `finance.payoutBatchCadence` as the system user, audited `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE`, the finance admins told — never approves or releases) | `/payouts/*` (incl. `/ifsc/:code`), `/finance/*` (incl. `/finance/accruals/quantity-backfill`, `/finance/withdrawals/summary`, `/finance/payout-batches*` incl. `/schedule`, `/finance/bank-accounts`) | Finance |
| `pricing` | MediaType, SizeClass, Material, MarketDataPoint/Import, PricingFactor (Lot E Q125: `mode` ADVISORY \| BINDING, `bindingDuringSurgeOnly`; a binding apply reprices through `ListingRepricePort` within `PricingSettings.maxBindingChangePct`, above it 409 `BINDING_CHANGE_TOO_LARGE` and a price case), ListingPricingFactor (`appliedRatePerDay`), SurgeEvent, PricingSettings, City | `/pricing/*` | Demand-side, with supply |
| `revenue` | CommissionRate (keyed on category, or on media type with an optional rental band — Lot B), PublisherSubscription, PublisherCommissionOverride, FeeSchedule, TaxSettings, PriceLock | `/revenue/*` | Finance |
| `rate-cards` | RateCard (`graceDays` — Lot E), RateCardEntry, PriceApproval (`source` PUBLISH_REQUEST \| CARD_REVISION, `graceUntil` — Lot E Q97: approving a revised card raises a CARD_REVISION case per ACTIVE listing under its floor; a rejection after the grace unpublishes through `ListingEnforcementPort` unless an order is running, then the case is held); `GET /rate-cards/:id/impact`, E10-2 `POST /rate-cards/:id/impact/dry-run` over a draft grid and `GET /rate-cards/approvals?source=&listingId=&page=`; `belowFloorFlags` for the listings table; `raisePriceCase` for pricing's binding factors | `/rate-cards/*` | Demand-side, with supply — governance beside the pricing engine |
| `orders` | Order, OrderAgentAssignment, CheckIn, SiteVerification; Lot D's ops moves (`/:id/reassign-agent`, `/:id/ops/*`) and the cancellation columns; the agent's tap on Accept records JOB_TERMS through `agreements` (Q123); `markPrintReady` refuses 409 `CREATIVE_NOT_APPROVED` through `CreativeGatePort`, filled by `campaigns` (Q120); Lot G: `GET /orders/calendar` (Q114, listings-first, every ACTIVE spot with the window's orders on it) and slot-aware placement (Q116/136 — refused only when no slot is left over the flight); G6 (Q110): the publisher's booking report PDF and spot insights under `/publishers/me/bookings/:orderId/{report.pdf,insights}` (`publisher-report/`, mounted ahead of the publishers router — `publishers` cannot import `orders`; the listing's publisher or their agent under a live grant; the PDF stored PRIVATE as `BOOKING_REPORT` owned by the publisher, audited `BOOKING_REPORT_GENERATED`; insights 403 `FEATURE_OFF` unless `publisher-spot-insights` is on for the publisher) | `/orders/*`, `/publishers/me/bookings/:orderId/{report.pdf,insights}` | Own team — core domain |
| `order-milestones` | OrderMilestoneTemplate, MilestonePlan(Item), OrderMilestone(Evidence) | `/milestone-templates/*`, `/milestone-plans/*`, `/orders/:orderId/milestones/*`, `/agent/milestones/*` | With orders |
| `agents` | AgentProfile, AgentTierEvent, AgentRating, AgentMilestone, MilestoneTemplate | `/agents/*` (incl. `/me/tier`, `/me/leaderboard`, `/tier-ladder`, `/leaderboard`), `/milestones/*` | Agent experience |
| `leads` | Lead, LeadActivity; `phoneNormalised` as the dedup key and the transactional import with its per-row report (Lot D, Q93) | `/leads/*` | Agent experience — DR 06 |
| `visits` | FieldVisit (Lot E Q99: `AUDIT` kind paid at the visit rate; `campaignTag` on dispatch; `agentWorkInWindow` — the day's fold over a range, for `schedule`'s overlay) | `/visits/*`, `/agents/me/day` | Agent experience — DR 06; owns the day because the day is made of visits |
| `training` | TrainingResource (the library), TrainingModule, TrainingQuestion/Option, AgentTrainingProgress, TrainingAttempt, AgentCertification | `/training/*` | Agent experience — DR 05; moved out of `agents` |
| `earnings` | Transaction | `/earnings/*` | Agent experience |
| `notifications` | Notification, NotificationPreference; Lot E (Q87/Q128/Q147): NotificationTemplate and NotificationDelivery — the **dispatcher** (`notify(event, userId, vars, opts)`: the in-app row plus one masked, hashed delivery per outbound channel the event's ACTIVE template names and the preference allows; the sender job renders and sends, three attempts; variables purged at 90 days, 7 for a sensitive template, rows at 180), the seeded templates (`ensureTemplates()` at boot, never overwriting), the comms desk, the unsubscribe link (the one column it writes on `User`: `emailUnsubscribedAt`) and the rails' delivery-report webhooks; Lot G (Q117/Q121): `NotificationTemplate.transactional` and the two comms rules on non-transactional copy — `comms.quietHours` defers a row (QUEUED with `NotificationDelivery.scheduledFor` — G10: the column, which `findQueued` reads; rows written before it under the `QUIET_HOURS until <iso>` marker are folded onto it once) and `comms.weeklyCapPerUser` withholds the row beyond the cap per person per Indian week (SKIPPED / `WEEKLY_CAP`) — and `DeliveryAttempt`, one row per try with the rail's answer masked (`attemptRows` on the delivery read); G6 (Q103/133): `DeviceToken` and **push** — `/users/me/devices` (upsert on the token, the token follows the login, sign-out removes the caller's own row), `shared/push/fcm.ts` (FCM HTTP v1 with a JWT grant signed by `node:crypto` from `FIREBASE_SERVICE_ACCOUNT_JSON`; unset → every push `skipped: FCM_NOT_CONFIGURED`), PUSH as the dispatcher's third channel (a template may name it; G10: `pushTitle` / `pushBody` render ahead of `subject` / `smsBody`; one delivery per push masked as the device count, sent to every device, an `UNREGISTERED` token deleted on the spot, attempts logged; preference default on for every kind; the device routes behind the `comms.push` kill switch) and the silent `FLAGS_CHANGED` data push to every device when a flag moves (`broadcastFlagsChanged`, wired by bootstrap into `feature-flags`' change port) | `/notifications/*`, `/users/me/devices*`, `/comms/{templates*,templates/:key/send-test,deliveries*,deliveries/export.csv,events,sms-kinds,unsubscribe/:token}` (E10-2: the events catalogue off `EVENT_REGISTRY`, template `stats`, the `byChannel` histogram, the masked CSV export; Lot G: the test send to the operator's own email / mobile, never a body-supplied address), `/webhooks/{msg91,twilio}` | Small for the feed; Platform for the dispatcher — every outbound message passes through it |
| `announcements` | Announcement, AnnouncementDelivery (Lot E, Q64/Q130) — a broadcast from ops: in-app always, email to the subscribed with an address, SMS only when CRITICAL and only if `ANNOUNCEMENT_CRITICAL` is registered on a rail; the desk drafts, previews per channel (E10-2: `POST /announcements/preview-count` over an unsaved draft; G11-2: both previews carry `push`, the `DeviceToken` rows in the audience), sends now or at a time, cancels; `jobs/announcement-sender.job.ts` fans out in batches of 500 through `notifications.notify`, one mark per (person, channel), audited `ANNOUNCEMENT_SENT`. Reads the audience (`User`, `UserRole`, the profiles' `city`) read-only in its own repository, the way `admin-overview` reads the ledger | `/announcements/*` | Platform — with `notifications` |
| `support` | SupportTicket, TicketMessage, CannedReply; the two-clock SLA from the platform settings, WAITING pauses it, internal notes (Lot D, Q53/Q91). **Lot I: live chat for paid subscribers** — a live chat is the same `SupportTicket` wearing `channel: LIVE_CHAT`, so one number, one thread, one queue. `live-chat.entitlement.ts` decides who gets it (a publisher on a running `PublisherSubscription` through `revenue`, narrowed by `support.liveChat.publisherTiers`; an advertiser on an ACTIVE `PackageSale` whose plan's `entitlements` JSON does not set `liveChat: false`; everyone else keeps the ticket thread) and answers `{ entitled, reason, plan, upsell }`. `POST /live/start` inside `support.liveChat.hours` (09:00–21:00 IST) with an operator online creates the chat, auto-assigns the one holding the fewest open chats (SYSTEM 'Priya joined', in-app + push), and streams; outside the hours or with nobody on, it opens a TICKET naming the next opening. `GET /tickets/:id/events` and `GET /live/inbox/events` are SSE (retry 3000, 25 s comment heartbeat, `Last-Event-ID` honoured through `lastMessageAt`), authenticated by the bearer header or by a single-use five-minute `?t=` stream token bound to the ticket and the caller; the fan-out is Redis pub/sub (`support:ticket:<id>`, `support:inbox`) with a local EventEmitter fallback. Replies carry `attachmentFileId` (purpose SUPPORT_ATTACHMENT, private, images and PDF ≤ `attachmentMaxMb`), stamp `lastMessageAt` and `firstResponseAt`, and push `SUPPORT_REPLY` / `SUPPORT_MESSAGE_FROM_REQUESTER`. `jobs/live-chat-sla.job.ts` (every minute, Redis-locked) breaches a chat past `firstResponseTargetSec` once and converts an unowned chat idle 30 minutes to a ticket. Feature `support.live-chat` (KILL_SWITCH) guards every live route except `GET /live/status`, which reports `reason: FEATURE_OFF` so the phones can fall back | `/support/*` | Small |
| `disputes` | Dispute, DisputeMessage, DisputeEvidence; the paused SLA clock and the re-install link (Lot D) | `/disputes/*` | Three personas and the console — one domain |
| `fraud` | FraudCase, FraudCaseNote, FraudCaseEvidence (Lot D, Q54/Q92/Q121) — fraud as a case object; a decision applies or lifts suspension scopes through `suspension`, never writing one itself. Lot G (Q118/138): thirteen computed signals under `fraud/signals/` (one per file, a weight table in the README) over a read-only cross-party index (`prisma-fraud-signals.repository.ts`), `score = min(1, Σ weight × value)` stored on the case, a scan with no case, the linked accounts, ESCALATED as a working status, and `jobs/fraud-signal-scan.job.ts` opening SIGNAL_SCAN cases nightly — never suspending. G11-1: the people on a case by name (`users.findUserLabels`), and the linked-accounts rail priced through `wallets.findWalletFor` and `orders.openOrderExposureFor` (`walletBalance`, `openBookings`, `valueAtRisk`) | `/fraud/cases*`, `/fraud/scan/:subjectType/:subjectId` | Platform — the desk; ADMIN at the router |
| `legal` | LegalDocument | `/legal/*` | The read documents; the two public reads carry no token |
| `safety` | SafetyAlert | `/safety/*` | A blocking report takes the job off the agent |
| `onboarding` | OnboardingFlowTemplate, OnboardingSubmission — user types PUBLISHER, ADVERTISER, PARTNER, and (Lot D, Q131) AGENT and EMPLOYEE, whose APPROVED submission provisions the profile through `agents.createAgent` / `employees.createEmployee` | `/onboarding/*` | Platform |
| `kyc` | AdvertiserKyc, UserKyc (the liveness video, Lot D Q131), AgentKyc, EmployeeKyc (Lot D), KycDocumentReview (Lot D Q42 — one decision per tile, both party types; `publishers` reaches it through the index), the purge rules (Q127); Lot G (Q127/142): `escalation.service.ts` — AGE (`jobs/kyc-escalation.job.ts`, N× the review SLA), FRAUD_LINK (from `fraud`) and REVIEWER escalations to the Compliance pool (`access-control` role by name, else KYC reviewer, else any ADMIN), the five escalation columns on both AdvertiserKyc and PublisherKyc written through `prisma-kyc-escalation.repository.ts`, cleared by a decision | `/advertiser-kyc/*` (incl. `POST /:id/escalate`), `/user-kyc/*`, `/agent-kyc/*`, `/employee-kyc/*` | One owner for the four review flows and the desk they share |
| `uploads` | UploadedFile (with `visibility`, `ownerUserId`, `storageKey` — Lot D, Q61) | `/upload` (Lot F: naming `ownerUserId` is an on-behalf write — ADMIN or the party's agent under a live grant, else 403), `/files/:id` (the one door to a private file: owner, the party's agent under a live grant through `FileAccessPort`, or ADMIN — and, Lot F, for DISPUTE_EVIDENCE the other side of the case through `FileAccessPort.disputePartyMayView`, filled in bootstrap from `disputes.disputePartiesForEvidenceFile`; presigned R2 read or local stream; `FILE_VIEWED` on identity documents) | Platform |
| `reconciliation` | BankStatementProfile, BankStatementImport, BankStatementLine, ReconciliationMatch | `/finance/reconciliation/*` (Lot G, Q125: `imports/:id/export.csv` and `lines/export.csv?status&from&to` — every line with its match state, matched record and resolver, streamed by keyset under a cap, audited `RECONCILIATION_LINES_EXPORTED` before the first byte) | Finance — Lot B (Q85): the books against the bank; reads withdrawals, top-ups and the ledger through their indexes, the resolver's name through `users.findUserLabels` |
| `print-partners` | PrintPartner (and the PARTNER User behind it — inactive until ops activate it, Lot H), PrintJob, PrintQuoteRequest, PrintQuote; `Wallet.printPartnerId` is the fourth owner | `/print-partners/*` (the desk, ADMIN), `/print-partners/me/*` (the partner's floor, PARTNER — Lot H), `/orders/:id/print-job*`, `/orders/:id/print-quote-request*` | Finance — Lot B (Q50/B4b, decisions 50/122): the print shops as payees; a job's approved cost is PRINT_COST into the partner wallet with TDS under 194C. Lot H (Q147): ops activate the account so the partner signs in by OTP; the partner keeps a rate card or takes quote requests; ops invite the partners in reach, the lowest quote is awarded (another only with a note) and opens the job; the partner accepts/declines, walks Printing → Ready, hands the material over by scanning the agent's PICKUP code (`qr.confirmPickupHandover`), and raises withdrawals, payout methods and the monthly invoice under `payouts`' rules; the nightly `print-quote-expiry` job re-invites once and expires; `orders` reads the job back through `PrintJobPort` |
| `integrations` | (AppConfig credentials row) — incl. the `sms` routing table (Lot E, Q128: `primaryRail` / `fallbackRails` over the adapters in `shared/sms/rails` — MSG91, Twilio, a `third` stub — the DLT entity and sender ids, and per-rail, per-kind template registrations; an unregistered kind is skipped, never sent) and `email.primary` SMTP / RESEND (Q87), the `hrms` section (Lot E, Q98: provider NONE / ZOHO_PEOPLE / KEKA / GREYTHR, a portal link and an employee-link template; no sync job), the `workTool` section (E10-1: provider NONE / JIRA / TRELLO / ASANA / OTHER, a portal link and a name; no secret, drawn as-is) and `kyc.kycProvider` DIGIO / DEGRADED / MANUAL (Lot D, Q129): the probe in `shared/vendors/probe.ts` moves DIGIO ↔ DEGRADED on `jobs/kyc-provider-probe.job.ts`'s five-minute tick, MANUAL is ops' own; every Digio initiate and restart answers 503 `KYC_PROVIDER_UNAVAILABLE` with `retryAfter` while off; G7: the `maps` section (Q101/132/137: provider GOOGLE / MAPBOX / OSM, browser key + server key, public + secret token, all masked; `MAPS_PROVIDER_CHANGED` audited; Z-B: the strict `osm` sub-object — Nominatim / OSRM / Photon base URLs, the contact email the public Nominatim policy requires (selecting OSM without one is refused 400), User-Agent, tile template + attribution + max zoom + masked tile key, `publicTiles` warning) and the `audience` section (Q109: provider NONE / GEOIQ / AZIRA, the two keys masked, GeoIQ's per-account variable map, Azira's base URL from the contract, `catchmentRadiusM`; `AUDIENCE_PROVIDER_CHANGED` audited); G11-2: the read-only `push: { configured, reason? }` from `shared/push`'s `readServiceAccount` — the verdict only, never the key | `/integrations` | Platform — credential handling |
| `app-config` | AppConfig rows: `main` (+ `main:previous`, `flows.<key>:v<N>` — the last five replaced versions of each flow), `app-status`, `platform`, `categoryPlans`, `tier-ladder`, `support-lines` | `/config`, `/config/revert`, `/config/schema`, `/config/flows`, `/config/flows/:key`, `/config/enums/:group`, `/app/status`, `/app/limits` (E7-2: the wizard's caps off the platform settings, authenticated), `/app/maps` (G7 Q101/132: the maps vendor and its browser key / public token for the phones and the console — never the server key; authenticated), `/settings/platform` | Platform — Q83/Q148: the console's flow editor speaks the apps' vocabulary (`flow-schema.ts`: the 23 hyphenated field kinds of both apps' `fields.tsx`, Record-shaped branches; `onboarding-template.ts`: the ladder's seven step kinds, the seven KYC capture columns and `REQUIRED_KYC_COLUMNS`); each flow carries a `version` bumped by every PATCH; `flows.onboarding` is the DR 08 ladder as data, composed by `users`' manifest at the version a party started on, with `CODE_ONBOARDING_TEMPLATE` as the fallback; campaign launch stays coded until it has a renderer |
| `geo` | Lot V (the owner, 15 Sep 2026): GeoState (36, GeoNames admin1), GeoDistrict (763, admin2), CityRolloutEvent, and the rollout columns of `pricing`'s City — `stage` (PLANNED \| SEEDING \| LAUNCHED \| PAUSED \| WITHDRAWN), the six function switches (`supplyIntake`, `publishing`, `demand`, `agentOnboarding`, `printPartners`, `leadFeeds`), `launchedAt`/`pausedAt`/`withdrawnAt`, `geonameId`, `population`, `kind`, `source` SEED \| GEONAMES \| MANUAL; `isActive` kept as a mirror of the stage. The maps door keeps nothing — a 15-minute Redis entry per route (`directions.service.ts`) | `/geo/geocode`, `/geo/reverse`, `/geo/autocomplete`, `/geo/places/:placeId`, `/geo/directions` (G7 Q137); Lot V: `/geo/summary`, `/geo/map?bbox&stage`, `/geo/states`, `/geo/states/:code/districts`, `/geo/cities` (list contract, counts per stage; POST adds a MANUAL town), `/geo/cities/:slug` (the row, its events, its seven counts), `/geo/cities/:slug/readiness`, `PATCH /geo/cities/:slug/rollout` (the stage machine: defaults per stage, any switch overridable, one event per change, audited), `POST /geo/rollout` (a list, a state or a district at once; refusals named, not the batch failed), `POST /geo/seed` (`system.roles`; = `npm run seed:geo` over `data/geo/india-geo.json`, GeoNames CC BY 4.0, ~6,500 towns, chunked, idempotent, the 44 Lot A rows matched not duplicated), `/app/geo/cities` (the pickers + `comingSoon`), `/app/geo/resolve?name=` | Platform — the one door to the maps vendor (G7 Q101/132: `shared/maps`' `MapsProvider` port, Google or Mapbox by the integrations row) and, Lot V, the country catalogue and where ADX goes in, gathers, launches, pauses or pulls out. The gate is `pricing.assertCityAllows(name, function)` (400 `CITY_NOT_OPEN`; an unknown name is always allowed — free text stays free), called by listings, supply, campaigns, agents, print-partners, leads and the importers; `geo` sits above `pricing`, never the reverse. `jobs/city-winddown.job.ts`: a WITHDRAWN city's live listings unpublished (cause CITY_WITHDRAWN), open leads LOST, publishers and agents told once (`CITY_WITHDRAWN`), marked by an event so a tick is idempotent; re-entry republishes nothing. Y-B: `GET /geo/cities/:slug/audience?period=` — the city audience profile (`audience-profile.service.ts`): the blend of both audience vendors over the city's live spots' stored `AudienceSnapshot` rows (mean daily footfall, mixes weighted by footfall, coverage, vendors in force, agreement), cached a minute, calling no vendor unless `settings.audience.cityProfileSamplePoints` > 0 (a ⌈√N⌉² grid across the listings' box, or a 3 km circle, under `city:<slug>:<n>` keys — one billable call per point per vendor per month per city); readiness gains the soft `audience` check; `cityAudienceProfile(slug, period?)` exported for the lead score |
| `feature-flags` | FeatureFlag (Lot G: `surfaces`, `kind`, `source`, `owner`, `variant`, `variants`, `rollout`, `lastGoodState`, `registeredAt`), FeatureFlagChange (`variant`, `rollout`, `rollbackOfId`); **the feature registry** (answers 144-146): every module declares its features in a `features.ts` beside its routes (`feature(key, {...})` from `shared/features`), the console and the two apps ship a `features.manifest.json`, `npm run features:sync` folds them into `docs/feature-registry.json`, `ensureFeatureRegistry()` upserts every one into a row at boot (on unless `launch: 'dark'`; a REGISTERED row keeps its switch, a MANUAL row is never touched), and `tests/architecture/feature-registry.test.ts` fails when a mounted route or a job belongs to no feature; `requireFeature(key)` is the 503 FEATURE_OFF kill switch on a route; rollout by percentage / roles / cities / accounts (the city through `registerFlagSubjectCityPort`); variants; `POST /flags/:key/rollback` (ADMIN + `system.flags`) restores `lastGoodState`; the flag change port fires after every write (G6 pushes the refresh); G11-2: `registry-check.ts` is the one checker `npm run features:check` and `GET /flags/registry`'s `check: { current, surfaces: [{ surface, behind, reasons }] }` share, and `GET /flags/me` answers the admin `{ key: { enabled, variant } }` across every surface through the same evaluator | `/flags/*` (incl. `/flags/registry`, `/flags/me`, `PATCH`+`PUT /flags/:key`, `/flags/:key/rollback`), `/app/flags` (`{ key: { enabled, variant } }` on the app surfaces plus the three legacy booleans) | Platform — Lot A (Q31), Lot G (G9) |
| `audit` | (reads `ActivityLog`, which `shared/audit` writes) | `/audit`, `/audit/export.csv`, `/audit/targets/:targetType/:targetId` | Platform — Lot A observability |
| `admin-overview` | nothing — read-only aggregates and window-scoped facts across Campaign, CampaignSpot, PackageSale, the ledger, EarningAccrual, AgentIncentive, Publisher, Advertiser, the KYC tables and, as counts only, PayoutBatch, WithdrawalRequest, FraudCase, SupportTicket, PriceApproval (Lot B, Q30/Q80; Lot G, Q115 analytics set + Q112 insights) | `/admin/overview`, `/admin/overview/{series,breakdown,tiles,export.csv,insights}` | Finance — the console's month in numbers |
| `section-overviews` | nothing — read-only aggregates across Publisher, Advertiser, AgentProfile, PrintPartner, Employee, Department, Holiday, User, UserRole, UserContact, ErasureRequest, the five KYC tables, Listing, Campaign, PackageSale, EarningAccrual, WithdrawalRequest, Wallet, WalletTopUp, AgentIncentive, FieldVisit, Order, PrintJob, PrintQuoteRequest, PrintQuote, PublisherSubscription (package O-B): one overview read per user section — tiles, series by Indian day, breakdowns and top tens over a window with the previous window beside every figure; the funnels, the employees' overview and workload, the leaderboard and the label lookups carried through the owning modules' exports, the way `admin-overview` reads the ledger | `/section-overviews/:section` | Platform — with `admin-overview` |
| `party-imports` | PartyImport, PartyImportRow (Lot S) — the publisher importer generalised: a two-step import (validate with a per-row report, then commit) for advertisers, agents, print partners and employees; every CREATE goes through the party's own creation service (`registerAdvertiser`, `createAgent`, `createPartner`, `createUser` + `createEmployee`) and every MERGE through its update service, so display ids, wallets, brands, roles, kycStatus PENDING and the creation audit rows happen as a console Create; commit is per row with a resumable marker, never a row of its own. Lot U: two kinds FOR a publisher — `listings` (each spot through `listings.createListing`, filed under ONE supply attempt per import through `supply.attachListingToAttempt`, never ACTIVE; geocoded through the maps seam, the vocabulary and the ADX floor checked, 25 m duplicates warned) and `rate-card` (rates through `listings.updateListing`), ADMIN or the publisher's agent under the listing act rule — and the format guide, one JSON + template.csv per import kind on the platform, contract-tested against the validators | `/party-imports/:party`, `/party-imports/:party/:id`, `/party-imports/:party/:id/{commit,revoke,report.csv}`, `/party-imports/{listings,rate-card}?publisherId=` (+ `/:id`, `/:id/{commit,revoke,report.csv}`), `/party-imports/formats`, `/party-imports/formats/:kind`, `/party-imports/formats/:kind/template.csv` | Platform — with `publishers`' Lot D importer |
| `suspension` | PartySuspensionEvent, and the suspension columns on Listing / Publisher / Advertiser / AgentProfile | `/{listings,publishers,advertisers,agents}/:id/{suspend,reinstate}`, `/suspension/:partyType/:partyId` | Platform — Lot A enforcement |
| `account-lifecycle` | AccountClosureCase, ErasureRequest, MobileTombstone, and the closure + erasure columns on User / Publisher / Advertiser / AgentProfile / the four KYC records; G6 (Q104): `DataExportRequest` — the person's own data export (`POST /users/me/data-export`, 409 while one is PENDING or READY-and-unexpired; `GET` the latest), built by `jobs/data-export.job.ts` every minute: the records assembled read-only (no images, hashes or other people's contact details), `adx-data-export.json` + `README.txt` in a zip (`shared/zip`), stored PRIVATE as `DATA_EXPORT` owned by the person, READY for seven days, `notify('DATA_EXPORT_READY')` with the app deep link; the retention sweep purges the file and marks EXPIRED, rows gone at ninety days | `/users/{me/closure-request,me/erasure,me/data-export,closure-cases*,erasure*,:id/closure-review,:id/closure-cases,:id/erasure}` | Senior — Lot A, Q21/Q60; G6 for the export |
| `reviews` | Review — a spot's or an agent's, every one anchored on the order or campaign spot that earned it; recomputes `Listing.ratingAvg/reviewCount` and `AgentRating.reviewAvg/reviewCount` through the owning modules' exports; E7-2: fills `campaigns`' `SpotReviewPort` (`reviewed` / `reviewId` per spot on `GET /campaigns/:id`) and names the publisher on the agent's rating ledger | `/campaigns/:id/spots/:spotId/review`, `/listings/browse/:id/reviews`, `/orders/:id/rate-agent{,/eligibility}`, `/agents/me/reviews` (E7-2, the agent's own), `/agents/:id/reviews`, `/reviews*` | Marketplace — Lot D (Q104/Q112): the party routes are mounted ahead of their modules' routers; the desk hides with a reason, never deletes |
| `invoices` | LegalEntitySettings, Invoice, InvoiceLine, InvoiceSequence, PublisherInvoice, Statement (DR 04's table, generated here as the monthly payment advice) | `/finance/{legal-entity,invoices*,publisher-invoices*,statements/run}`, `/advertisers/:id/invoices*`, `/publishers/me/invoices`, `/payouts/wallet/statements*` | Finance — Lot B (Q13/Q34); the paper, never the money; `campaigns` and `packages` reach it through ports |
| `payments` | Payment, PaymentRefund, WebhookEvent; the three gateway adapters over `fetch` (Razorpay live first; Cashfree and CCAvenue in test mode until their credentials — Lot C, Q110); E7-2: the phones' Razorpay flow in the system browser — `GET /payments/:id/checkout?t=` (one-time token minted with the intent as `checkoutUrl`, self-contained page over `checkout.razorpay.com/v1/checkout.js` under a CSP, confirms under a second token) and the public `GET /payments/:id/return` status page every gateway's `returnUrl` now points at | `/payments/*` (gateways, intents, `:id`, `:id/checkout`, `:id/return`, `:id/confirm`, `:id/refund`), `/advertisers/:id/payments`, `/webhooks/{razorpay,cashfree,ccavenue}` | Finance — Lot C: money arriving from advertisers. A capture is a gateway TOPUP into the wallet and the campaign or sale is settled out of that balance by the wallet path's own calls (Q118); ORIGINAL_METHOD refunds route here through `advertisers`' `OriginalMethodRefundPort` |
| `ops` | three `AppConfig` rows through `app-config` (`ops:last-drill`, `ops:retention-due`, `ops:erasure-due`); the monthly restore drill and the daily retention sweep run from `jobs/` (Lot E, decisions 95/126). Lot G (Q130): HealthSample (one row per service — API, POSTGRES, REDIS, STORAGE, JOBS — every five minutes from `jobs/health-sample.job.ts`, thirty days kept; the Postgres ping arrives through `registerPostgresProbe`, filled in bootstrap), Incident + IncidentUpdate (the log ops keep by hand; every change audited `INCIDENT_*`, admins told in-app, confirmed subscribers mailed `INCIDENT_UPDATE`), StatusSubscriber (confirm-first, by link; G11-2: `GET /settings/system-health/ops` counts them as `subscribers: { confirmed, pending }`); the public status page derives each service's state from the newest sample, the platform settings' `health` thresholds and the open incidents | `/settings/system-health/{ops,history,regions,incidents*}`; root-mounted `/status`, `/status/subscribe`, `/status/confirm/:token`, `/status/unsubscribe/:token` (rate-limited by IP, no token) | Platform — the on-call read: last dump, last drill, what retention flagged, whether every job ticks, and now the lights and the incident log behind the status page. The sweep reads `account-lifecycle` and destroys nothing |
| `reports` | ReportRun, ReportSchedule (Lot G, Q129/Q143) — twelve report kinds defined in code (`catalogue.ts`: bookings-gmv, publisher-earnings-payouts, advertiser-spend-refunds, agent-commissions, onboarding-funnel, supply-listings, kyc-ageing, support-sla, disputes-fraud, comms-deliveries, campaign-performance, platform-summary), each a name, a filter contract, columns and a query over `ReportData` — a read-only walk across the other modules' tables, the way `admin-overview` reads the ledger. A run renders now (CSV through `shared/csv`, PDF through pdfkit) into a PRIVATE `REPORT` file via `uploads.storeGeneratedFile`, readable for thirty days by an admin or by the signed link a schedule mails; `jobs/report-schedule.job.ts` (five minutes, Redis-locked) runs due schedules — DAILY 06:00 IST for yesterday, WEEKLY Monday for the seven days before, MONTHLY the 1st for last month — mails each recipient through `notify('REPORT_READY')` (the ADMIN accounts' emails when none are named) and always moves `nextRunAt` on; G11-2: the mailing is recorded on the run (`mailedTo`, `mailedAt` on every run row — under the reserved `$mailed` key of `filters` until the two columns exist, split back out by `runView`) and the catalogue rows carry `filterLabels` | `/reports/{catalogue,run,runs,runs/:id,runs/:id/file,schedules,schedules/:id}` | Platform — with `admin-overview`, which reads the same tables for the console's numbers |

Every module has a `README.md` with its routes, entities, exports, dependencies
and — most importantly — its **invariants**. Read that before changing one.

## Names that collide

Three pairs share vocabulary and nothing else. Each module's README opens by
distinguishing them.

| These are different | |
| --- | --- |
| `agents` milestones | gamification: targets, rewards, tiers |
| `order-milestones` | per-order fulfilment checklist |
| `employees` | internal staff HR records |
| `agents` | field workers with an AgentProfile |
| `publishers` onboarding | agent-run QR claim flow, on site |
| `onboarding` | back-office admin intake form |
| `app-config` | enums + flow definitions (AppConfig `main`) |
| `config/` | process environment validation |
| `integrations` | third-party credentials (a different AppConfig row) |
| `listings` | a listing row and its photos |
| `supply` | how a listing gets verified, documented, claimed and policed |
| `pricing` | what a listing should cost — and the taxonomy that question needs |
| `revenue` | what happens to that number: commission, fees, tax |

## Dependency graph

Arrows point at the dependency. Everything may use `shared/`; nothing in
`shared/` may import a module.

```
                       ┌──────────────┐
                       │  bootstrap   │  mounts every module router
                       └──────┬───────┘
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌──────────┐          ┌───────────┐
   │  auth   │◄─────────│  users   │◄─────────│ support   │
   └─────────┘          └────┬─────┘          │ employees │
        ▲                    │                └───────────┘
        │                    ▼
   ┌────┴─────┐        ┌──────────┐
   │onboarding│        │  agents  │◄──── earnings, order-milestones
   └──────────┘        └────┬─────┘
                            ▼
   ┌─────────┐   port   ┌────────────┐        ┌──────────┐
   │   qr    │◄─────────│ publishers │───────►│ listings │
   └─────────┘  ───────►└────────────┘        └────┬─────┘
                 mint                              │
                                                   ▼
   ┌───────────────┐                          ┌──────────┐
   │notifications  │◄─────────────────────────│  orders  │
   └───────────────┘                          └────┬─────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │ order-milestones │──► app-config
                                          └──────────────────┘
```

`qr ↔ publishers` was the first pair that needed both directions. It is resolved
with a **port**: `qr` declares `PublisherOnboardingPort`, `publishers`
implements it, and `bootstrap` registers it — so `qr` never imports
`publishers` and there is no cycle. See `modules/qr/README.md`. The same shape
serves `orders ↔ print-partners` (Lot B, B4b): `print-partners` reads orders to
gate a job, and `orders` reaches the job — the pickup point, the collection —
through the `PrintJobPort` it declares.

## Rules

### Adding an endpoint

1. Add the route to the owning **module's** `*.routes.ts`. Never to
   `bootstrap/register-modules.ts` — that file only decides where a module's
   router is mounted.
2. Validation goes in the module's `*.schema.ts`, as Zod.
3. The controller translates HTTP to a service call and back. No business rules,
   no Prisma.
4. Business rules go in the service. Services never touch `req`/`res`.
5. Queries go in `prisma-<module>.repository.ts`, behind the interface in
   `<module>.repository.ts`.
6. Regenerate the route snapshot and review the diff:
   `npm run routes:snapshot && git diff docs/route-inventory.json`.
7. Add the invariant to the module README if it is not obvious from the code.
8. Cover it with a feature (Lot G, answer 144): either `requireFeature('key')`
   on the route, or a route prefix on the declaration in the module's
   `features.ts`. `tests/architecture/feature-registry.test.ts` refuses a
   route no feature claims. A new capability is a new `feature(...)` call
   with a description a person can read; a new endpoint of an existing
   capability is usually already under its prefix. Then
   `npm run features:sync` and commit `docs/feature-registry.json`.

### Declaring a feature (Lot G, answers 144-146)

Every module carries a `features.ts` beside its routes, imported by its
`index.ts`, calling `feature(key, {...})` from `shared/features` once per
user-facing capability:

```ts
feature('campaigns.landing-pages', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'demand',
  kind: 'FEATURE',            // FEATURE | KILL_SWITCH | EXPERIMENT
  launch: 'on',               // 'dark' for something built but not launched
  description: 'Lot E (Q7/Q106): the AI-drafted landing page ...',
  routes: ['/api/v1/campaigns/:id/landing-page', '/p/:slug'],
  jobs: [],                   // src/jobs file names without .job.ts
  variants: ['classic', 'builder'],   // optional; `variant` on the row must be one
  aliases: [],                // keys it used to answer to
});
```

Keys are `<area>.<capability>`. The longest declared route prefix wins, so a
module's root prefix (`/api/v1/campaigns`) is the safety net under its finer
keys. A job under `src/jobs` must be named by exactly one feature. The console
and the apps declare their surfaces in `features.manifest.json` at their
package roots (checked by each package's `scripts/check-features.mjs`);
`npm run features:sync` folds everything into `docs/feature-registry.json`,
which `ensureFeatureRegistry()` turns into `FeatureFlag` rows at boot. See
`modules/feature-flags/README.md`.

### The cash side of the ledger (Lot B, package B3a)

Every advertiser-wallet movement now goes through `wallets.move` with its
counter-legs, so `verifyLedger` covers advertiser wallets as it already
covered publishers and agents, and the FREEZE_WALLET check is made **inside**
the movement's transaction on the row being written. The legs, credits
positive and debits negative from the account's own point of view:

| Movement | Wallet | ADX account |
| --- | --- | --- |
| Top-up by transfer or cheque | + | `platform:suspense` − until the bank line is matched |
| Top-up by gateway (Lot C: every gateway capture, keyed on the gateway's payment id; the campaign or sale is then settled out of the balance) | + | `platform:cash` − |
| Refund to the original method (Lot C, `payments`): request approved / direct return raised | − | `platform:payables` + |
| Refund to the original method processed by the gateway | — | `platform:payables` − / `platform:cash` + |
| Campaign capture | − | `platform:payables` + (the whole booking; ADX's take is recognised when each day accrues — the **only** place CAMPAIGN_SPEND is posted; the accrual posts none, see `docs/revenue-model.md`) |
| Package sale | − | `platform:revenue` + |
| Goodwill | + (goodwill) | `platform:goodwill` − |
| Campaign refund released / bank-transfer refund approved | + / − | `platform:payables` − / + |
| Withdrawal released in a batch (Lot B, Q140 — approval only reserves) | − | `platform:payables` + |
| Refund or withdrawal paid out | — | `platform:payables` − / `platform:cash` + |
| Bank line matched to a transfer/cheque top-up (`reconciliation`) | — | `platform:suspense` + / `platform:cash` − |
| Dormant credit expired | − | `platform:revenue` + |
| Print job cost approved (Lot B, B4b — `print-partners`) | partner wallet +net | `platform:cost-of-sales` −gross / `platform:tax-withheld` +tax (194C) |

A withdrawal is **reserved** from request through approval and **debited at
release** (Lot B, Q140): `wallets.snapshot` subtracts REQUESTED + APPROVED
lines from `withdrawable` and `spendable`, `move({ requireFunds })` subtracts
the same inside its transaction, and the wallet leg above posts when a payout
batch releases the line (`payouts/batches.service.ts`) — or, for a line paid
by hand outside a batch, at mark-paid. A batch is built by one admin and
approved by another (409 `FOUR_EYES`; the DB CHECK backs it); its status
after release is derived from its lines.

`platform:cost-of-sales` carries B4b's print costs: a partner is paid at cost
approval, per job, and the money leaves through the same withdrawal ladder as
every other party — raised at the desk with `POST /finance/withdrawals/on-behalf`,
because the partner's account cannot sign in — so an offline NEFT is a PAID
withdrawal on the books. The refund desk is two queues under `/finance`:
`campaign-refunds` (owned by `campaigns`) and `refund-requests` (owned by
`advertisers`).

### The two modules that write another's columns

`suspension` owns `PartySuspensionEvent` **and** the five suspension columns on
`Listing`, `Publisher`, `Advertiser` and `AgentProfile`. A suspension is one
act with one record, and four modules each writing their own version of
"suspended" is how those four drift apart. Every other module reads those
columns where its own work needs the answer — the booking gate, the dispatch
sweep, the accrual run — and none of them writes one. `Wallet.frozenAt` stays
with `wallets`, which exports `freezeWallet` for this module to call.

`account-lifecycle` owns `User.closedAt / closeReason / closedById` and the PII
columns an erasure blanks across `User`, `Publisher`, `Advertiser`,
`AgentProfile` and the four KYC records, for the same reason twice over: a
closure is one act with one record, and an erasure has to be atomic across
eight tables or it leaves a half-erased person behind — the one outcome a
DPO-signed request must never produce. Everything it can reach through another
module's index it does: `suspension` stops the work, `listings` retires the
spots, `payouts` raises the final withdrawal, `auth` ends the sessions.

Both are the same exception the `users.deleteUserCascade` note below makes, and
neither is licence for a third: a module writes another's columns only when the
write has to be one act and the alternative is a data-integrity bug.

### Talking to another module

- Import **only** its `index.ts`: `import { createNotification } from '../notifications'`.
  Reaching into `../notifications/notifications.service` is a lint error.
- Do not query another module's tables. If you need data it owns, add a narrow
  export to that module. Several already exist for exactly this:
  `users.getUserDisplayName`, `agents.requireAgentProfile`,
  `listings.setListingAvailability`, `orders.getOrderSummary`,
  `qr.findActiveQrFor`.
- If both modules need each other, invert one direction with a port rather than
  accepting a cycle. E7-3 added three, all filled in `bootstrap/register-modules.ts`:
  `disputes.PartyLookupPort` and `support.RequesterPort` (the party record behind
  a login, composed once from `publishers` / `advertisers` / `agents`'
  `find*LabelsForUsers`, plus the wallet balance and open orders for the
  requester rail) and `kyc.registerKycUserLabelPort` (the reviewer / assignee /
  recorder by name on every KYC case read, from `users.findUserLabels`).
- `shared/` is the bottom of the graph and may never import a module.

### Where Prisma may appear

Only in `prisma-*.repository.ts` files, plus `shared/database`, `jobs/` and
`scripts/` (composition roots). Type-only imports of generated model and enum
types are fine anywhere — they erase at compile time.

### Transactions

A `$transaction` lives in **one** repository method. Do not split one across
repositories to satisfy a boundary rule — that turns a correct write into a
data-integrity bug. `users.deleteUserCascade` is the deliberate example, and
its README says so.

### Naming

| Thing | Pattern |
| --- | --- |
| Module directory | `kebab-case`, plural where it is a collection |
| Files | `<module>.<role>.ts` — `orders.controller.ts`, `orders.schema.ts` |
| Prisma implementation | `prisma-<module>.repository.ts` (the lint rules key off this) |
| Subfeature directory | `kebab-case` verb or stage — `assignment/`, `self-install/` |
| Public surface | `index.ts`, with a comment saying who each export is for |

## Observability (Lot A)

Cross-cutting, so it lives in `shared/` and `bootstrap/`, not in a module:

| Concern | Where | Notes |
| --- | --- | --- |
| Request id | `shared/http/request-id.ts` | First middleware on the app. Accepts a sanitised `x-request-id` or mints one; echoed on every response, on every log line, in the error envelope (`error.requestId`) and on every audit row. Read it as `req.requestId`. |
| Error sink | `shared/errors/error-sink.ts` | `ERROR_SINK=none|webhook|sentry`. Called by the error handler for every 5xx and by every job tick's catch as `reportError(err, { tag })`. Fire-and-forget, 3s ceiling, never throws. |
| Retry-After | `shared/errors/error-handler.ts` | E6: any `ApiError` whose `details.retryAfter` is a number of seconds answers with a `Retry-After` header (whole seconds) — 503 `KYC_PROVIDER_UNAVAILABLE` / DEGRADED today, generic so the next "come back later" refusal needs no route code. |
| System user | `modules/users/` | E6: the account jobs write their audit rows under instead of the first admin — mobile `+910000000000`, name `ADX system`, `isActive: false`, no roles; `ensureSystemUser()` at boot, `systemUserId()` in a job (`kyc-provider-probe`'s `jobActor`, `kyc-purge`, E7-2: `restore-drill`). The first admin stands in only when the account cannot be reached. |
| 5xx-rate alert | `shared/errors/error-rate-alert.ts` | Per-minute Redis counter; at 10 in a minute, one admin notification, then silence for 15 minutes. Leaves `shared/` through `registerServerErrorAlertPort`, filled in `bootstrap/register-modules.ts` from `users.listAdminUserIds` + `notifications.createNotification`. E6: also one field per IST day in the hash `errors:5xx:days`, read back as the 30-day series by `GET /settings/system-health/history` (`readDailyServerErrors`). |
| Readiness | `bootstrap/health.ts` | `GET /health/ready` pings Postgres (`shared/database/ping.ts`) and Redis (`shared/cache/ping.ts`); 503 names the failing part. `GET /health` stays the liveness probe. |
| Platform settings | `modules/app-config/platform-settings.ts` | Lot A (Q31): one `AppConfig` row (`platform`) holding the numbers other modules read on their hot paths — the KYC review SLA, the auto-publish switch, the marketplace floors, the retention windows, the support SLAs, and (Lot B, Q85) the `finance` section — the primary payout rail, its fallback order, the payout ETA, the clearing days and (Lot C, Q88) `opsAuthoriseThreshold`, the campaign total at or above which ops authorising on an advertiser's behalf needs a second admin. `GET/PUT /settings/platform` (ADMIN); the PUT is a deep patch and is audited `PLATFORM_SETTINGS_UPDATED`. Read it through `getPlatformSettings()` from the module index — cached 60s in Redis, invalidated by the PUT. Never read the row directly. Lot J2: the `subscriptions` section — one purchase policy per audience (`publisher`, `advertiser`: cycles and annual discount, change policy and proration, grace, trials, reminder and unpaid-order windows, the rails, auto-renew), read through `getSubscriptionPolicy(audience)` by `revenue`, `packages`, `payments` and `support`; the table is in `app-config/README.md`. GST stays revenue's tax row. |
| Feature flags | `modules/feature-flags/` | Lot A (Q31): the switches, as against the settings above which are the numbers. `isFeatureEnabled(key, subjectId?)` — unknown key false, deterministic `sha1(key+subject) mod 100` bucket, 30s cache. Ops move a flag through `PUT /flags/:key`, which writes a `FeatureFlagChange` and audits `FEATURE_FLAG_CHANGED`. |
| Private files | `modules/uploads/` + `shared/storage/` | Lot D (Q61/Q127): KYC, AGENT_KYC, ADVERTISER_KYC, EMPLOYEE_KYC, USER_KYC, TOPUP_PROOF, DISPUTE_EVIDENCE and INVOICE are stored under a non-public prefix and recorded as `/api/v1/files/:id`; the read is a 302 to a five-minute presigned R2 GET (`shared/storage/presign.ts`, SigV4 by hand) or a local stream. Manual-path KYC images stay until closure and retention; Digio-path images and liveness videos are purged 30 days after verification by `jobs/kyc-purge.job.ts` (daily, Redis-locked, `KYC_IMAGES_PURGED`), keeping the Digio reference, a trimmed payload and the PAN's last four. |
| SMS rails | `shared/sms/` | Lot E (Q128/Q147): `sendSms({ to, kind, vars, body? })` — a caller names one of the nine DLT-registered **kinds** (`kinds.ts`), never a body; the primary rail and the fallbacks come from the integrations row's `sms` section and each adapter (`rails/msg91.ts` Flow API with named variables, `rails/twilio.ts` Messages API with the DLT ids, `rails/third.ts` a stub) renders from its own registration; an unregistered kind logs and returns `{ skipped }`. `parseSmsDeliveryWebhook` reads a rail's report into the common shape (Twilio's signature fails closed). `src/shared/sms/__tests__/sms-call-sites.test.ts` fails on any call that does not name a kind. The masked log and the retry are `notifications`'. |
| Push (FCM) | `shared/push/fcm.ts` | G6 (Q103/133): `fcm.send(token, { notification?, data?, contentAvailable? })` — FCM HTTP v1, no firebase-admin. The service account from `FIREBASE_SERVICE_ACCOUNT_JSON` (raw or base64) signs an RS256 JWT grant with `node:crypto`; the OAuth2 bearer is cached an hour and re-minted on a 401. Unset → `{ skipped: true, reason: 'FCM_NOT_CONFIGURED' }` and one log line; a malformed key → `FCM_MISCONFIGURED`. FCM's own answer is classified (`UNREGISTERED` — the caller deletes the row — `INVALID_TOKEN`, `QUOTA`, `UNAVAILABLE`, `UNAUTHENTICATED`, `FCM_ERROR`); only a dead socket or a refused mint throws. The registry, the dispatcher's channel and the retry are `notifications`'. |
| Zip | `shared/zip/zip.ts` | G6 (Q104): `zipFiles(entries)` — a hand-written ZIP container (DEFLATE entries via `node:zlib`, UTF-8 names, no ZIP64) because the build has no zip library and `node:zlib` alone is not zip; `readZip` is the inverse, for the test. Used by the data export. |
| Vendor probes | `shared/vendors/probe.ts` | Lot D (Q129): `probeDigio` is an authenticated read of a request that does not exist — 404 is up, 401/403/5xx or a dead socket is down; `applyDigioProbe` moves `kyc.kycProvider` DIGIO → DEGRADED and back, never MANUAL. `jobs/kyc-provider-probe.job.ts` runs it every five minutes under a Redis lock and tells every admin when the switch moves (`KYC_PROVIDER_CHANGED`). `app-status`'s services now carry a `kyc` key for the banner. |
| Maps seam | `shared/maps/` | G7 (Q101/132/137): the `MapsProvider` port (`geocode`, `reverse`, `autocomplete`, `placeDetails`, `directions`) with `google.ts`, `mapbox.ts` and, Z-B, `osm.ts` (OpenStreetMap: Nominatim / Photon / OSRM on configurable base URLs, no key, the public Nominatim metered at one request a second through a Redis bucket — `maps:osm:nominatim:public` — 8 s timeouts, OSRM's GeoJSON encoded to precision-5 polyline), chosen by `getEffectiveMapsConfig().provider` at call time; `getMapsClientConfig()` is the client half (`GET /app/maps`) and the one place the "browser key only, never the server key" rule is kept — on OSM it answers the raster tile line (`tileUrlTemplate`, `tileAttribution`, `tileMaxZoom`, `publicTiles`), the tile key substituted only for the public-safe hosts (`OSM_PUBLIC_SAFE_TILE_HOSTS`). All three adapters speak one ApiError vocabulary: no key / refused key 503 `INTEGRATION_NOT_CONFIGURED`, quota (or the OSM usage policy) 429, malformed 400, vendor down 502, "nothing there" null. Mapbox and OSRM answer `two_wheeler` with driving and say so in `modeUsed`. |
| Audience seam | `shared/audience/` | G7 (Q109): the `AudienceProvider` port (`catchment(lat, lng, radiusM, period)` → footfall daily / byHour / byWeekday + demographics ageBands / gender / incomeBands / affinities, `provenance: 'PANEL'`) with `geoiq.ts` (Data Serving `getvariables`, the account's catalogue ids mapped by `audience.geoiqVariables`; no hourly panel → null) and `azira.ts` (footfall insights over a circle and a month; no public host → 503 until the contract's base URL is set). Rule for every adapter: map what the vendor documents, mark the rest null, never invent — the recorded shapes are `__tests__/fixtures/`. Y-B: both vendors at once — `audience.providers` is the enabled set (a legacy `provider` reads as a one-element set), `audienceCatchment` asks every enabled vendor in parallel with each failure isolated (a credential-less vendor skipped; 503 only when none is configured) and `blend.ts` folds the answers by `audience.policy` (footfall Azira-primary AVERAGE, demographics and affinities GeoIQ-primary, fallbacks on) into a `BlendedAudienceCatchment`: the legacy shape plus `provenanceByField` (GEOIQ / AZIRA / BLENDED per group), `vendors`, `agreement.footfall` (1 − \|a − b\| / max) and `rawByVendor`. Nothing stored here; `listings` keeps one raw row per (listing, vendor, month) and blends on read (a policy change is no vendor call); `geo` folds the rows into the city audience profile. README in the folder. |
| Flow editor | `modules/app-config/flow-schema.ts`, `onboarding-template.ts` | Q83/Q148: `GET /config/schema` is the vocabulary the console builds its editor from — the apps' word, not the console's. `PATCH /config/flows/:key` validates a wizard (`listing`) or the ladder (`onboarding`) against it, writes `main:previous` and a `flows.<key>:v<N>` snapshot (five kept), bumps `version`, and audits `APP_CONFIG_UPDATED` with screens/steps added, removed and changed; `PATCH /config/enums/:group` the same for a group. `users` composes `GET /users/me/onboarding-manifest` from `flows.onboarding` (`?version=` pins the template a party started on; `manifestVersion` comes back on the manifest) and falls back to `CODE_ONBOARDING_TEMPLATE`, byte-identical. Campaign launch is not data-driven: it needs a campaign-launch renderer in the apps first. |
| Admin credentials | `modules/app-config/` | Lot A (Q33): the `x-admin-secret` header is **retired**. `PUT /config` and `PUT /app/status` are ordinary `authenticate + requireRole('ADMIN')` routes, `ADMIN_SECRET` is gone from `config/env.ts` and `.env.example`, and every PUT /config keeps the row it replaced as `main:previous` for `POST /config/revert`. |
| Direct database URL | `config/env.ts`, `prisma.config.ts` | Lot E (decision 95): `DATABASE_URL` is the pooled Neon endpoint and the app's; `DIRECT_URL` (optional, falls back to it) is the unpooled one that `prisma migrate` (`prisma.config.ts`'s `datasource.url`), `pg_dump` and `pg_restore` take — a pooler cannot hold a migration's DDL transaction or a dump's single session. The client is unaffected: Prisma 7 connects through the pg adapter on `DATABASE_URL`. |
| Backups and the drill | `shared/backup/`, `scripts/backup.ts`, `scripts/restore.ts`, `modules/ops/`, `jobs/restore-drill.job.ts` | Lot E (decision 95: RPO 1 h / RTO 4 h; Neon PITR is the RPO, the nightly dump is what survives Neon). `npm run backup`: `pg_dump -Fc` over `DIRECT_URL`, gzip, AES-256-GCM under `BACKUP_KEY`, to private storage as `backups/<instant>.dump.enc`, 35-day rotation — prints names and sizes, never a URL or the key. `npm run restore -- <scratch-db> [dump]` unseals into a scratch database and refuses the production name. The monthly drill restores the newest dump into `DRILL_DATABASE_URL` (skips with a warning when unset), runs the ledger verify on it, writes `ops:last-drill`, audits `BACKUP_DRILL_RUN` and tells every admin on failure. The runbook is `docs/runbooks/backup-restore.md`; on call is every ADMIN until a rota. |
| Retention sweep | `jobs/retention.job.ts` → `modules/ops/retention.service.ts` | Lot E (decisions 95/126): daily, Redis-locked. G6 (Q104): also `account-lifecycle.purgeExpiredDataExports` — a READY data export past its seven days loses its file and becomes EXPIRED, the one thing the sweep removes (a copy the person already has). `ErasureRequest` PENDING past `dueAt` → every admin told once (`ops:erasure-due` remembers). DONE past `retainUntil` (eight financial years from the FY end — the DPO permission sits with the super admin for now) → the `ops:retention-due` report row listing whose financial rows may now be destroyed. **No automatic destruction**: the ledger is append-only and a person decides. The `NotificationDelivery` purge is E1's. |
| KYC escalation by age | `jobs/kyc-escalation.job.ts` → `modules/kyc/escalation.service.ts` | Lot G (Q127/142): daily under a day lock, under the system user. A publisher or advertiser case still PENDING after `kyc.escalationSlaMultiplier` × `kyc.reviewSlaHours` (2 × 48 h by default) is escalated to a member of the Compliance pool (source AGE), who is told; `KYC_ESCALATED`. The same columns are set by a reviewer's button on either queue (REVIEWER) and by a fraud case opened against the party (FRAUD_LINK, from `fraud.openCaseRecord`); the desk's decision clears them. |
| Fraud signal scan | `jobs/fraud-signal-scan.job.ts` → `modules/fraud/fraud-signals.service.ts` | Lot G (Q118/138): daily under a day lock, under the system user. Every party (each type bounded by `fraud.scanLimitPerType`) is run through the thirteen signals; a signal above `fraud.scanThreshold` (0.6) on a party with no open case opens a `SIGNAL_SCAN` case, scored, and tells every admin once. **Never suspends** — a case is a question, and a suspension is a person's answer. |
| Weekly payout draft | `jobs/payout-batch-draft.job.ts` → `modules/payouts/batch-draft.service.ts` | Lot G (Q124): every five minutes, Redis-locked, heartbeat `payout-batch-draft`; on the first tick at or after the week's slot (`finance.payoutBatchCadence`: weekday + Indian hour, Monday 10:00 by default; a per-slot key makes it once) one DRAFT `PayoutBatch` from every APPROVED withdrawal in no open batch, as the system user, through the same `createBatch` / `setBatchLines` a person uses; audited `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE`; one PAYOUT notification to every admin holding `finance.approve`. Nothing drafted when nothing is draftable; **never submits, approves or releases**. `GET /finance/payout-batches/schedule` answers the cadence, `nextRunAt` and the last draft. |
| Print quote expiry | `jobs/print-quote-expiry.job.ts` → `modules/print-partners/print-quotes.service.ts` | Lot H (Q147): hourly tick, once per Indian day (Redis day key), heartbeat `print-quote-expiry`; every OPEN `PrintQuoteRequest` past its deadline with no quote and never re-invited gets 48 more hours and its invited partners told again (`PRINT_QUOTE_REQUEST_REOPENED`); with no quote after that it is EXPIRED and ops told; with quotes standing it stays OPEN for ops to award and ops are reminded. A default awaiting the owner's later round on deadlines. |
| Publisher subscriptions | `jobs/publisher-subscription.job.ts` → `modules/revenue/publisher-plans.service.ts` | Lot J (B1): hourly tick, once per Indian day, heartbeat `publisher-subscription`; the expiring notice `reminderLeadDays` before a term ends (once per subscription; with auto-renew on it names the wallet charge), the ended notice the day it lapses with nothing in force after it, and PENDING_PAYMENT orders older than `unpaidOrderExpiryDays` expired. Lot J2 (6): while `settings.subscriptions.publisher.autoRenew.allowed` is on, every lapsed subscription with `autoRenew` on is renewed from the wallet — the next order on the same tier and cycle, the same keyed debit and activation, `SUBSCRIPTION_RENEWED`; a short wallet gets `SUBSCRIPTION_RENEWAL_FAILED` once and the row lapses into grace; the queued order's existence makes it never charge twice. |
| Package renewals | `jobs/package-renewal.job.ts` → `modules/packages/packages.service.ts` | Lot J2 (6): the advertiser twin — hourly tick, once per Indian day, heartbeat `package-renewal`; the in-app reminder `reminderLeadDays` before a sale ends (once per sale), and while `settings.subscriptions.advertiser.autoRenew.allowed` is on, every lapsed sale with `autoRenew` on renewed through `advertisers.payForPackage` and `packages.markPaid` (the next sale on the same tier, add-ons and cycle at today's catalogue, no agent, the terms not asked again), `SUBSCRIPTION_RENEWED` or `SUBSCRIPTION_RENEWAL_FAILED` once. The five-minute expiry in `campaign-lifecycle` still flips the row to EXPIRED. |
| City wind-down | `jobs/city-winddown.job.ts` → `modules/geo/winddown.service.ts` | Lot V: hourly tick, Redis-locked (`lock:city-winddown-tick`, 50 min), heartbeat `city-winddown`, as the system user; every WITHDRAWN city whose `WIND_DOWN_DONE` marker event is older than its `withdrawnAt`: ACTIVE listings off the market through `listings.unpublishListing` (cause CITY_WITHDRAWN) with each publisher told once, running campaigns left to complete, open leads LOST through `leads.closeOpenLeadsInCity` ("city withdrawn" on the thread), active agents told once; then the marker and `CITY_WOUND_DOWN`. No day key — a city withdrawn at noon is down by one. |
| Live-chat SLA | `jobs/live-chat-sla.job.ts` → `modules/support/live-chat.service.ts` | Lot I: every minute, Redis-locked (50 s, shorter than the interval), heartbeat `live-chat-sla`. An OPEN LIVE_CHAT past `support.liveChat.firstResponseTargetSec` with no agent reply publishes a `breach` on `support:inbox` and pushes every online operator `LIVE_CHAT_BREACH` — once per chat, a Redis claim key is the once. An OPEN LIVE_CHAT nobody is assigned to whose requester last spoke 30 minutes ago is converted to a TICKET with a SYSTEM line and the requester told (`LIVE_CHAT_CONVERTED`); a chat an operator holds is left alone. |
| Job heartbeats | `shared/jobs/heartbeat.ts` | Lot E: every interval job calls `recordHeartbeat(name)` at the top of its tick — before the lock, so an idle-but-alive job still answers — into one Redis hash; `GET /settings/system-health/ops` reads them back with `stale` past 180 minutes. A new job adds its name to `JOB_NAMES` so the page can show it before its first tick.  Lot G (Q130): `jobs/health-sample.job.ts` reads the same hash every five minutes and writes the JOBS sample — `ok` only when every name is fresh. |
| Request latency | `shared/logging/request-latency.ts` | Lot G (Q130): the request logger drops every request's duration into a Redis list keyed by the UTC minute it finished in (three-minute TTL — a window, never a log); `readPreviousMinuteLatency` answers the completed minute's p95 and count, which `ops`' sampler writes as the API's own `HealthSample`. |
| Storage probe | `shared/storage/storage.ts` → `probeStorage` | Lot G (Q130): one HEAD on the bucket (R2) or an access check on the private folder (local), bounded at five seconds, never throwing; the result carries the provider, the latency and a class of failure with any URL masked — it is written to a table every admin reads. |
| Permissions | `shared/auth/permissions.ts` | The catalogue, generated from one table: `<group>.<tier>` plus seven named capabilities. `PERMISSIONS`, `PERMISSION_GROUPS` (the console matrix), `isPermission`. A `RoleConfig` stores ids from here; `requirePermission(...)` in `shared/auth/authenticate.ts` enforces them off the token's `perms`; `tests/contract/permission-catalogue.test.ts` fails on any id `src/` names that the catalogue does not have. |
| Session revocation | `shared/auth/revocation.ts` | An access token is a signed claim and cannot be withdrawn, so `auth.revokeSessions(userId, reason)` writes `auth:revoked:<userId>` = the moment, TTL one access-token lifetime, and `authenticate()` refuses any token with an older `iat`. Memoised 10s per process; **fails open** if Redis is unreachable. |
| Impersonation guard | `shared/auth/authenticate.ts` | A token carrying `act` may only be used on GET/HEAD/OPTIONS — 403 `IMPERSONATION_READ_ONLY`, centrally, so no route can forget. |
| Closure and erasure | `modules/account-lifecycle/` | Lot A (Q21/Q60): an account with history is **closed, never deleted** — `DELETE /users/:id` refuses with `USER_HAS_HISTORY` and names this path. `GET /users/:id/closure-review` lists what is standing in the way; only money in flight, a running order and a live campaign actually refuse. Closing suspends every profile on four scopes, stamps `User.closedAt`, revokes the sessions, retires the listings and asks for one final vetted withdrawal. Erasure is a separate DPO-signed step behind `dpo.erasure`, keeps every financial row until `retainUntil`, and leaves a hashed `MobileTombstone` so a re-registration can be told apart from a new person. |
| Audit trail | `shared/audit/` | `logActivity` (two signatures — see the file), `auditDiff`, `findActivity`, and `auditAdminWrites`: the app-level tap that writes a generic row for every successful ADMIN write nobody logged by hand. Read back through `modules/audit`. `tests/contract/admin-write-audit.test.ts` pins that the tap covers every ADMIN write route. |

## Testing

```bash
npm test                      # everything
npm run typecheck             # src + tests + scripts
npm run arch                  # dependency-cruiser + eslint boundary rules
npm run build                 # production tsc
npm run routes:snapshot       # regenerate docs/route-inventory.json

npx vitest run src/modules/orders     # one module
```

Three gates protect the refactor and should protect future changes too:

- `tests/architecture/route-inventory.test.ts` — diffs the live router tree,
  **in order**, against `docs/route-inventory.json`.
- `tests/contract/permission-catalogue.test.ts` — every permission id named
  anywhere in `src` exists in the catalogue.
- `tests/contract/impersonation.test.ts` — an impersonation token is refused on
  every authenticated write route.
- `tests/contract/auth-topology.test.ts` — drives all 168 routes: every
  authenticated route must reject a missing and a malformed token, every
  role-guarded route must reject a role outside its guard, and the six
  deliberately public endpoints must stay public.
- `npm run arch` — no cycles, no deep cross-module imports, no Prisma outside a
  repository, no `shared/` importing a module.

## Surfaces that look legacy and are not (Lot E, decision 131)

Two prefixes predate the lots and read like leftovers. They are live, by
decision 131, and are not to be tidied away:

| Surface | What it is now |
| --- | --- |
| `/user-kyc/*` | The **liveness** record — a self-recorded video per user, reviewed at the desk (`modules/kyc/user/`). It is the gate every party's KYC carries, not a fifth party type. |
| `/onboarding/*` (flow templates and submissions) | The **agent and employee intake**: an APPROVED submission for user type AGENT or EMPLOYEE provisions the profile through `agents.createAgent` / `employees.createEmployee` (`modules/onboarding/`). Publisher and advertiser onboarding runs through the QR claim flow in `publishers` / `advertisers`; this is the back-office door for staff. |

The one surface that really was retired — the `/advertisements` module and
the `Advertisement` table — went in Lot D (Q94); artwork is `CampaignCreative`
under `modules/campaigns/` and there is no `/advertisements` route in the
inventory.

## Migration status

Every file from the pre-refactor tree. Nothing is left behind:
`src/controllers/`, `src/routes/`, `src/services/`, `src/lib/`,
`src/middleware/` and `src/constants/` no longer exist.

| Old file | Now |
| --- | --- |
| `app.ts` | `app.ts` (thin) + `bootstrap/create-app.ts` |
| `server.ts` | `server.ts` + `bootstrap/graceful-shutdown.ts` |
| `config/env.ts` | `config/env.ts` |
| `config/loadEnv.ts` | `config/load-env.ts` |
| `constants/appEnums.ts` | `modules/app-config/app-enums.ts` |
| `lib/errors.ts` | `shared/errors/api-error.ts` + `shared/http/async-handler.ts` |
| `lib/logger.ts` | `shared/logging/logger.ts` |
| `lib/prisma.ts` | `shared/database/prisma.ts` |
| `lib/redis.ts` | `shared/cache/redis.ts` |
| `lib/zod.ts` | `shared/validation/zod.ts` |
| `middleware/authenticate.ts` | `shared/auth/authenticate.ts` + `shared/auth/jwt.ts` + `shared/auth/express.d.ts`; `requirePublisherOnboarded` **deleted** (dead, and business logic in middleware) |
| `middleware/captcha.ts` | `shared/security/captcha.ts` |
| `middleware/errorHandler.ts` | `shared/errors/error-handler.ts` |
| `middleware/notFound.ts` | `shared/errors/not-found.ts` |
| `middleware/rateLimit.ts` | `shared/security/rate-limit.ts` |
| `middleware/requestLogger.ts` | `shared/logging/request-logger.ts` |
| `routes/index.ts` | `bootstrap/register-modules.ts` |
| `routes/*.ts` (20 files) | each module's `*.routes.ts` |
| `controllers/advertisement.ts` | removed — Lot D (Q94) dropped the Advertisement table; artwork is `CampaignCreative` under `modules/campaigns/` |
| `controllers/advertiserKyc.ts` | `modules/kyc/advertiser/` |
| `controllers/agent.ts` | `modules/agents/` |
| `controllers/auth.ts` | `modules/auth/{otp,password,tokens,publisher}/` (`google/` added later) |
| `controllers/banking.ts` | `modules/banking/` |
| `controllers/config.ts` | `modules/app-config/` |
| `controllers/digio.ts` | `modules/publishers/kyc/digio.controller.ts` |
| `controllers/earnings.ts` | `modules/earnings/` |
| `controllers/employee.ts` | `modules/employees/` (+ `employees.policy.ts`) |
| `controllers/integrations.ts` | `modules/integrations/` (+ `.mapper.ts`, `.schema.ts`) |
| `controllers/milestone.ts` | `modules/agents/milestones/` |
| `controllers/notification.ts` | `modules/notifications/` |
| `controllers/onboarding.ts` | `modules/onboarding/` |
| `controllers/order.ts` | `modules/orders/` + `modules/orders/tracking/` |
| `controllers/orderMilestone.ts` | `modules/order-milestones/` |
| `controllers/publisher.ts` | `modules/publishers/` + `modules/listings/` |
| `controllers/qr.ts` | `modules/qr/` |
| `controllers/rolesConfig.ts` | `modules/access-control/` |
| `controllers/support.ts` | `modules/support/` |
| `controllers/upload.ts` | `modules/uploads/` (+ `.middleware.ts`) |
| `controllers/user.ts` | `modules/users/` |
| `controllers/userKyc.ts` | `modules/kyc/user/` |
| `services/activityLog.service.ts` | `shared/audit/activity-log.ts` |
| `services/digio.service.ts` | `modules/publishers/kyc/digio.service.ts` |
| `services/earnings.service.ts` | `modules/earnings/` |
| `services/integrationConfig.service.ts` | `shared/integrations/integration-config.ts` |
| `services/loginSecurity.service.ts` | `modules/auth/password/login-security.service.ts` |
| `services/mail.service.ts` | `shared/email/mail.ts` |
| `services/milestone.service.ts` | `modules/agents/milestones/` |
| `services/notification.service.ts` | `modules/notifications/` |
| `services/order.service.ts` | `modules/orders/{placement,assignment,scheduling,fulfilment,verification}/` |
| `services/orderAssignment.service.ts` | `modules/orders/assignment/` |
| `services/orderMilestone.service.ts` | `modules/order-milestones/{templates,plans,order,agent}/` |
| `services/otp.service.ts` | `modules/auth/otp/` |
| `services/password.service.ts` | `modules/auth/password/` |
| `services/publisher.service.ts` | `modules/publishers/` + `modules/listings/` |
| `services/qr.service.ts` | `modules/qr/` (+ `qr.token.ts`, `qr.ports.ts`) |
| `services/resend.service.ts` | `shared/email/resend.ts` |
| `services/sms.service.ts` | `shared/sms/sms.ts` |
| `services/storage.service.ts` | `shared/storage/storage.ts` |
| `services/support.service.ts` | `modules/support/` |
| `services/token.service.ts` | `modules/auth/tokens/` (signing moved to `shared/auth/jwt.ts`) |
| `jobs/publisherTimer.ts` | `jobs/publisher-timer.job.ts` |
| `scripts/createUser.ts`, `scripts/seedConfig.ts` | unchanged location, imports repointed |

## What did not change

The Prisma schema, every migration, and all 167 API routes — their paths,
methods, middleware order, status codes and response bodies. The frontend was
not touched.
