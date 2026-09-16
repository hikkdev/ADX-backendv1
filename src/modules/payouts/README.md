# payouts

DR 04's money: what a party has earned, and how it leaves.

## What lives here

| Concern | File |
| --- | --- |
| Payout methods — bank and UPI, and proving they are the party's | `payouts.service.ts` |
| The withdrawal ladder — request, vet, approve (reserve), release, pay, fail | `payouts.service.ts` |
| Payout batches — built, signed off by a second admin, released; ADX's bank accounts | `batches.service.ts`, `batch-status.ts` |
| Daily accrual of publisher earnings | `accrual.service.ts` |
| Agent incentives, and the ops check before they are credited | `incentives.service.ts` |
| The tiered caps and the tax rates | `rules.service.ts` |
| How money actually moves — the rails, and which one the settings choose | `rail.ts` |
| The wire shapes the finance controllers share (masked methods, lines, batches) | `payouts.shape.ts` |

Wallet primitives are next door in `../wallets`; double entry is in `../ledger`. This module
decides *whether* money should move and *how much*. It never touches a balance directly.

## The decisions this is built to

These came out of the DR 04 walkthrough and are not defaults. Changing one is a product decision,
not a refactor.

**Earnings accrue daily.** Not at install, not at campaign end. Each day of a flight that finishes
adds that day's share to the publisher's wallet, and each day clears seven days later. So a
publisher's balance has a cleared part and a pending part, and both belong on screen.

**Nothing is auto-approved.** A person vets every withdrawal and every incentive, whatever the
amount. There is deliberately no threshold anywhere in this module — its absence is the feature.

**Tax is withheld when income is credited**, not when it is withdrawn. A wallet already holds
net-of-tax money, so a withdrawal deducts nothing. The columns to withhold at payout exist for a
policy that changes its mind, and are zero.

**Daily caps are tiered by party and tenure.** Individual publishers start at ₹5,000 a day and
reach ₹50,000 after a year; smaller agencies start at ₹50,000; larger ones at ₹1,00,000, and their
middle rung is at six months rather than three. Rows, not constants — these have already changed
once.

**No vendor lock.** `PayoutRail` has a manual/NEFT implementation that finance drives by hand, and
Razorpay X and Cashfree both sit behind the same interface awaiting an account. `railFor` prefers a
configured vendor and falls back to manual, so losing a vendor degrades to a slower path rather
than to an outage.

## Lot J2 (f): the wallet read opens a publisher wallet

`GET /payouts/wallet` answers a **zero snapshot** to a publisher who has
never earned — `walletForUserOrOpen` opens the wallet (and its ledger
account) on that first read through `wallets.ensureWallet`, the way the
advertiser path does — rather than the old 404 "one opens when you first
earn", so the subscription pay sheet can offer the wallet rail honestly. An
agent or a print partner with no wallet still gets the 404: theirs are
opened by the credit that pays them.

## Lot A: suspension

Two scopes reach this module, and both are enforced here rather than trusted to
the caller.

- **STOP_ACCRUAL.** `findAccruableSpots` excludes any spot whose listing
  carries it, and `runDailyAccrual` re-checks before crediting, so a spot read
  before the scope landed is still skipped. A publisher's STOP_ACCRUAL is
  cascaded onto their listings by `modules/suspension`, so the run only ever
  has to read a listing. The days are not earned later either: the run is keyed
  on (spot, day) and simply never writes the suspended ones.
- **FREEZE_WALLET.** `requestWithdrawal` and `approveWithdrawal` both refuse
  409 `WALLET_FROZEN` — both, because a request raised before the freeze must
  not walk through approval afterwards. `withdrawalAllowance` carries
  `frozenAt` so the screen can say why the maximum is academic. Credits are
  untouched: an accrual or an incentive still lands on a frozen wallet, so a
  publisher under review is not quietly under-paid for the days they worked.

## Lot A: the last withdrawal of a closing account

`requestClosingWithdrawal(walletId, { userId })` is what `account-lifecycle`
calls when a closed account still holds money (Q21). It skips three of the
ordinary rules and each for the same reason — they exist to pace a *running*
account. A daily cap would leave a closed wallet trickling out over weeks with
nobody left to press the button; the minimum would strand a small balance for
ever; and the wallet's freeze is the closure's own doing, so honouring it would
mean a closure could never pay anybody back.

