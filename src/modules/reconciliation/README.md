# reconciliation

Bank statements in; each line explained by one ADX record — Lot B (Q85).

Not to be confused with `ledger.verifyLedger`, which proves the books agree with
the wallets. This proves the books agree with the **bank**: what the statement
says left or arrived, against what ADX recorded paying or receiving.

## Owned routes

All under `/api/v1/finance/reconciliation`, `authenticate` + `requireRole('ADMIN')`;
writes carry `requirePermission('finance.edit')`.

| Method | Path | What |
| --- | --- | --- |
| GET | `/profiles` | The per-bank column profiles |
| POST | `/profiles` | `{ name, bankName, columns: { date, description, utr?, debit?, credit?, amount?, balance? }, dateFormat? }` — audited `STATEMENT_PROFILE_CREATED` |
| GET | `/imports?bankAccountId&limit` | Past imports, newest first |
| POST | `/imports` | multipart `file` (CSV, 5 MB, via `uploads.csvUploadMiddleware`) + `bankAccountId`, `profileId?` → `{ import, created, duplicates, problems }`, **201**; audited `STATEMENT_IMPORTED` |
| GET | `/imports/:id/export.csv` | Lot G (Q125). Every line of one import as a streamed CSV (see **The export** below); 404 for an unknown import; the file is named after the statement file and the import id. Audited `RECONCILIATION_LINES_EXPORTED` against the import **before the first byte** |
| GET | `/lines?status&bankAccountId&importId&from&to&q&page&pageSize` | The list contract over lines, counts by `matchStatus` |
| GET | `/lines/export.csv?status&bankAccountId&importId&from&to&q` | Lot G (Q125). The desk's filters, no page — the same CSV over everything they match, under the cap. Registered ahead of `/lines/:id/*` so `export.csv` is never read as an id. Audited `RECONCILIATION_LINES_EXPORTED` against the account (`all` when none is named) |
| POST | `/auto-match { bankAccountId?, from?, to? }` | Explains every UNMATCHED line it safely can; audited `RECONCILIATION_AUTO_MATCHED` |
| POST | `/lines/:id/match { withdrawalId \| topUpId \| paymentId \| ledgerTransactionId, note? }` | A person names the record — exactly one; audited `BANK_LINE_MATCHED` |
| POST | `/lines/:id/ignore { note? }` | Bank charges, interest: set aside; audited `BANK_LINE_IGNORED` |
| POST | `/lines/:id/unmatch` | Back to UNMATCHED; audited `BANK_LINE_UNMATCHED` |
| GET | `/summary?bankAccountId&from&to` | Count and sum per status, and the total |

## The export (Lot G, Q125)

`reconciliation-export.service.ts`. One row per line, columns `lineId, importId,
bankAccountId, valueDate (YYYY-MM-DD), description, utr, direction, amount,
runningBalance, matchStatus, matchKind (AUTO | MANUAL), matchedRecordType
(WITHDRAWAL | TOP_UP | PAYMENT | LEDGER_TRANSACTION | NONE), matchedRecordId,
difference (line − record), matchNote, resolvedByUserId, resolvedByName,
resolvedAt` — the match state, the ADX record that explains the line, and who
resolved it (the admin who matched or ignored it by hand, or who ran the
auto-match that claimed it) and when. Money leaves as decimal strings. An
UNMATCHED line has the match columns empty; an IGNORED one names `NONE`.
Streamed like the other exports: a thousand lines a slice, 50,000 at most,
walked by **keyset** under the fixed `(valueDate, id)` order newest first —
never skip/take — so a line landing mid-stream can neither repeat nor drop a
row. The resolver's name comes from `users.findUserLabels`, one lookup per
slice; a lookup that fails leaves the id and an empty name.

## Owned Prisma entities

`BankStatementProfile`, `BankStatementImport`, `BankStatementLine`,
`ReconciliationMatch`. `BankAccount` — the ADX account a statement is imported
for — belongs to `payouts` (`/finance/bank-accounts`).

## Public exports (`index.ts`)

- `reconciliationRouter`
- `parseStatement`, `DEFAULT_COLUMNS`, `DEFAULT_DATE_FORMAT` and their types, for
  anything that wants to read a statement without importing it.

