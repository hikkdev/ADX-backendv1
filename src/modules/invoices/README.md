# invoices

Lot B (Q13/Q34): the legal entity, the tax invoices ADX issues to
advertisers, the invoices publishers raise on ADX, and the monthly payment
advice a publisher downloads from the Statements screen.

It owns the **paper, not the money**. A hold, a capture, a refund belong to
`advertisers`, `wallets` and the refund desk; this describes them once, in a
consecutive series, and never edits a document after it is issued — a void
is a credit note. `revenue` is *not here* for the same reason it is not in
`campaigns`: the arithmetic is `revenue.quote`'s, this only prints it.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /finance/legal-entity` | ADMIN | ADX as the supplier: legal name, GSTIN, PAN, TAN, CIN, address, state, invoice prefix, FY start month |
| `PUT /finance/legal-entity` | ADMIN | Patch, strict keys; GSTIN/PAN/TAN/CIN format-checked, state code and PAN must agree with the GSTIN; audited `LEGAL_ENTITY_UPDATED` with the diff |
| `GET /finance/invoices?q=&status=&kind=&advertiserId=&from=&to=&sort=&page=&pageSize=` | ADMIN | The register on the list contract; `q` matches number, recipient name, recipient GSTIN; `counts` by status |
| `POST /finance/invoices/issue { campaignId \| packageSaleId }` | ADMIN | The desk's repair path — the same idempotent issue the checkout ran; audited `INVOICE_ISSUED` |
| `GET /finance/invoices/:id` | ADMIN | One invoice with its lines |
| `GET /finance/invoices/:id/pdf` | ADMIN | The A4 PDF: streamed on first render and stored (`pdfFileId`), a redirect to the file after |
| `POST /finance/invoices/:id/void { reason }` | ADMIN + `finance.approve` | Issues a CREDIT_NOTE against it and sets it VOID, one transaction; audited `INVOICE_VOIDED` |
| `GET /finance/publisher-invoices?status=&publisherId=&period=&q=` | ADMIN | Publishers' invoices to ADX, list contract |
| `PATCH /finance/publisher-invoices/:id { status: MATCHED\|REJECTED, note? }` | ADMIN | Decide one; a rejection needs a note; audited `PUBLISHER_INVOICE_REVIEWED` |
| `POST /finance/statements/run { period? }` | ADMIN | Run the monthly advices by hand — the month just ended by default; audited `MONTHLY_STATEMENTS_RUN` |
| `GET /advertisers/:id/invoices` | owner, ADMIN, attributed agent (`assertMayActFor` READ) | The advertiser's issued documents |
| `GET /advertisers/:id/invoices/:invoiceId/pdf` | same | Stream or redirect, as above |
| `GET /publishers/me/invoices` | PUBLISHER | What I have raised on ADX |
| `POST /publishers/me/invoices { period, fileId, gstin?, amount }` | PUBLISHER | Upload my invoice for a month; the file is an `UploadedFile` of mine (purpose `INVOICE`); one per period, a REJECTED one is replaced in place |
| `GET /payouts/wallet/statements` | the party | My payment advices, newest first |
| `GET /payouts/wallet/statements/:id/pdf` | the wallet's owner, ADMIN | Redirect to the stored PDF, or a render on demand |

Mounting order (in `bootstrap/register-modules.ts`): `/publishers/me/invoices`
is mounted **ahead** of `publisherRouter`, so nothing there reads `me` as an
id; `/advertisers` and `/finance` after their owners, whose `authenticate`
(and `requireRole('ADMIN')` on `/finance`) a request passes through first.

## Numbering

`<series>/<FY>/<000018>`. The series is `InvoiceSequence.series` =
`<series>/<FY>`, bumped inside the same transaction that writes the invoice,
so a failed write gives its number back and two concurrent issues serialise
on the row. Three series, because the tax office reads them differently:

| Kind | Series | When |
| --- | --- | --- |
| `TAX_INVOICE` | `<invoicePrefix>` (default `INV`) | the legal entity has a GSTIN |
| `PROFORMA` | `<invoicePrefix>-PRO` | it does not yet — no tax number is consumed |
| `CREDIT_NOTE` | `<invoicePrefix>-CN` | a void |

