import { logger } from '../../shared/logging';
import { reportError } from '../../shared/errors';

/**
 * How a booking gets its invoice — Lot B (Q13).
 *
 * `invoices` reads this module (the campaign snapshot it itemises) and
 * `advertisers` (the recipient), so this module cannot read `invoices` back
 * without closing a cycle. The dependency is inverted, the way `agents`
 * takes its lead layer: this declares what the checkout needs, `invoices`
 * implements it, and `bootstrap/register-modules` connects the two.
 *
 * Every call is best-effort from the checkout's point of view. The money has
 * moved by the time the invoice is asked for, and undoing a hold because a
 * PDF number could not be allocated would be the wrong failure; so a miss is
 * logged and reported, and `POST /finance/invoices/issue` re-runs the same
 * idempotent issue for the desk. Unregistered — a test, a stripped build —
 * every call is a no-op.
 */
/**
 * E6: what the authorise response says about the paper it raised — enough for
 * the console to link the invoice without a second read.
 */
export type IssuedInvoiceSummary = { id: string; number: string; kind: string; status: string };

export interface CampaignInvoicingPort {
  /** Idempotent: the live invoice for the campaign, issuing one if none stands. */
  issueForCampaign(campaignId: string, byUserId: string | null): Promise<IssuedInvoiceSummary>;
  /** The hold was captured: the invoice is PAID. */
  markCampaignPaid(campaignId: string): Promise<unknown>;
  /** Cancelled after capture: a credit note against the live invoice, which goes VOID. */
  creditNoteForCampaign(campaignId: string, reason: string, byUserId: string | null): Promise<unknown>;
}

let registered: CampaignInvoicingPort | null = null;

export function registerCampaignInvoicingPort(port: CampaignInvoicingPort): void {
  registered = port;
}

const TAG = 'campaigns.invoicing';

async function attempt<T>(what: string, campaignId: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    logger.error(`Invoicing failed: ${what}`, { tag: TAG, campaignId, err });
    void reportError(err, { tag: TAG });
    return null;
  }
}

/** The port as the checkout sees it: never throws, no-op when unregistered. */
export const campaignInvoicing = {
  /** E6: the invoice's id, number, kind and status, or null when none could be issued. */
  async issueForCampaign(campaignId: string, byUserId: string | null): Promise<IssuedInvoiceSummary | null> {
    if (!registered) return null;
    const port = registered;
    const issued = await attempt('issue', campaignId, () => port.issueForCampaign(campaignId, byUserId));
    return issued ? { id: issued.id, number: issued.number, kind: issued.kind, status: issued.status } : null;
  },
  async markCampaignPaid(campaignId: string): Promise<void> {
    if (!registered) return;
    const port = registered;
    await attempt('mark paid', campaignId, () => port.markCampaignPaid(campaignId));
  },
  async creditNoteForCampaign(campaignId: string, reason: string, byUserId: string | null): Promise<void> {
    if (!registered) return;
    const port = registered;
    await attempt('credit note', campaignId, () => port.creditNoteForCampaign(campaignId, reason, byUserId));
  },
};
