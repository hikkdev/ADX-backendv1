import { ApiError } from '../../shared/errors';
import type { Money } from '../../shared/money';

/**
 * Lot B (B1): how the accrual asks for a commission it was not given.
 *
 * Every spot authorised since the stamp landed carries `commissionPct` and
 * `commissionSource`, resolved once by the quote that priced it, and the
 * accrual reads those. A spot authorised before that has nothing to read, so
 * the run resolves it once — at the campaign's start, the rate that would
 * have been stamped — and records `RESOLVED_AT_ACCRUAL` beside the number.
 *
 * That resolution belongs to `revenue`, and `revenue` already reaches
 * `advertisers`, which reaches this module for `findPayoutMethod`. Importing
 * `revenue` here would close that loop, so the accrual declares the port and
 * bootstrap fills it with `revenue.commissionForListing`.
 *
 * Unregistered, the port refuses rather than guesses: an unstamped spot is
 * skipped by the run and logged, and every stamped spot still accrues. A
 * placeholder percentage here was exactly the bug this package retires.
 */
export type CommissionResolverPort = {
  resolve(input: { listingId: string; ratePerDay: Money; at: Date }): Promise<{
    /** A fraction: 0.15 is fifteen percent. */
    ratePct: string;
    source: string;
  }>;
};

let registered: CommissionResolverPort | null = null;

export function registerCommissionResolverPort(port: CommissionResolverPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetCommissionResolverPort(): void {
  registered = null;
}

export function commissionResolver(): CommissionResolverPort {
  if (!registered) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      'No commission resolver is registered; an unstamped spot cannot be accrued'
    );
  }
  return registered;
}