What it does not skip is the half that protects the money: the destination must
be a VERIFIED payout method (the default one, where there is a default), and a
person still vets the request. It creates a `REQUESTED` row and nothing else.
Holds and the clearing window are respected too, because that money is not the
party's to take yet — when they swallow the balance it answers
`NOTHING_WITHDRAWABLE` and the closure records that on the case.

## Lot B (B1): what a day is worth, and whose commission

**Gross is rate × quantity.** `grossForDay` in `accrual.service.ts`. The run
split the unit rate alone until this landed, so a publisher with three panels
booked on one listing was paid for one. The fix is forward-only; the days
already paid short are put right by the backfill below.

**The commission is the spot's stamp.** `CampaignSpot.commissionPct` and
`commissionSource` are written once, at authorisation, by the quote that
priced the review (`campaigns.checkout`), and the accrual reads them —
`commissionRatePct` on the `EarningAccrual` is the stamp × 100 for the
Decimal(5,2) column, `commissionSource` is copied across. A rate change next
month never re-rates a running flight. A spot authorised before the stamp
existed is resolved **once, at the campaign's start** — the rate that would
have been stamped — through `CommissionResolverPort` (`commission.port.ts`),
which bootstrap fills from `revenue.commissionForListing`, and the accrual
records `RESOLVED_AT_ACCRUAL`. Unregistered, the port refuses: the run skips
that spot, logs it, and every stamped spot still accrues. There is no default
percentage in this module any more; the last one was the bug.

**The accrual posts no advertiser-side spend leg.** B3a posts `CAMPAIGN_SPEND`
when the hold is captured — wallet − / `platform:payables` + for the whole
booking — and the accrual releases each day's gross out of payables. Posting
spend here as well would count the booking twice. `docs/revenue-model.md`
records the choice.

### The quantity backfill (Q135)

```
POST /finance/accruals/quantity-backfill   ADMIN + finance.approve — { dryRun: true } lists, { dryRun: false } corrects
```

`quantityBackfill` in `accrual-backfill.service.ts`. A candidate is a spot at
quantity > 1 with accrued days whose posted gross equals the unit rate. The
dry run (the default) lists each with the days, the gross posted, the gross
due and the missing gross / commission / tax / net, split under the rates the
day was accrued at. The execute posts **one `ADJUSTMENT` per spot** — wallet
+net, `platform:payables` −gross, `platform:revenue` +commission,
`platform:tax-withheld` +tax, exactly the accrual's own split — keyed
`accrual-quantity-fix:<spotId>`, writes `ACCRUAL_QUANTITY_CORRECTED` against
the `CampaignSpot` with both figures in the diff, and sends the publisher a
`PAYOUT` notice (`PUBLISHER_ACCRUAL_CORRECTED` in its subtitle). The accrual
rows themselves stand as history. Idempotent on the audit row: a spot with
one is skipped whatever its accrual rows say, and a spot the wallet refused
gets no row so the next run offers it again. Each run — dry or not — is
itself audited `ACCRUAL_QUANTITY_BACKFILL_RUN`.

## The ledger convention

A wallet account is signed from the party's point of view: positive means the party has money.
`platform:payables` is its mirror, so its running total is the negative of every wallet balance.
Every movement pairs the two and balances to zero.

An earning splits four ways — payables releases the day's gross, the publisher gets net, ADX keeps
commission, the tax authority is owed the rest:

```
platform:payables      −gross
wallet                 +net
platform:revenue       +commission
platform:tax-withheld  +tax
```

`platform:cash` enters when the money actually leaves (Lot B): **release** moves the obligation
from the wallet to payables (`wallet −net / payables +net`, keyed `withdrawal:<id>`), and mark-paid
discharges it against cash (`payables −net / cash +net`, keyed `withdrawal-paid:<id>`) — the two legs a
bank line reconciles against. The same pair closes a bank-transfer refund on the advertiser side.

## Lot B (Q140): approval reserves, release debits

The withdrawal's states, and what each one means for the money:

