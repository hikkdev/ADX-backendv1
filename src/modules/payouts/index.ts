/**
 * Payouts — DR 04's money, from earning to bank account.
 *
 * Four things live here because they are one story: how a party gets paid
 * (payout methods), what they have earned (daily accrual for publishers,
 * verified incentives for agents), how much they may take (the tiered caps and
 * the clearing window), and how it leaves (the withdrawal ladder and the rail).
 *
 * Two rules from the walkthrough shape the whole module. Nothing is
 * auto-approved: a person vets every withdrawal and every incentive, whatever
 * the amount, so no threshold appears anywhere in this code. And tax is
 * withheld when income is credited rather than when it is withdrawn, so a
 * wallet holds net-of-tax money and withdrawing does not deduct twice.
 */
export { payoutRouter, financeRouter } from './payouts.routes';

/** Run by the scheduler: yesterday's earnings, for every live campaign. */
export { runDailyAccrual, earningsSummary, listAccruals, CLEARING_DAYS } from './accrual.service';

/**
 * Lot B (B1): the accrual's commission for a spot authorised before the stamp
 * existed comes through this port; bootstrap fills it from
 * `revenue.commissionForListing`, because `revenue` → `advertisers` → here
 * would otherwise be a cycle.
 */
export { registerCommissionResolverPort } from './commission.port';
/** E6: the name lookup behind a batch's createdBy / approvedBy; filled by bootstrap from `users.findUserLabels`. */
export { registerPayoutUserLabelPort } from './user-labels.port';
export type { CommissionResolverPort } from './commission.port';

/**
 * Lot B (Q13): read by `invoices` for the monthly payment advice — the days a
 * publisher earned in a month, and which publishers earned at all.
 */
export { listAccrualsForPeriod, publisherIdsWithAccruals } from './accrual.service';
export type { AccrualRow } from './payouts.repository';
/** Lot B (B4b): the four parties a wallet — and so a withdrawal — can belong to. */
export type { PayoutPartyKind } from './payouts.repository';

/** Called when an agent does something the platform pays for. */
export { recordIncentive, incentiveSummary, rateFor } from './incentives.service';
/** Lot F: what a caller may name for the agent's INCENTIVE_RECORDED notice (the party, the campaign). */
export type { IncentiveNotice } from './incentives.service';

/**
 * Lot B (Q101/Q102): the same, keyed so a retried sign-off or a re-run
 * onboarding pays once — `orders`, `publishers`, `advertisers` and
 * `campaigns` record through this. `installationFeeFor` is the figure an
 * installation is worth under the platform's commission mode; `orders`
 * quotes it on the offer and `price-model` prints it as a cost line.
 */
export { recordIncentiveOnce, installationFeeFor } from './incentives.service';
export type { IncentiveInput } from './incentives.service';

/** Read by anything that needs to know what a party may take out today. */
export { withdrawalAllowance, listWithdrawals, partyContext } from './payouts.service';
/** P-B: what a party has actually been paid — PAID lines' net, lifetime or in a `paidAt` window — for `publishers`' detail card. */
export { paidWithdrawalTotal } from './payouts.service';
export type { PaidWithdrawalFilter } from './payouts.repository';

/**
 * Lot H (Q147): the print partner's own floor — `print-partners` raises the
 * partner's withdrawal and records their payout method under exactly the
 * rules every other party meets (`requestWithdrawal`, `addMethod`), and
 * prints them in the shapes the finance console already reads.
 */
export { requestWithdrawal, listMethods, addMethod, walletForUser } from './payouts.service';
export { shapeMethod, shapeWithdrawal } from './payouts.shape';
export { addMethodSchema } from './payouts.schema';
export type { AddMethodInput } from './payouts.schema';

/**
 * Lot B (Q41): `advertisers` checks a bank-transfer refund's destination —
 * that the method is the advertiser's own and VERIFIED — before raising it.
 */
export { findPayoutMethod } from './payouts.service';

/**
 * Lot A (Q21): the final payout of a closing account, raised by
 * `account-lifecycle`. Skips the daily cap, the minimum and the freeze — and
 * skips neither the VERIFIED method nor the human vetting. See the service.
 */
export { requestClosingWithdrawal, isClosureWithdrawal, CLOSURE_WITHDRAWAL_MARKER } from './payouts.service';

/**
 * Lot B (Q85): `reconciliation` matches a bank line to the withdrawal that
 * carried it — by UTR (`railReference`), by the WDR reference the narration
 * carries, or by id.
 */
export { findWithdrawalByUtr, findWithdrawalByReference, getWithdrawal as findWithdrawal } from './payouts.service';
/** Lot B (Q85): the ADX account a statement is imported for, checked by `reconciliation`. */
export { findBankAccount } from './batches.service';

/**
 * Lot G (Q124): the weekly draft — `jobs/payout-batch-draft.job.ts` builds
 * one DRAFT batch from the APPROVED lines on the cadence, as the system
 * user, and tells the finance admins; nothing here approves or releases.
 */
export { draftScheduledBatch, lastSlot, nextSlot, payoutBatchSchedule, SCHEDULE_NOTE_PREFIX } from './batch-draft.service';
export type { PayoutBatchCadence, PayoutBatchSchedule, ScheduledDraft } from './batch-draft.service';

export { withholdingFor, dailyCapFor, monthsBetween, resetRulesCache } from './rules.service';
export { railFor, pickRail, availableRails, manualNeftRail, DEFAULT_RAIL_SETTINGS } from './rail';
export type { PayoutRail, PayoutInstruction, PayoutResult, RailSettings } from './rail';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
