import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { ensureWallet, move } from '../wallets';
import { commissionResolver } from './commission.port';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import type { AccruableSpot } from './payouts.repository';
import { withholdingFor } from './rules.service';

/**
 * Publisher earnings, a day at a time.
 *
 * The rule, as settled: entitlement is immediate and the money arrives as the
 * campaign runs — each day that passes adds that day's share to the wallet —
 * and it becomes withdrawable after a hold. Not at install, not at campaign
 * end. A publisher on a thirty-day flight sees their balance climb daily.
 *
 * Everything here is keyed on (spot, day). The job can be run twice, run late,
 * or run across a backfill window, and the unique index means each day is
 * earned exactly once. That matters more than usual: a scheduler that fires
 * twice must not pay twice.
 */

/**
 * Lot B (B1): the commission source an accrual records when the spot carried
 * no stamp — authorised before Q38 landed — and the run resolved the rate
 * itself, once, at the campaign's start.
 */
export const RESOLVED_AT_ACCRUAL = 'RESOLVED_AT_ACCRUAL';

/**
 * How long a day's earning waits before it can be withdrawn.
 *
 * "Withdraw after a week or so", read as seven days from each daily credit
 * rather than from the campaign's start — so a long flight pays out steadily
 * rather than in one lump a week in. Configurable because that reading is an
 * interpretation, and the other one is a single number away.
 */
export const CLEARING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export const atMidnight = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Which days of a flight have finished by now.
 *
 * A day is earned once it is over, so a campaign that started today has earned
 * nothing yet. Bounded by the spot's own flight so a late run cannot credit
 * days beyond the end of the campaign.
 */
export function elapsedDays(
  start: Date,
  end: Date,
  now: Date
): Date[] {
  const first = atMidnight(start);
  const last = atMidnight(end);
  const today = atMidnight(now);
  const days: Date[] = [];
  for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) {
    // Strictly before today: a day in progress has not been delivered.
    if (t < today.getTime()) days.push(new Date(t));
  }
  return days;
}

/**
 * What the advertiser is paying for one day of a spot: the unit rate times
 * the quantity booked. The live under-accrual was a run that split the unit
 * rate alone, so a publisher with three panels on one listing was paid for
 * one; `quantityBackfill` in `accrual-backfill.service.ts` puts that right.
 */
export function grossForDay(ratePerDay: Money, quantity: number): Money {
  return money(new Decimal(ratePerDay).times(Math.max(1, Math.floor(quantity))));
}

/**
 * One day's gross — `grossForDay`, rate × quantity — split three ways.
 * `commissionPct` and `taxPct` are percentages, as the Decimal(5,2) columns
 * hold them: 12.50 is twelve and a half percent.
 */
export function splitDay(
  dayGross: Money,
  commissionPct: Money,
  taxPct: Money
): { gross: Money; commission: Money; taxWithheld: Money; net: Money } {
  const gross = new Decimal(money(dayGross));
  const commission = new Decimal(money(gross.times(new Decimal(commissionPct)).dividedBy(100)));
  // Tax is on what the publisher actually earns, not on the advertiser's gross.
  const taxable = gross.minus(commission);
  const taxWithheld = new Decimal(money(taxable.times(new Decimal(taxPct)).dividedBy(100)));
  return {
    gross: money(gross),
    commission: money(commission),
    taxWithheld: money(taxWithheld),
    net: money(gross.minus(commission).minus(taxWithheld)),
  };
}

export type AccrualRun = {
  spotsConsidered: number;
  daysCredited: number;
  totalNet: Money;
  skipped: number;
};

/**
 * The commission a spot accrues at, as a percentage for the Decimal(5,2)
 * column, and which instrument set it.
 *
 * The stamp wins whenever there is one: it is the rate the quote resolved
 * when the advertiser authorised, and a rate change since must not re-rate
 * a running flight. A spot with no stamp is resolved once, at the campaign's
 * start — the rate that would have been stamped — through the port bootstrap
 * fills from `revenue`, and the accrual says `RESOLVED_AT_ACCRUAL`.
 */
async function commissionFor(
  spot: AccruableSpot,
  flightStart: Date
): Promise<{ ratePct: Money; source: string }> {
  if (spot.commissionPct !== null && spot.commissionPct !== undefined) {
    return {
      ratePct: new Decimal(spot.commissionPct).times(100).toFixed(2),
      source: spot.commissionSource ?? 'STAMPED',
    };
  }
  const resolved = await commissionResolver().resolve({
    listingId: spot.listing.id,
    ratePerDay: money(spot.ratePerDay),
    at: flightStart,
  });
  return { ratePct: new Decimal(resolved.ratePct).times(100).toFixed(2), source: RESOLVED_AT_ACCRUAL };
}

/**
 * Credits every day of every live spot that has finished and is not yet paid.
 *
 * Run by the scheduler. Deliberately tolerant: one spot that fails does not
 * stop the rest, because a single bad row must not stall every publisher's
 * earnings.
 */
