/**
 * Banking — payout bank accounts owned by a user.
 *
 * The router is the whole public surface; no other module reads bank accounts
 * today. Payouts themselves live in `earnings`.
 */
export { bankingRouter } from './banking.routes';