| Status | Wallet | Books | How it gets there |
| --- | --- | --- | --- |
| `REQUESTED` | counted in `openWithdrawals`; off `withdrawable` and `spendable` | nothing | the party asks (`POST /payouts/withdrawals`) |
| `APPROVED` | **reserved** — still in the balance, still off `withdrawable` and `spendable`; `reservedAt` set | nothing | a person vets it (`POST /finance/withdrawals/:id/approve`): the cleared-balance check, the freeze check, the rail chosen; **no debit** |
| `PROCESSING` | debited: `wallet −net / payables +net`, `ledgerTransactionId` set | PAYOUT legs posted | a batch releases it, or a vendor rail takes it |
| `PAID` | — | `payables −net / cash +net` | finance confirms the UTR (`mark-paid`, on the queue or on the batch line); a reserved line paid by hand is debited first |
| `FAILED` | credited back: `wallet +amount / payables −amount` (`withdrawal-failed:<id>`) | the reversal | the transfer bounced (`fail`) — only from PROCESSING; an APPROVED line is *rejected*, not failed |
| `REJECTED` | un-reserved: `reservedAt` and `batchId` cleared | nothing | from REQUESTED or APPROVED; refused while its batch is past IN_REVIEW |
| `CANCELLED` | — | nothing | the party pulls a REQUESTED row |

Why: a batch that fails half-way then has nothing to reverse, every reversal is of one line's own
movement, and the party cannot spend what is on its way to the bank. `wallets.snapshot` counts
`REQUESTED` + `APPROVED` as `openWithdrawals` (a PROCESSING line has already left the balance) and
`move({ requireFunds })` subtracts the same reservation inside its transaction.

## Lot B (Q85/Q140): payout batches — `/finance/payout-batches`

Approved lines are paid together. `batches.service.ts`:

| Step | Route | Rule |
| --- | --- | --- |
| build | `POST /` → DRAFT (`BATCH-<year>-<n>`, own counter in the repository), rail from `finance.primaryRail` unless named, `bankAccountId` must be an active ADX account | |
| lines | `PUT /:id/lines { withdrawalIds }` | DRAFT only; every id must be APPROVED, on a VERIFIED method, in no other open batch — refused whole with `details.problems` |
| submit | `POST /:id/submit` → IN_REVIEW | needs at least one line |
| approve | `POST /:id/approve` → APPROVED (`finance.approve`) | **four eyes**: 409 `FOUR_EYES` when the approver built it; the DB CHECK backs it |
| preflight | `GET /:id/preflight` | per line: method VERIFIED, KYC VERIFIED, `User.isActive`, wallet still covers, not frozen (the closure marker excepted); once: rail configured, `verifyLedger` healthy |
| release | `POST /:id/release` (`finance.approve`) | refuses on a failed preflight, moves nothing. Then per APPROVED line: the debit + PAYOUT legs (`debitForRelease`, idempotent on the withdrawal), PROCESSING. Manual rail: the bank bulk-transfer CSV (beneficiary, account, IFSC, amount, narration = WDR reference, email, mobile) stored via `uploads.storeGeneratedFile` as `exportFileId`. Vendor rail: `rail.pay` per line; FAILED reverses that line at once. Allowed again from RELEASING so a release that died half-way can finish — lines already out are skipped |
| after | `POST /:id/lines/:withdrawalId/mark-paid { utr }`, `.../fail { reason }` (`finance.approve`) | reuse `markWithdrawalPaid` / `failWithdrawal`; the batch's status is then **derived**: COMPLETED when every line is PAID, FAILED when every line bounced, PARTIALLY_FAILED between, RELEASED while any is with the rail (`batch-status.ts`, also run when a line is paid or failed on the queue) |
| cancel | `POST /:id/cancel` | DRAFT / IN_REVIEW / APPROVED only; lines go back to APPROVED-reserved and unbatched |
| file | `GET /:id/export` | the CSV, regenerated from the lines — the same bytes as the stored file, and a preview before release |
| export | `GET /export.csv?status=&q=` (ADMIN) | G13-B: the batches under the list's filters, newest first, one CRLF line per batch — `reference, status, rail, lineCount, totalNet, createdBy, approvedBy, submittedAt, approvedAt, releasedAt, completedAt, createdAt, note` (the actors by name, the id when there is none; blanks for nulls). The same list read walked page by page (at most `BATCH_EXPORT_MAX_ROWS`, 5000), so it never disagrees with the desk. Audited `PAYOUT_BATCHES_EXPORTED` (the filters and the row count) before the first byte. Registered ahead of `/:id` |
| list | `GET /?status&q&page&pageSize` | the list contract, counts by status |
| schedule | `GET /schedule` | Lot G (Q124): `{ enabled, weekday, hourIst, nextRunAt, lastDraft }` — the weekly draft's cadence as set on the platform settings row, the next instant the job drafts (null while off), and the last batch the schedule built (`{ batchId, reference, status, lineCount, totalNet, createdAt }` or null). Registered ahead of `/:id` |