export async function runDailyAccrual(now = new Date()): Promise<AccrualRun> {
  const spots = await repository.findAccruableSpots();

  let daysCredited = 0;
  let skipped = 0;
  let total = new Decimal(0);

  for (const spot of spots) {
    const start = spot.campaign.startDate;
    const end = spot.campaign.endDate;
    if (!start || !end || !spot.listing.publisherId) {
      skipped += 1;
      continue;
    }
    // Lot A STOP_ACCRUAL, re-checked here so a spot read before the scope
    // landed is still skipped. The days are not earned later either: the
    // (spot, day) key is simply never written for a suspended day.
    if ((spot.listing.suspensionScopes ?? []).includes('STOP_ACCRUAL')) {
      skipped += 1;
      continue;
    }

    const days = elapsedDays(start, end, now);
    if (days.length === 0) continue;

    const already = await repository.findAccruedDates(spot.id);
    const seen = new Set(already.map((date) => atMidnight(date).getTime()));
    const due = days.filter((day) => !seen.has(day.getTime()));
    if (due.length === 0) continue;

    const dayGross = grossForDay(money(spot.ratePerDay), spot.quantity ?? 1);
    const tax = await withholdingFor('PUBLISHER', dayGross, now);
    const publisherId = spot.listing.publisherId;

    let commission: { ratePct: Money; source: string };
    try {
      commission = await commissionFor(spot, start);
    } catch (error) {
      // No stamp and no resolver: skip rather than guess. A placeholder
      // percentage is the thing this run no longer has.
      skipped += 1;
      logger.warn('Daily accrual could not resolve a commission for a spot', {
        spotId: spot.id,
        reason: String(error),
      });
      continue;
    }

    for (const day of due) {
      try {
        const split = splitDay(dayGross, commission.ratePct, tax.ratePct);
        const wallet = await ensureWallet(
          { kind: 'PUBLISHER', id: publisherId },
          'Publisher wallet'
        );

        // The advertiser's side is not here. B3a posts CAMPAIGN_SPEND when the
        // hold is captured — wallet − / platform:payables + for the whole
        // booking — and this releases each day's gross out of payables. A
        // second spend leg per day would count the booking twice.
        const result = await move({
          walletId: wallet.id,
          walletLabel: 'Publisher wallet',
          amount: split.net,
          entryType: 'EARNING',
          ledgerKind: 'PUBLISHER_EARNING',
          // One key per spot per day: the whole idempotency story in one string.
          idempotencyKey: `accrual:${spot.id}:${day.toISOString().slice(0, 10)}`,
          counterLegs: [
            { accountCode: 'platform:payables', amount: money(new Decimal(split.gross).negated()) },
            ...(new Decimal(split.commission).isZero()
              ? []
              : [{ accountCode: 'platform:revenue', amount: split.commission, note: 'ADX commission' }]),
            ...(new Decimal(split.taxWithheld).isZero()
              ? []
              : [{ accountCode: 'platform:tax-withheld', amount: split.taxWithheld, note: 'TDS on publisher earning' }]),
          ],
          campaignId: spot.campaign.id,
          orderId: spot.orderId,
          reference: spot.id,
          note: `${spot.listing.title} · ${day.toISOString().slice(0, 10)}`,
          occurredAt: day,
        });

        await repository.createAccrual({
          publisherId,
          listingId: spot.listing.id,
          campaignSpotId: spot.id,
          forDate: day,
          gross: new Decimal(split.gross),
          commission: new Decimal(split.commission),
          taxWithheld: new Decimal(split.taxWithheld),
          net: new Decimal(split.net),
          commissionRatePct: new Decimal(commission.ratePct),
          commissionSource: commission.source,
          taxRatePct: new Decimal(tax.ratePct),
          clearsAt: new Date(day.getTime() + CLEARING_DAYS * DAY_MS),
          walletEntryId: result.entry?.id ?? null,
          ledgerTransactionId: result.ledgerTransactionId,
        });

        daysCredited += 1;
        total = total.plus(new Decimal(split.net));
      } catch (error) {
        // One spot failing must not stall every other publisher's earnings.
        skipped += 1;
        logger.warn('Daily accrual failed for a spot', {
          spotId: spot.id,
          day: day.toISOString().slice(0, 10),
          reason: String(error),
        });
      }
    }
  }

  return {
    spotsConsidered: spots.length,
    daysCredited,
    totalNet: money(total),
    skipped,
  };
}

/** What a publisher has earned, and what is still inside its clearing window. */
export async function earningsSummary(publisherId: string, now = new Date()) {
  const [all, pending] = await Promise.all([
    repository.sumAccruals(publisherId),
    repository.sumAccruals(publisherId, now),
  ]);

  return {
    grossEarned: money(all.gross),
    commission: money(all.commission),
    taxWithheld: money(all.taxWithheld),
    netEarned: money(all.net),
    daysEarned: all.count,
    pendingClearance: money(pending.net),
    pendingDays: pending.count,
  };
}

export function listAccruals(publisherId: string, limit = 100) {
  return repository.listAccruals(publisherId, Math.min(limit, 400));
}

/**
 * Lot B (Q13): what `invoices` itemises on a publisher's monthly payment
 * advice — every day earned in [from, to), and who earned anything at all.
 * Reads only; the accrual itself stays this module's.
 */
export const listAccrualsForPeriod = (publisherId: string, from: Date, to: Date) =>
  repository.listAccrualsForPeriod(publisherId, from, to);

export const publisherIdsWithAccruals = (from: Date, to: Date) =>
  repository.publisherIdsWithAccruals(from, to);
