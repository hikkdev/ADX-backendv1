import { findActivityRows, logActivity, auditDiff } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { createNotification } from '../notifications';
import { ensureWallet, move } from '../wallets';
import { grossForDay } from './accrual.service';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import type { UnderAccruedSpot } from './payouts.repository';

/**
 * Lot B (B1, Q135): paying back the days the run under-accrued.
 *
 * Until this package the daily accrual split the unit rate alone, so a
 * publisher with three panels booked on one listing was paid for one. The
 * fix in `accrual.service.ts` is forward-only; this is the other half — one
 * correcting movement per spot for every day that was posted at the unit
 * rate, split exactly as the accrual would have split it (payables releases
 * the missing gross, the publisher gets the net, ADX its commission, the
 * tax authority its withholding), under the rates the day was accrued at.
 *
 * Three rules:
 *
 * - **Dry run by default.** The console reads the list before anybody presses
 *   the button; the execute is a second call with `dryRun: false`.
 * - **The accrual rows stand.** They are the history of what was paid; the
 *   correction is its own ADJUSTMENT with a reason, on the ledger and the
 *   statement, and an `ACCRUAL_QUANTITY_CORRECTED` audit row against the
 *   spot that names both figures.
 * - **Idempotent on the audit row, and on the ledger key underneath it.** A
 *   spot with the audit row is skipped, whatever its accrual rows still say;
 *   a retry that somehow gets past that lands on `accrual-quantity-fix:<spot>`
 *   and the ledger returns the movement it already has.
 */

export const ACCRUAL_QUANTITY_CORRECTED = 'ACCRUAL_QUANTITY_CORRECTED';
/** The event the publisher is told about. Carried in the notice's subtitle. */
export const PUBLISHER_ACCRUAL_CORRECTED = 'PUBLISHER_ACCRUAL_CORRECTED';

export type QuantityBackfillRow = {
  spotId: string;
  campaignId: string;
  orderId: string | null;
  listingId: string;
  listingTitle: string;
  publisherId: string;
  publisherUserId: string | null;
  ratePerDay: Money;
  quantity: number;
  /** Days that were posted at the unit rate. */
  days: number;
  firstDay: string;
  lastDay: string;
  grossPosted: Money;
  grossDue: Money;
  missingGross: Money;
  missingCommission: Money;
  missingTax: Money;
  /** What the wallet is owed. */
  missingNet: Money;
};

export type QuantityBackfillResult = {
  dryRun: boolean;
  spots: QuantityBackfillRow[];
  totals: { spots: number; days: number; missingGross: Money; missingNet: Money };
  /** Spots the audit trail says were already put right; not listed. */
  alreadyCorrected: number;
  corrected: number;
  failed: { spotId: string; reason: string }[];
};

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The correction for one spot: every accrued day whose posted gross equals
 * the unit rate is owed rate × (quantity − 1), split under that day's own
 * commission and tax percentages. Null when nothing is owed.
 */
export function correctionFor(spot: UnderAccruedSpot): QuantityBackfillRow | null {
  if (spot.quantity <= 1 || !spot.listing.publisherId) return null;
  const rate = new Decimal(money(spot.ratePerDay));
  const dayGross = new Decimal(grossForDay(money(rate), spot.quantity));
  const short = spot.accruals.filter((row) => new Decimal(row.gross).equals(rate));
  if (short.length === 0) return null;

  let grossPosted = new Decimal(0);
  let missingGross = new Decimal(0);
  let missingCommission = new Decimal(0);
  let missingTax = new Decimal(0);
  for (const row of short) {
    const missing = dayGross.minus(rate);
    const commission = new Decimal(money(missing.times(row.commissionRatePct).dividedBy(100)));
    const tax = new Decimal(money(missing.minus(commission).times(row.taxRatePct).dividedBy(100)));
    grossPosted = grossPosted.plus(row.gross);
    missingGross = missingGross.plus(missing);
    missingCommission = missingCommission.plus(commission);
    missingTax = missingTax.plus(tax);
  }
  const missingNet = missingGross.minus(missingCommission).minus(missingTax);

  return {
    spotId: spot.id,
    campaignId: spot.campaignId,
    orderId: spot.orderId,
    listingId: spot.listing.id,
    listingTitle: spot.listing.title,
    publisherId: spot.listing.publisherId,
    publisherUserId: spot.listing.publisherUserId,
    ratePerDay: money(rate),
    quantity: spot.quantity,
    days: short.length,
    firstDay: iso(short[0]!.forDate),
    lastDay: iso(short[short.length - 1]!.forDate),
    grossPosted: money(grossPosted),
    grossDue: money(dayGross.times(short.length)),
    missingGross: money(missingGross),
    missingCommission: money(missingCommission),
    missingTax: money(missingTax),
    missingNet: money(missingNet),
  };
}