**The weekly draft (Lot G, Q124)** — `batch-draft.service.ts` and
`jobs/payout-batch-draft.job.ts`. `finance.payoutBatchCadence` on the platform
settings row (`{ enabled: true, weekday: 1, hourIst: 10 }`: Sunday 0 … Saturday 6,
the Indian hour) names one slot a week. The job ticks every five minutes under a
Redis lock, heartbeats `payout-batch-draft`, and on the first tick at or after the
week's slot (`lastSlot`; a per-slot Redis key makes it once, so a process that
started at noon on Monday still drafts Monday's batch) builds **one DRAFT** from
every APPROVED withdrawal on a VERIFIED method that sits in no open batch
(`findDraftableWithdrawals`: unbatched, or left behind by a batch past release
or cancelled), oldest request first, at most 500 lines (`moreWaiting` says when
more were left for the next draft), through the same `createBatch` +
`setBatchLines` a person uses — so every rule those enforce still holds — with
the note `Drafted by the weekly payout schedule — <IST stamp>` and the **system
user** as `createdByUserId`. Audited `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE` against
the batch with the diff of status / lineCount / totalNet and the line ids; then
one PAYOUT notification to every admin holding `finance.approve` (the super
admin holds every permission), naming the batch. No draftable line means no
batch and no notice. **Nothing here submits, approves or releases** — the draft
is what a person would have built on Monday morning, and four eyes and the
release stay theirs; a set of lines that refuses to attach (a line moved
between the read and the attach) cancels the empty draft rather than leaving it
for someone to wonder about.

`GET /finance/withdrawals` gained `q` (reference, UTR or party name), `partyKind`, `from`/`to`
(requested-at) and `batchId`; every row now carries `partyKind`, `partyName`, `reservedAt` and
`batchId`. `GET /finance/withdrawals/summary` is the queue's header: rows per status and
`processingOver24h`.