The financial year is read in IST from `financialYearStartMonth` (4 → April,
`2026-27`).

## What an invoice says

**A campaign** (`issueInvoiceForCampaign`, called by the checkout through
`campaigns`' `CampaignInvoicingPort` the moment the hold is placed):

- one `MEDIA` line per spot from the snapshot — `ratePerDay × days × quantity`,
  SAC from `TaxSettings.mediaSacCode`, GST `mediaGstPct`, `campaignSpotId` set;
- the fee lines (`PLATFORM` / `INSTALLATION` / `PRINTING` / `DESIGN`) from
  `FeeSchedule`, aggregated across the spots, with each fee's `gstPct` and
  `sacCode`. The *amounts* come from `revenue.quote` — the call the checkout
  made — so the invoice cannot disagree with what was held;
- a `DISCOUNT` line when `Campaign.discount > 0`. **Carried at 0% GST**: the
  checkout subtracts the discount *after* GST (`total = media + fees + gst −
  discount`), which makes it a credit against the bill rather than a rate
  discount, and an invoice whose total is not the amount that was held is the
  one thing an invoice must not be. A rate discount that reduces the taxable
  value is `revenue.quote`'s `rateDiscount`, which the campaign does not use.

If the re-quoted lines no longer add to `Campaign.total` — the fee schedule
moved between the booking and a desk re-issue — the issue is refused 409
rather than documented wrongly.

Status: `PAID` when the campaign is LIVE (the hold was captured), `ISSUED`
while SCHEDULED, with `dueAt` the start date; `runCampaignTransitions` marks
it PAID through the port when the hold is captured on the day.

**A package sale** (`issueInvoiceForPackage`, from `packages.markPaid`
through `PackageInvoicingPort`): one `PACKAGE` line per sale line (plan, then
add-ons; `quantity` is the months), a `DISCOUNT` line for the annual cycle's
fifth off — a rate discount, so it *does* reduce the taxable value — and the
sale's GST **percent** (`18.00`) converted to the **fraction** (`0.18`) every
line carries. The sale is not changed. Always `PAID`.

**Tax split.** `supplierStateCode` (the entity's, or the first two digits of
its GSTIN) against the recipient's — the advertiser's GSTIN prefix, else
their `state` or `city` resolved through `gst-states.ts`. Same state:
CGST + SGST, the odd paisa to SGST; different: IGST. **Unknown recipient
state is treated as in-state** — for a service with no recipient address the
place of supply is the supplier's location. The CHECK on the table
(`cgst = sgst = 0 OR igst = 0`) is what the split honours.

**Rounding.** The total is rounded to the rupee and the difference kept as
`roundOff`, so `Σ taxable + Σ gst + roundOff = total` to the paisa.

## Credit notes

`voidInvoice` (the desk's `POST /finance/invoices/:id/void`, and
`cancelCampaign` through the port whenever an invoiced campaign is cancelled
— released *or* refund-pending, since an issued document cannot be deleted
either way) writes the note and sets the original `VOID` in one transaction.

**The note's lines and totals are the mirror image of the original —
negative.** So `SUM(total)` over an advertiser's documents nets to what was
billed, and the partial unique index (one live non-credit-note per campaign
/ per sale) lets a re-issue follow a void. The PDF prints the magnitudes
under a CREDIT NOTE heading with "Against invoice". The reason travels as a
zero-value `OTHER` line at `sortOrder 1`, because the schema has no note
column and the recipient reads the reason on the paper. Idempotent: a second
void answers with the note that stands.

Voiding does not move money. After capture the refund is the desk's
(`/finance/campaign-refunds`); the note is the paper beside it.

## The PDF (`pdf.ts`)

A4, pdfkit, Helvetica (no rupee glyph — amounts print `Rs.`). Supplier
block, recipient block, number / date / place of supply, the lines table
(SAC, qty, rate, taxable, GST %, GST), totals with CGST/SGST or IGST,
round-off, total, and the total in words in Indian grouping
(`amount-in-words.ts`). Rendered lazily on the first `/pdf` request and
stored through `uploads.storeGeneratedFile` (purpose `INVOICE`, owner the
issuer, the requester as fallback); the row is immutable once issued, so the
file is too.

## The publisher's payment advice (`statements.service.ts`)

`jobs/monthly-statements.job.ts` — every 30 minutes, only on the first of the
month in IST, Redis-locked per tick and per month — runs `runMonthlyStatements`
for the month just ended: for every publisher with an `EarningAccrual` in it,
one PDF (gross, commission, TDS, net per day; totals; the publisher's GSTIN;
the wallet's opening and closing balances) written through `uploads`
(purpose `STATEMENT`) into DR 04's `Statement` row, keyed on (wallet,
periodStart). A rerun refreshes the same row. A publisher with no user yet
(an agent still holds the account) gets the row without a stored file, and
`/pdf` renders on demand.

`Statement.credits` / `debits` are the wallet's own movements in the month by
entry type (credits: EARNING, BONUS, REFERRAL, GOODWILL_CREDIT, REFUND,
TOPUP; debits: PAYOUT, PENALTY, EXPIRY, CAMPAIGN_DEBIT, PACKAGE_DEBIT);
`taxWithheld` is the accruals' TDS. The advice is **not a tax invoice** — ADX
is the payer. A GST-registered publisher raises theirs through
`POST /publishers/me/invoices`, which the desk matches or rejects.

## Exports

| Export | For |
| --- | --- |
| `registerInvoicesModule()` | bootstrap — fills `campaigns`' and `packages`' invoicing ports |
| `markInvoicePaid(invoiceId, { paymentId?, topUpId? })` | Lot C — the gateway payment or top-up that settled it |
| `issueInvoiceForCampaign`, `issueInvoiceForPackage`, `voidInvoice` | the desk, tests |
| `runMonthlyStatements`, `previousMonth`, `monthWindow`, `isFirstOfMonthIST` | the job — Lot F: each advice upserted tells its publisher once, `notify('STATEMENT_READY', userId, { month, net, url, partyName, reference }, { inApp })` (PAYOUT × EMAIL preference; `url` is `statementDeepLink` → `/payouts/wallet/statements/:id/pdf`); nobody to tell without an app account; a failed notice never fails the run; the on-demand `generatePublisherStatement` tells nobody |

## Dependencies

Reads `advertisers` (recipient, `assertMayActFor`), `campaigns`
(`findCampaignForInvoice`), `packages` (`findSaleForInvoice`), `revenue`
(`quote`, `invoiceTaxCodes`), `publishers` (`findPublisherForUser`,
`findPublisherBilling`), `payouts` (`listAccrualsForPeriod`,
`publisherIdsWithAccruals`, `partyContext`), `wallets` (`findWalletFor`,
`sumEntries`), `uploads` (`storeGeneratedFile`, `findUploadedFile`). Nothing
imports this module but bootstrap and the job: `campaigns` and `packages`
reach it through their ports.

## Invariants

- An issued document is never edited. Status moves ISSUED → PAID → VOID; a
  void always has a credit note; nothing else changes.
- One live non-credit-note invoice per campaign and per sale (partial unique
  indexes); the issue is idempotent and yields to the winner of a race.
- The invoice total equals the amount that was charged, or the invoice is
  not issued.
- Numbers are consecutive per series per financial year, allocated in the
  writing transaction.
- No tax number is consumed while the entity has no GSTIN.
- Nothing here writes a wallet or a ledger leg. `Invoice.ledgerTransactionId`
  is reserved for Lot C to fill from the settlement.

## E6: the PDF on the party route

The stored PDF is a PRIVATE file owned by the advertiser's user
(`ownerUserId` on `storeGeneratedFile`), and both PDF routes serve the bytes
themselves — a local object streams, an R2 object is fetched through its
presigned read and sent — through `uploads.openStoredFile`, which applies no
viewer rule because the invoice route has already decided who may read.
Lot D's 302 to `/files/:id` refused the advertiser's agent and any advertiser
the file had not been stored under; nothing redirects now.
