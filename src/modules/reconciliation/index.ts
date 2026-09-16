/**
 * Reconciliation — Lot B (Q85): bank statements in, each line explained by
 * one ADX record — a paid withdrawal, a recorded top-up, or a ledger
 * transaction — and the difference recorded when the two disagree.
 *
 * Owns BankStatementProfile, BankStatementImport, BankStatementLine and
 * ReconciliationMatch. Reads withdrawals through `payouts`, top-ups through
 * `advertisers` and the books through `ledger`; the ADX bank accounts a
 * statement is imported for belong to `payouts` (`/finance/bank-accounts`).
 */
export { reconciliationRouter } from './reconciliation.routes';
export { parseStatement, DEFAULT_COLUMNS, DEFAULT_DATE_FORMAT } from './csv';
export type { ParsedLine, ParsedStatement, ProfileColumns } from './csv';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