**E6 — the finance desk gaps.** `GET /finance/wallets` rows carry `frozenAt` / `frozenReason`;
`GET /finance/withdrawals` rows carry `walletFrozen: boolean` and the query takes `walletId`,
`publisherId`, `agentId` (the profile behind the wallet) and `paidFrom` / `paidTo` (on `paidAt`);
`GET /finance/withdrawals/summary` adds `reservedTotal` (gross of REQUESTED + APPROVED — what the
wallets hold back), `processingTotal` (net of PROCESSING — what the rail is carrying) and
`paidThisMonth` (net PAID inside the current IST calendar month), all decimal strings.
`GET /finance/payout-batches` rows and `GET /finance/payout-batches/:id` carry `createdBy { id, name }`
and `approvedBy { id, name } | null`, looked up through the `UserLabelPort` bootstrap fills from
`users.findUserLabels` (this module sits underneath `users`, so it cannot import it; unregistered,
the names are null). T-B: every write on a batch — `POST /finance/payout-batches`,
`PUT /:id/lines`, `POST /:id/submit`, `/approve`, `/release` (its `released` / `failed` / `skipped`
counters beside the view), `/cancel` — answers that same detail view (`batchDetailView` in the
controller: the shaped batch, its bank account, its lines, `createdBy`, `approvedBy`), so the desk
updates the batch it holds from the answer. `GET /finance/incentives` rows carry `publisherId` and `advertiserId` and the
query takes `?event=` (comma list) and `?q=` (the note, the order id or the agent's name).
`GET /finance/ledger` takes `?kind=` (comma list), `?from=&to=` (occurredAt) and `?amount=` (a leg of
exactly that absolute value). `POST /finance/withdrawals/on-behalf` keeps its `note` on the row as
`decisionNote` as well as in the audit metadata.

**ADX bank accounts** — `GET`/`PUT /finance/bank-accounts`: what a batch is drawn on and a statement
is imported for. The whole number arrives on the PUT and only `•••• 1234` is stored; one default, and
setting it clears the rest. Audited `BANK_ACCOUNT_CREATED` / `BANK_ACCOUNT_UPDATED`.

**Rails** — `finance.primaryRail`, `finance.railFallbackOrder`, `finance.payoutEtaHours` and
`finance.clearingDays` live on the platform settings row (`PUT /settings/platform`). `railFor(preferred)`
reads them: a named preference if configured, then the primary, then the fallback order, and manual —
always last, always available, and chosen the moment it is reached. `pickRail` is the pure form.

## Lot A (Q21), finding (c): the closure's own payout

`requestClosingWithdrawal` writes `CLOSURE_WITHDRAWAL_MARKER` into `decisionNote` on the row it
raises. `approveWithdrawal` reads it (`isClosureWithdrawal`) and, for that one row, skips the freeze
check; `debitForRelease` reads it again and tells `wallets.move` to `allowFrozen` — the freeze is the
closure's doing, so honouring it would mean a closure could never pay anybody back. Every other
withdrawal on a frozen wallet is still refused, at approval, at preflight and at release. The marker
survives the decision, which is why release can read it.

## Lot B (Q11/Q109): IFSC

`GET /payouts/ifsc/:code` answers `{ ifsc, bank, branch, city, state, neft, imps, rtgs, found }` from
the public directory (`shared/integrations/ifsc-client.ts`, 3 s timeout, cached 30 days), 503 when the
directory did not answer. `addMethod` runs the same lookup: a known code stores the directory's bank,
`bankBranch` and `ifscVerifiedAt`; an unknown one is refused 400 `IFSC_UNKNOWN`; no answer lets the
typed bank stand, unverified. `RAZORPAY_X_KEY` / `CASHFREE_PAYOUT_KEY` are declared in `config/env.ts`
and `.env.example`; `rail.ts` still reads them raw so a test can flip a rail without re-parsing the env.

## Lot B (Q101/Q102/Q134): the agent's commissions — package B3b

Two more events in the rate table, seeded with the rest: `INSTALLATION` at ₹1,450 and
`ADVERTISER_ONBOARDED` at ₹2,000 (the twin of `PUBLISHER_ONBOARDED`). `POST /finance/incentives`
and `POST /finance/incentive-rates` admit both; `GET /finance/incentives?orderId=` is the per-order
facet — "what was this order's commission?".

**`installationFeeFor(order, tier)`** is the one resolver for what an installation is worth. It
reads the platform's `installation.commissionMode` (`getPlatformSettings()`): `FLAT` pays the
INSTALLATION rate at the agent's tier; `PER_ORDER` pays `Order.agentFeeAmount` — the figure ops
typed at assign or print-ready — and falls back to the flat rate when nobody typed one. A settings
read that fails falls to FLAT too. Null, never zero, when no rate is configured. `orders` copies the
answer onto the offer (`OrderAgentAssignment.quotedFee`) at offer time and records INSTALLATION at
that figure at sign-off; `price-model` prints it as a cost line.

**Lot F (E7-1): the agent is told.** When a `CAMPAIGN_ASSIST`, `ADVERTISER_ONBOARDED` or
`PUBLISHER_ONBOARDED` incentive is recorded, `recordIncentive` raises one in-app PAYOUT row for
the agent — `INCENTIVE_RECORDED`: the event and the amount in the title, the party in the message
(`input.notice.partyName`, the note when none is given), `relatedId` the campaign
(`input.notice.campaignId`) or the party the row names. Other events are recorded silently; a
missing login or a failed feed never fails the record. `payoutMethodLabel` names where a payout
went without the whole account number, and `markWithdrawalPaid` leaves by one
`notify('PAYOUT_PAID', userId, { amount, method, reference, utr }, { inApp })` — the in-app row
plus the seeded `payout-paid` template's channels, subject to the PAYOUT preference; best effort,
a recorded payment is never unwound by a notice.

**`recordIncentiveOnce(input)`** is `recordIncentive` keyed on what it is for — the first row for
(event, orderId | publisherId | advertiserId) stands and a second call returns it — because the
paths that record an installation or an onboarding are retried by phones and re-run by admins.
`findIncentiveFor` is the repository read behind it. The campaign assist is keyed differently:
`Campaign.assistIncentiveId` is unique, so `campaigns` records it through plain `recordIncentive`
and writes the id back. Everything these record lands PENDING_VERIFICATION like every other
incentive; nothing here credits a wallet.

`incentiveSummary` counts the two new events (`installations`, `advertisersOnboarded`) the same way
it counts the rest.

## What is not built

- **Statements** are generated by `invoices` (Lot B, Q13): the monthly payment advice PDF, on
  the first of the month, into DR 04's `Statement` table; `GET /payouts/wallet/statements[/:id/pdf]`
  is mounted there. The CSV is still unbuilt.
- **Reconciliation** is its own module now (`modules/reconciliation`, Lot B Q85); it reads
  withdrawals through `findWithdrawalByUtr` / `findWithdrawalByReference` / `findWithdrawal` here.
- **Print partners** are payees now (Lot B, B4b — `modules/print-partners`); see the section below.
- **TDS rates are zero.** The machinery is in place and effective-dated; the numbers were never
  given. Set them before the first payout, or nothing is withheld.

## Lot B (Q50/B4b): print partners as payees

A print partner's account cannot sign in (owner decision 122), so its settlement starts at the desk
and is otherwise the ordinary ladder, unchanged:

```
POST /finance/withdrawals/on-behalf   ADMIN + finance.edit — { walletId, amount, payoutMethodId?, note? } → 201 REQUESTED
```

`requestWithdrawalOnBehalf` resolves the wallet's party, takes the named method or the party's
VERIFIED default (400 naming `POST /finance/payout-methods` when there is none), and calls
`requestWithdrawal` with the party's own user id — the minimum, the daily cap, the cleared balance
and the freeze all apply. Audited `WITHDRAWAL_REQUESTED_ON_BEHALF` against the request. From there
it is approve → batch release or hand `mark-paid` with the UTR, so an offline NEFT is a PAID
withdrawal on the books (decision 50). Not a print-partner path: any party's wallet may be named.

What differs for the party itself, all in `findPartyContext`: `kind: 'PRINT_PARTNER'`, the
**SMALL_AGENCY** cap rung (a shop is a business paid at cost), `kycStatus: null` — there is no KYC
record, ops vetted the GSTIN and PAN — and `userActive` is the partner's own `isActive`, since the
User row is inactive by design. The batch preflight therefore asks a partner line for no KYC and
reports `PARTNER_INACTIVE` in place of `USER_INACTIVE`. `GET /finance/withdrawals?partyKind=PRINT_PARTNER`,
`GET /finance/wallets?kind=PRINT_PARTNER`, `partyOfWithdrawal` and `POST /finance/tax-rates
{ appliesTo: 'PARTNER' }` (194C, seeded at 0.00 beside the other two) all know the fourth party.
The credit side — `PRINT_COST` into the wallet with TDS under 194C — is `print-partners`' own.

## On a party's behalf (D5)

Agents never add their own bank account: ops records the cancelled cheque at
the desk. `POST /finance/payout-methods` (ADMIN) takes `userId` beside the
usual method fields and writes it exactly as `POST /payouts/methods` would —
first method is the default, and it waits for verification like any other.
`GET /finance/payout-methods?userId=` is everything that party has, whatever
its state; without the query it is still the verification queue.

## Lot H: the print partner's own floor

`print-partners` raises the partner's withdrawal and records their payout
method from the partner's own phone, under exactly the rules every other
party meets: the index exports `requestWithdrawal`, `listMethods`,
`addMethod`, `walletForUser`, the wire shapes `shapeMethod` /
`shapeWithdrawal` and `addMethodSchema` for that. Nothing in this module
changes — the SMALL_AGENCY rung, the no-KYC preflight and the on-behalf
route stand — and `GET /payouts/*` would answer the partner just the same,
since `findWalletForUser` already knows the fourth owner key.

## P-B: what one party has been paid

`paidWithdrawalTotal({ publisherId | agentId, paidFrom?, paidTo? })` answers
`{ total, count }` — the `netAmount` of the party's PAID lines, lifetime or
inside a `paidAt` window `[paidFrom, paidTo)`, `total` a decimal string. An
aggregate rather than a page of `listWithdrawals`, so a long payout history
never truncates the figure. Read by `publishers`' detail card
(`GET /publishers/:id/summary`), which lists the newest PAID lines through
`listWithdrawals({ publisherId, status: ['PAID'] })` for its feed.