## Dependencies

- `payouts` — `findBankAccount`, `findWithdrawal`, `findWithdrawalByUtr`,
  `findWithdrawalByReference`.
- `users` — `findUserLabels`, for the export's `resolvedByName` (Lot G, Q125).
  Nothing above this module reaches it, so the read is direct rather than a
  port.
- `advertisers` — `findTopUp`, `findTopUpByUtr`, `findTopUpByPaymentId`,
  `markTopUpReconciled`.
- `ledger` — `listTransactions`, `getTransaction`, `platformAccount`, `post`,
  `reverse`.
- `uploads` — `csvUploadMiddleware`, `storeGeneratedFile` (the statement is kept
  as imported, purpose `BANK_STATEMENT`).
- `shared/csv` — the hand-rolled RFC 4180 reader and writer; `csv.ts` here is
  the bank-statement layer on top: column mapping, `dd/MM/yyyy`-style date
  formats, `1,23,456.78` / `(250)` / `1200 Dr` amounts, a UTR pulled from the
  narration when the bank gives no reference column.

## Invariants

- **Generic CSV in.** Without a profile the defaults are `Date, Description,
  Ref No./UTR, Debit, Credit, Balance` and `dd/MM/yyyy`. A profile renames the
  columns (matched case-insensitively, exact before contains) and the date
  format for the bank that does it differently; a one-column signed `amount`
  export works too. The header row is found by the date and description
  columns, so an address block above it is skipped. Bad rows are reported by
  record number and the good rows still land; a file with no readable line is
  refused 400 with the reasons.
- **The same line imported twice is one line.** `rawHash` is sha256 of
  (date | description | amount | direction), unique per bank account;
  `createMany({ skipDuplicates })` and the import records how many it already
  had.
- **A record explains one line.** A withdrawal, a top-up or a ledger
  transaction already named by a match is refused for another line (409), and
  the auto-matcher skips it.
- **Auto-match never guesses.** In order: a DEBIT line by the `WDR-…`
  reference in its narration or by its UTR → the withdrawal, if PAID; a
  CREDIT line by UTR → the top-up; then the *one* unclaimed ledger transaction
  of the right kind (DEBIT: PAYOUT / REFUND, CREDIT: TOPUP) whose cash-or-
  suspense leg equals the amount within ±2 days of the value date. Two
  candidates leave the line alone. A withdrawal still PROCESSING is reported
  under `awaitingMarkPaid` rather than matched — mark-paid is finance's act,
  and it is what posts the cash legs.
- **DIFFERS is not MATCHED.** The record's amount is compared with the line's;
  a disagreement stores `difference` (line − record) and the line reads
  DIFFERS for a person to settle.
- **A matched top-up settles suspense.** A transfer or cheque top-up sits in
  `platform:suspense` until its bank line is matched; the match posts
  `suspense +amount / cash −amount` (keyed `recon-settle:<topUpId>:<matchId>`,
  stored on the match as `ledgerTransactionId`) and stamps
  `WalletTopUp.reconciledAt`. Only when the amounts agree. Unmatching reverses
  that transaction (never edits it) and clears the stamp. A gateway top-up's
  cash leg was posted when it landed, so its match settles nothing.
- **Sign convention** (from `ledger`): money leaving ADX is a *credit* to
  `platform:cash` (positive leg), money arriving a debit (negative). A bank
  DEBIT line therefore looks for a positive cash leg, a CREDIT line for a
  negative one.
- Every write is audited by hand against its row with `matchStatus` before
  and after; the generic admin-write tap is only the safety net.

## Tests

```bash
npx vitest run src/modules/reconciliation
```

`csv.test.ts` drives the parser against an HDFC-shaped export, the defaults
with an address block, and a signed single column; `reconciliation.service.test.ts`
drives the import, the auto-matcher's order and its refusals, the manual paths
and the suspense settlement over an in-memory repository;
`reconciliation-export.test.ts` (Lot G) the rows, the keyset walk, the cap and
the two routes.

## Suggested ownership

Finance — with `payouts` and `ledger`.
