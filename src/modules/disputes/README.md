# disputes

A case raised by any party to an order, worked by ADX. DR 07 wave 3 (11 September
2026): the largest single gap the recount found — the word did not appear in the
backend before this — and one domain for three consumers: the agent app's four dispute
frames, the user app's publisher and advertiser (who are the other parties to a case),
and the console's `/disputes` queue.

## Lot F: the evidence-file door

`disputePartiesForEvidenceFile(fileId, holders)` (index) names the raiser and the party against of every case a `/files/:id` DISPUTE_EVIDENCE URL is attached to **and** one of `holders` (the file's owner and uploader) is a party to. E9 (the E7 verifier): the `DisputeEvidence` rows are matched on the **exact** file id (`evidenceFileIdOf` — `f1` is not `f12`, whatever path, query or fragment follows) and each resolves to its own case by `disputeId` (`findEvidenceByFileId` → `findPartiesByDisputeIds`); the URL text never picks a case — an evidence URL is text the raiser typed, so a stranger attaching somebody else's file to a case of their own does not become its reader. Bootstrap hands it to `uploads`' `FileAccessPort.disputePartyMayView`, so the other side of a case (or their agent under a live grant) can open evidence filed against them. `uploads` never imports this module.

## What it owns

`Dispute`, `DisputeMessage`, `DisputeEvidence`; the enums `DisputeStatus`, `DisputeReason`,
`DisputeParty`, `DisputeOutcome`, `DisputeCreditStatus`; the `DISPUTE` notification type;
the `DSP-` series on the identifiers counter.

## Routes

```
POST   /disputes                        raise one (any party to the order)
GET    /disputes/my                     my cases, with the counts strip
GET    /disputes/:id                    one case with its thread and evidence (ADMIN: + `against`, E7-3)
POST   /disputes/:id/messages           reply on the thread
POST   /disputes/:id/evidence           attach a file (url from POST /upload)
POST   /disputes/:id/reopen             the raiser, within the reopen window
GET    /disputes                        ADMIN — the queue, filterable by status
GET    /disputes/summary                ADMIN — the KPI strip
PATCH  /disputes/:id/status             ADMIN — move it, note required
POST   /disputes/:id/resolve            ADMIN — outcome, note, optional credit, optional agentId for a REINSTALL
POST   /disputes/:id/credit/release     ADMIN — the money moves
```

T-B: the three ADMIN writes (`status`, `resolve`, `credit/release`) answer the
same detail view `GET /disputes/:id` answers — the case with its `order` card,
`raisedBy`, thread, evidence, `sla`, `agentState`, re-install state,
`openFraudCase` and `against` — re-read once after the write
(`writtenView` in the service), so the desk updates the case it holds from the
answer without a second read.

## Invariants

- **Visible to the raiser, the party it is against, and ADX.** Nobody else. A read
  answers 404 to a stranger; a write answers 403 (`disputes.policy.ts`).
- **The parties are derived from the order, never typed.** The Raise frame names the
  order. The raiser is whichever party of the order they are (403 otherwise). A payout
  complaint is with ADX; an advertiser's complaint is with the publisher; a publisher's is
  with the agent who did the work, or the advertiser when nobody did; an agent's is with
  the publisher whose site it was. `partiesFor` in the service is the rule.
- **One status enum, and the clients project it (decision 1).** The six statuses are
  `OPEN · UNDER_REVIEW · AWAITING_RESPONSE · ESCALATED · RESOLVED · REJECTED`. The agent's
  three chips are `agentStateOf`: OPEN → Open; UNDER_REVIEW, AWAITING_RESPONSE and
  ESCALATED → Under review; RESOLVED and REJECTED → Resolved. The console's seven are the
  same six plus an *SLA breach* flag derived from `slaDueAt` on an open case, and
  *Refunded* which is RESOLVED with a credit.
- **A credit is recorded, never moved, until finance releases it (decision 2).** DR 04's
  standing rule is that nothing that moves money is automatic. `resolve` records
  `creditedAmount` with `creditStatus = PENDING`; the screens say "credit approved, ADX
  finance releases it"; `releaseCredit` is the second, human step, and the only place in
  this module a wallet moves. It goes through `wallets.move` with a matching ledger leg
  (`platform:revenue` for an advertiser refund, `platform:payables` for a publisher or
  agent adjustment), idempotent on the case id.
- **Money is a decimal string end to end.** The repository writes `Prisma.Decimal`; the
  service's views hand out strings.
- **Every ops action is logged** (`DISPUTE_STATUS_CHANGED`, `DISPUTE_RESOLVED`,
  `DISPUTE_CREDIT_RELEASED`) with who did it, and every state change notifies the other
  parties through `notifications`.
- **The raiser may reopen within seven days of the decision**; the case returns to
  UNDER_REVIEW and ADX is told.

## Dependencies

`identifiers` (the DSP- number), `notifications`, `users` (names, the admin list),
`wallets` (the release), `order-milestones` (the re-install visit and its status),
`fraud` (the open case citing a dispute). The order's parties and the raiser's wallet-bearing records are
read through this module's own Prisma repository rather than through `orders`,
`publishers`, `advertisers` and `agents`, because none of those export the join this
needs and a read is not a decision.

## Tests

`__tests__/disputes.service.test.ts` (parties, the number, notifications, the credit
held then released), `__tests__/disputes.policy.test.ts`, `__tests__/disputes.schema.test.ts`.

## Lot D (Q53/Q54/Q91/Q92)

- **The clock pauses while AWAITING_RESPONSE** — the same pause a support
  ticket takes while WAITING. Moving a case into AWAITING_RESPONSE stamps
  `slaPausedAt`; a party's next message (not ADX's) puts it back UNDER_REVIEW,
  banks the wait into `slaPausedMs` and moves `slaDueAt` by it; ops moving or
  resolving it out of that state banks the wait the same way. Breach is
  derived on read — `slaOf(dispute, now)` → `{ breached, paused, dueAt, dueIn }`
  rides on every row and read as `sla`; the summary's `slaBreaches` skips
  paused cases.
