import { logger } from '../../shared/logging';
import { reportError } from '../../shared/errors';

/**
 * How a package sale gets its invoice — Lot B (Q13).
 *
 * `invoices` reads this module for the sale it itemises, so this module
 * cannot read `invoices` back; the dependency is inverted here exactly as
 * `campaigns/invoicing.port.ts` does it, and bootstrap connects the two.
 *
 * Best-effort: the wallet has been debited (or the bank reference recorded)
 * by the time the invoice is asked for, and a sale must not fail to activate
 * because a number could not be allocated. A miss is logged and reported,
 * and `POST /finance/invoices/issue` re-runs the same idempotent issue.
 */
export interface PackageInvoicingPort {
  /** Idempotent: the live invoice for the sale, issuing one (PAID) if none stands. */
  issueForPackageSale(saleId: string, byUserId: string | null): Promise<unknown>;
}

let registered: PackageInvoicingPort | null = null;

export function registerPackageInvoicingPort(port: PackageInvoicingPort): void {
  registered = port;
}

const TAG = 'packages.invoicing';

export const packageInvoicing = {
  async issueForPackageSale(saleId: string, byUserId: string | null): Promise<void> {
    if (!registered) return;
    try {
      await registered.issueForPackageSale(saleId, byUserId);
    } catch (err) {
      logger.error('Invoicing failed: package sale', { tag: TAG, saleId, err });
      void reportError(err, { tag: TAG });
    }
  },
};
