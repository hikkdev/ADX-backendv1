import { assertPartyAdultForOrders } from '../../shared/age-gate';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { getAdvertiser } from '../advertisers';
import { isFeatureEnabled } from '../feature-flags';
import { notify } from '../notifications';
import { findPublisherContact } from '../publishers';
import { taxSettings } from '../revenue';
import { ensureWallet, move, snapshot } from '../wallets';

/**
 * LM-1 — what the ad side and the boost side share: the two switches, the
 * GST rate, the wallet movements and the buyer's notices.
 */

export const ADS_FEATURE = 'promotions.ads';
export const BOOSTS_FEATURE = 'promotions.boosts';

/** Whether a switch is on. A flags-table hiccup reads as on, the way the route guard treats it. */
export async function featureOn(key: string, userId?: string | null): Promise<boolean> {
  try {
    return await isFeatureEnabled(key, userId ?? null);
  } catch (err) {
    logger.warn('Feature state unreadable; treating as on', { key, err });
    return true;
  }
}

/** The platform's GST on media, as a fraction — `revenue`'s tax row (0.18 until ADX changes it). */
export async function gstFraction(): Promise<string> {
  return (await taxSettings()).mediaGstPct;
}

/** The two wallets a placement is paid from. */
export type Buyer = { kind: 'ADVERTISER'; id: string } | { kind: 'PUBLISHER'; id: string };

/** The publisher wallet's label, as `revenue` and `payments` open it. */
const PUBLISHER_WALLET_LABEL = 'Publisher wallet';

async function walletFor(buyer: Buyer) {
  if (buyer.kind === 'PUBLISHER') return { wallet: await ensureWallet({ kind: 'PUBLISHER', id: buyer.id }, PUBLISHER_WALLET_LABEL), label: PUBLISHER_WALLET_LABEL };
  const advertiser = await getAdvertiser(buyer.id);
  const label = `${advertiser.companyName ?? advertiser.name} · advertiser`;
  return { wallet: await ensureWallet({ kind: 'ADVERTISER', id: buyer.id }, label), label };
}

/**
 * The debit that pays for a placement — wallet − / `platform:revenue` +,
 * PROMOTION_DEBIT under PROMOTION_SPEND, keyed by the caller on the booking
 * (so a double tap, a retried webhook and the wallet route are one charge).
 * `requireFunds` inside the movement is the last word on the balance; the
 * caller asks `assertBuyerCanPay` first for the answer a buyer can act on.
 */
export async function debitBuyer(
  buyer: Buyer,
  input: { amount: Money; idempotencyKey: string; reference: string; note: string; byUserId: string | null; now: Date },
): Promise<{ walletEntryId: string | null; created: boolean }> {
  const { wallet, label } = await walletFor(buyer);
  const amount = new Decimal(input.amount);
  const result = await move({
    walletId: wallet.id,
    walletLabel: label,
    amount: money(amount.negated()),
    entryType: 'PROMOTION_DEBIT',
    ledgerKind: 'PROMOTION_SPEND',
    idempotencyKey: input.idempotencyKey,
    requireFunds: true,
    counterLegs: [{ accountCode: 'platform:revenue', amount: money(amount), note: 'Paid placement' }],
    reference: input.reference,
    note: input.note,
    createdByUserId: input.byUserId,
    occurredAt: input.now,
  });
  return { walletEntryId: result.entry?.id ?? null, created: result.created };
}

/**
 * Paid from settled money only: goodwill is credit to spend on a booking,
 * and a placement refunded in full would turn it into cash — so it is left
 * out here (the wallet's own `requireFunds` counts it). 402
 * INSUFFICIENT_FUNDS with what is short; 409 WALLET_FROZEN.
 */
export async function assertBuyerCanPay(buyer: Buyer, amount: Money, now: Date): Promise<void> {
  const { wallet } = await walletFor(buyer);
  const view = await snapshot(wallet.id, now);
  if (view.frozenAt) throw new ApiError(409, 'WALLET_FROZEN', 'This wallet is frozen; money cannot leave it', { walletId: wallet.id });
  const cash = Decimal.max(new Decimal(view.balance).minus(view.held).minus(view.openWithdrawals), new Decimal(0));
  if (cash.lessThan(new Decimal(amount))) {
    throw new ApiError(402, 'INSUFFICIENT_FUNDS', `Your wallet has ${money(cash)} to spend; this costs ${money(amount)}. Top up, or pay by card or UPI.`, {
      available: money(cash),
      required: money(amount),
      shortfall: money(new Decimal(amount).minus(cash)),
    });
  }
}