- **REINSTALL raises the visit.** `resolve` with outcome REINSTALL calls
  `order-milestones.raiseReinstallMilestone({ orderId, disputeId, agentId? })`
  **before** the case is written — an INSTALLATION milestone on the order,
  stamped `reinstallOfDisputeId`, offered to the agent who did the work by
  default (decision 92) or to the agent ops named, with the ordinary
  25-minute window. The milestone id lands on `Dispute.reinstallMilestoneId`
  (unique). A case with no order cannot take this outcome (409). The read
  carries `reinstallStatus` and `reinstallPending` — true until the visit is
  COMPLETED or SKIPPED — which is the console's "resolved — re-install
  pending". `DISPUTE_RESOLVED` names the milestone.
- **Open fraud case.** The ADMIN read carries `openFraudCase`
  (`{ id, displayId, status } | null`) from `fraud.findOpenFraudCasesForDisputes`;
  a party's read always says null — being investigated is not something the
  platform tells you.

## E6: the queue on the list contract

`GET /disputes?q=&status=a,b&page=&pageSize=` answers
`{ items, total, page, pageSize, counts }` — `q` over the display id, the
detail and the order's campaign name; `status` one value or a comma list;
the chips counted with the status facet removed. The old `?limit=&offset=`
pair is still accepted for one release and answers the old bare array; when
both pairs are sent the new one wins. Oldest first, as before.

## E7-3: who the case is against

The ADMIN read carries `against: { type: PUBLISHER | ADVERTISER | AGENT, id,
displayId, name } | null` — the party *record* behind `againstUserId`, beside
the `againstParty` enum the clients already project (unchanged, so nothing
that reads the enum breaks). Resolved through `PartyLookupPort`
(`party-lookup.port.ts`), which bootstrap fills from `publishers`,
`advertisers` and `agents`' label exports — this module still imports none of
the three. When a login holds more than one record the one of the case's own
type wins. Null against ADX, when the login has no record, on a party's read,
and when no port is registered.
