/**
 * Packages — DR 02's four-step sale.
 *
 * A subscription an agent sells to an advertiser, sitting beside the campaigns
 * they book rather than inside them. Four screens: choose a plan, confirm the
 * cycle and add-ons, send a payment link, and the activation receipt.
 *
 * It owns the catalogue, the sale and its term. It does not own money — the
 * advertiser's wallet does, and this calls it. It does not own entitlements
 * either: the plans name what they promise and nothing in the platform reads
 * those names yet, which the API reports honestly rather than implying a gate.
 */
export { packageRouter, packageLinkRouter } from './packages.routes';

/** Run by the scheduler: a term that has run out stops being active. */
export { runPackageExpiry } from './packages.service';
/** Lot J2 (6): the daily renewal sweep — `jobs/package-renewal.job.ts`. */
export { runPackageRenewals } from './packages.service';
export type { RenewalSummary } from './packages.service';

/** Used by the apps and the console to show what a brand is on; the batch form (Lot I, I4-B) is `support`'s inbox read. */
export { activePackage, activePackagesForAdvertisers, ENFORCED_ENTITLEMENT_KEYS } from './packages.service';
/** Lot J2 (4): the grace-aware twins `support`'s live-chat door reads — running, or ended within the policy's `graceDays` (`inGrace`, `graceEndsAt`). */
export { entitledPackageForAdvertiser, entitledPackagesForAdvertisers } from './packages.service';
export type { EntitledPackage } from './packages.service';

/**
 * Lot B (Q13): the invoice. `invoices` reads the sale snapshot through
 * `findSaleForInvoice`; `markPaid` reaches back through the port bootstrap
 * registers, because this module cannot import `invoices` without a cycle.
 */
export { findSaleForInvoice } from './packages.service';
export type { PackageSaleInvoiceSnapshot } from './packages.service';
export { registerPackageInvoicingPort } from './invoicing.port';
export type { PackageInvoicingPort } from './invoicing.port';

/**
 * Lot C (Q110): `payments` sells the same sale through a gateway. It reads
 * the sale, applies the same ownership and payability rules the wallet door
 * does, and on capture — the wallet credited and debited — marks it paid
 * with method GATEWAY.
 */
export { findSale, assertMayAct as assertMayActOnSale, assertPayable, assertSaleTermsAccepted, markPaid } from './packages.service';
export type { SaleActor } from './packages.service';
export type { SaleRow } from './packages.repository';

/** Pure pricing, exported for tests and for anything that needs a total without a sale. */
export { priceSale, ANNUAL_DISCOUNT_PCT, ANNUAL_MONTHS } from './packages.service';
export type { PricedSale } from './packages.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