/**
 * AGE-1 (the owner, 29 Sep 2026): buying a placement is placing an order —
 * the buyer's account holder (the advertiser's or the publisher's own
 * person, whoever presses) needs a date of birth on file and to be 18 or
 * over. 403 AGE_REQUIRED; asked before anything is priced, held or taken.
 */
export async function assertBuyerMayOrder(buyer: Buyer, actorUserId: string | null | undefined): Promise<void> {
  await assertPartyAdultForOrders(buyer, { actorUserId });
}

/**
 * The full refund of a placement — REFUND, wallet + / `platform:revenue` −,
 * keyed on the payment it undoes, so it lands once however often it is asked.
 */
export async function refundBuyer(
  buyer: Buyer,
  input: { amount: Money; idempotencyKey: string; reference: string; note: string; byUserId: string | null; now: Date },
): Promise<{ walletEntryId: string | null }> {
  const { wallet, label } = await walletFor(buyer);
  const amount = new Decimal(input.amount);
  const result = await move({
    walletId: wallet.id,
    walletLabel: label,
    amount: money(amount),
    entryType: 'REFUND',
    ledgerKind: 'REFUND',
    idempotencyKey: input.idempotencyKey,
    counterLegs: [{ accountCode: 'platform:revenue', amount: money(amount.negated()), note: 'Paid placement refunded' }],
    reference: input.reference,
    note: input.note,
    createdByUserId: input.byUserId,
    occurredAt: input.now,
  });
  return { walletEntryId: result.entry?.id ?? null };
}

/** Who hears about a placement: the login behind the advertiser, or behind the publisher. */
async function recipientOf(buyer: Buyer): Promise<string | null> {
  if (buyer.kind === 'ADVERTISER') return (await getAdvertiser(buyer.id)).userId ?? null;
  return (await findPublisherContact(buyer.id))?.userId ?? null;
}

export type PromotionNotice = 'APPROVED' | 'REJECTED' | 'LIVE' | 'ENDED' | 'CANCELLED';

type NotifyArgs = Parameters<typeof notify>;

/** Each notice's event, named literally so the events registry can read every call site. */
function raise(notice: PromotionNotice, userId: string, vars: NotifyArgs[2], options: NotifyArgs[3]) {
  switch (notice) {
    case 'APPROVED':
      return notify('PROMOTION_APPROVED', userId, vars, options);
    case 'REJECTED':
      return notify('PROMOTION_REJECTED', userId, vars, options);
    case 'LIVE':
      return notify('PROMOTION_LIVE', userId, vars, options);
    case 'ENDED':
      return notify('PROMOTION_ENDED', userId, vars, options);
    case 'CANCELLED':
      return notify('PROMOTION_CANCELLED', userId, vars, options);
  }
}

/**
 * The buyer's notice — the in-app row and the template's push and email
 * (`notifications`' PROMOTION_* events). Best-effort: a notice that cannot
 * be written never undoes the transition it describes.
 */
export async function noticeBuyer(
  buyer: Buyer,
  notice: PromotionNotice,
  input: { reference: string; what: string; dates: string; relatedId: string; title: string; message: string; reason?: string | null; amount?: Money | null },
): Promise<void> {
  try {
    const userId = await recipientOf(buyer);
    if (!userId) return;
    await raise(
      notice,
      userId,
      { reference: input.reference, what: input.what, dates: input.dates, reason: input.reason ?? '', amount: input.amount ?? '' },
      { inApp: { type: buyer.kind === 'ADVERTISER' ? 'BOOKING' : 'SYSTEM', title: input.title, message: input.message, relatedId: input.relatedId } },
    );
  } catch (err) {
    logger.warn('Could not tell the buyer about a paid placement', { reference: input.reference, notice, err });
  }
}

/** "12 Oct – 18 Oct 2026", as a notice and an invoice line print it. */
export function datesLabel(start: Date, end: Date): string {
  const short = (day: Date) => day.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const year = end.toLocaleDateString('en-IN', { year: 'numeric', timeZone: 'UTC' });
  return start.getTime() === end.getTime() ? `${short(start)} ${year}` : `${short(start)} – ${short(end)} ${year}`;
}