/** Spot ids the trail already records as corrected. */
async function correctedSpotIds(): Promise<Set<string>> {
  const rows = await findActivityRows(
    { action: ACCRUAL_QUANTITY_CORRECTED, targetType: 'CampaignSpot' },
    { skip: 0, take: 10_000, sort: 'newest' }
  );
  return new Set(rows.map((row) => row.targetId).filter((id): id is string => Boolean(id)));
}

export async function quantityBackfill(
  input: { dryRun: boolean; byUserId: string; requestId?: string | undefined },
  now = new Date()
): Promise<QuantityBackfillResult> {
  const [candidates, done] = await Promise.all([repository.findUnderAccruedSpots(), correctedSpotIds()]);

  let alreadyCorrected = 0;
  const rows: QuantityBackfillRow[] = [];
  for (const spot of candidates) {
    const row = correctionFor(spot);
    if (!row) continue;
    if (done.has(spot.id)) {
      alreadyCorrected += 1;
      continue;
    }
    rows.push(row);
  }

  const totals = {
    spots: rows.length,
    days: rows.reduce((sum, row) => sum + row.days, 0),
    missingGross: money(rows.reduce((sum, row) => sum.plus(row.missingGross), new Decimal(0))),
    missingNet: money(rows.reduce((sum, row) => sum.plus(row.missingNet), new Decimal(0))),
  };

  if (input.dryRun) {
    return { dryRun: true, spots: rows, totals, alreadyCorrected, corrected: 0, failed: [] };
  }

  let corrected = 0;
  const failed: { spotId: string; reason: string }[] = [];

  for (const row of rows) {
    const reason = `Accrual corrected for quantity ${row.quantity} on ${row.listingTitle}: ${row.days} day(s) ${row.firstDay}–${row.lastDay} were paid at the unit rate`;
    try {
      const wallet = await ensureWallet({ kind: 'PUBLISHER', id: row.publisherId }, 'Publisher wallet');
      const result = await move({
        walletId: wallet.id,
        walletLabel: 'Publisher wallet',
        amount: row.missingNet,
        entryType: 'ADJUSTMENT',
        ledgerKind: 'ADJUSTMENT',
        idempotencyKey: `accrual-quantity-fix:${row.spotId}`,
        counterLegs: [
          {
            accountCode: 'platform:payables',
            amount: money(new Decimal(row.missingGross).negated()),
            note: 'Media delivered, released for the quantity the accrual missed',
          },
          ...(new Decimal(row.missingCommission).isZero()
            ? []
            : [{ accountCode: 'platform:revenue', amount: row.missingCommission, note: 'ADX commission' }]),
          ...(new Decimal(row.missingTax).isZero()
            ? []
            : [{ accountCode: 'platform:tax-withheld', amount: row.missingTax, note: 'TDS on publisher earning' }]),
        ],
        campaignId: row.campaignId,
        orderId: row.orderId,
        reference: row.spotId,
        note: reason,
        occurredAt: now,
        createdByUserId: input.byUserId,
      });

      await logActivity(input.byUserId, ACCRUAL_QUANTITY_CORRECTED, {
        targetType: 'CampaignSpot',
        targetId: row.spotId,
        module: 'payouts',
        requestId: input.requestId,
        diff: auditDiff({ gross: row.grossPosted }, { gross: row.grossDue }),
        metadata: {
          publisherId: row.publisherId,
          listingId: row.listingId,
          campaignId: row.campaignId,
          quantity: row.quantity,
          days: row.days,
          firstDay: row.firstDay,
          lastDay: row.lastDay,
          missingGross: row.missingGross,
          missingCommission: row.missingCommission,
          missingTax: row.missingTax,
          missingNet: row.missingNet,
          ledgerTransactionId: result?.ledgerTransactionId ?? null,
          walletEntryId: result?.entry?.id ?? null,
          reason,
        },
      });

      if (row.publisherUserId) {
        await createNotification({
          userId: row.publisherUserId,
          type: 'PAYOUT',
          title: 'Earnings corrected',
          subtitle: PUBLISHER_ACCRUAL_CORRECTED,
          message: `₹${row.missingNet} has been added to your wallet: ${row.days} day(s) on ${row.listingTitle} (${row.firstDay} to ${row.lastDay}) were paid for one unit instead of ${row.quantity}.`,
          suggestedAction: 'Open your wallet statement',
          relatedId: row.spotId,
        }).catch((err: unknown) =>
          logger.warn('Accrual correction notice not delivered', { spotId: row.spotId, err: String(err) })
        );
      }

      corrected += 1;
    } catch (error) {
      // One spot failing must not stop the rest — and a spot the wallet
      // refused gets no audit row, so the next run offers it again.
      failed.push({ spotId: row.spotId, reason: String(error) });
      logger.warn('Accrual quantity correction failed for a spot', { spotId: row.spotId, reason: String(error) });
    }
  }

  return { dryRun: false, spots: rows, totals, alreadyCorrected, corrected, failed };
}
