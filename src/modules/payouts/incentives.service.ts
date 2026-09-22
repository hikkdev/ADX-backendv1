import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { getPlatformSettings } from '../app-config';
import { createNotification, type IncentiveRecordedPayload, type RelatedType } from '../notifications';
import { ensureWallet, move } from '../wallets';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import { withholdingFor } from './rules.service';
import type { IncentiveEvent, IncentiveStatus } from '../../shared/database';
import type { IncentiveRow } from './payouts.repository';

/**
 * What an agent earns for the work they do.
 *
 * Two decisions shape this. **Ops verifies before anything is credited** — an
 * incentive is earned when the work happens and paid when a person has checked
 * it, never automatically on order completion. And **the rate in force at the
 * time is copied onto the row**, so a promotion or a repricing cannot
 * retrospectively re-rate work already done.
 *
 * Tax is withheld here rather than at withdrawal, because this is the moment
 * the income arises.
 */

/** The rates DR 04 prints, seeded so the screens have something true to show. */
export const DEFAULT_INCENTIVE_RATES: {
  event: IncentiveEvent;
  tier: string;
  amount: Money;
}[] = [
  { event: 'PUBLISHER_ONBOARDED', tier: '*', amount: '2000.00' },
  { event: 'SITE_VISIT', tier: '*', amount: '500.00' },
  { event: 'CAMPAIGN_ASSIST', tier: '*', amount: '750.00' },
  { event: 'MILESTONE_BONUS', tier: '*', amount: '5000.00' },
  // DR 06 decision 16: "₹2,500 comm." on a package-sale card had no source.
  { event: 'PACKAGE_SOLD', tier: '*', amount: '2500.00' },
  // Lot B (Q102): the flat installation commission, the figure the offer
  // sheet prints when the platform is not on PER_ORDER.
  { event: 'INSTALLATION', tier: '*', amount: '1450.00' },
  // Lot B (Q101): the advertiser-side twin of PUBLISHER_ONBOARDED, at the
  // same figure.
  { event: 'ADVERTISER_ONBOARDED', tier: '*', amount: '2000.00' },
  // LH2/LH8 (the Lead Hunt, D1): the hunt's own events, stacked on the
  // onboarding incentives. A rate may be qualified by the lead's side as
  // `TIER:SIDE` — `*:ADVERTISER` is every tier's advertiser figure.
  { event: 'LEAD_CONVERTED', tier: '*', amount: '100.00' },
  { event: 'LEAD_ACTIVATED', tier: '*', amount: '500.00' },
  { event: 'LEAD_ACTIVATED', tier: '*:ADVERTISER', amount: '750.00' },
  { event: 'LEAD_RETAINED', tier: '*', amount: '100.00' },
];

let seeded: Promise<void> | null = null;

export async function ensureIncentiveRates(): Promise<void> {
  seeded ??= (async () => {
    const existing = await repository.listIncentiveRates();
    // Every default whose event has no row at all is seeded — a platform
    // that priced the seven old events keeps them and gains the lead ones.
    const priced = new Set(existing.map((rate) => rate.event));
    for (const rate of DEFAULT_INCENTIVE_RATES) {
      if (priced.has(rate.event)) continue;
      await repository.upsertIncentiveRate({
        event: rate.event,
        tier: rate.tier,
        amount: new Decimal(rate.amount),
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
      });
    }
  })();
  await seeded;
}

export function resetIncentiveCache(): void {
  seeded = null;
}

export const listIncentiveRates = async () => {
  await ensureIncentiveRates();
  return repository.listIncentiveRates();
};

export async function setIncentiveRate(input: {
  event: IncentiveEvent;
  tier?: string;
  amount: Money;
  effectiveFrom: Date;
}) {
  await ensureIncentiveRates();
  return repository.upsertIncentiveRate({
    event: input.event,
    tier: input.tier ?? '*',
    amount: new Decimal(input.amount),
    effectiveFrom: input.effectiveFrom,
  });
}

/**
 * Records that an agent earned something. Does not pay it.
 *
 * The row lands in PENDING_VERIFICATION and stays there until ops looks at it,
 * which is the whole point: the agent's screen can show what they are owed
 * while the money has not moved.
 */
/**
 * What the platform currently pays for one kind of work, as a decimal string.
 *
 * Exported because DR 06's lead card prints "Est. ₹1,450" — an estimate of the
 * agent's commission for converting a prospect. That figure has to be the one
 * the platform actually pays, or it is worse than no figure at all; so the lead
 * domain reads the rate rather than storing a number somebody typed.
 *
 * Null when no rate is configured, which the caller prints as nothing.
 */
export async function rateFor(
  event: IncentiveEvent,
  tier = '*',
  now = new Date(),
  side?: 'PUBLISHER' | 'ADVERTISER'
): Promise<string | null> {
  await ensureIncentiveRates();
  const rate = await repository.findIncentiveRate(event, tier, now, side);
  return rate ? money(rate.amount) : null;
}

/**
 * Lot B (Q102): what an agent is paid for putting one order up.
 *
 * Two modes, one platform setting (`installation.commissionMode`). FLAT pays
 * the rate table's INSTALLATION row at the agent's tier. PER_ORDER pays the
 * figure ops typed on the order at assign or print-ready
 * (`Order.agentFeeAmount`), and falls back to the flat rate when nobody typed
 * one — an order is never priced at nothing because a field was left blank.
 *
 * The settings read failing falls to FLAT too, for the same reason. Null when
 * no rate is configured at all; the caller prints nothing, never zero.
 */
export async function installationFeeFor(
  order: { agentFeeAmount: Decimal | string | number | null | undefined },
  tier = '*',
  now = new Date()
): Promise<Money | null> {
  const mode = await getPlatformSettings()
    .then((settings) => settings.installation.commissionMode)
    .catch(() => 'FLAT' as const);
  if (mode === 'PER_ORDER' && order.agentFeeAmount !== null && order.agentFeeAmount !== undefined) {
    return money(order.agentFeeAmount);
  }
  return rateFor('INSTALLATION', tier, now);
}

/**
 * Lot F (E7-1): what the agent's INCENTIVE_RECORDED notice prints beside the
 * event and the amount — the party the work was for, and the campaign when
 * it was an assist. Optional: a caller that names nothing still gets the
 * notice, with the note standing in for the name.
 */
export type IncentiveNotice = { partyName?: string | null; campaignId?: string | null };

export type IncentiveInput = {
  agentId: string;
  event: IncentiveEvent;
  tier: string;
  orderId?: string | null;
  publisherId?: string | null;
  advertiserId?: string | null;
  note?: string | null;
  amount?: Money | null;
  notice?: IncentiveNotice;
  /** LH2: the lead's side, for a rate qualified `TIER:SIDE`. */
  side?: 'PUBLISHER' | 'ADVERTISER' | null;
};

/**
 * `recordIncentive`, keyed on what it is for.
 *
 * An installation is signed off once per order, an onboarding happens once per
 * party — and the paths that record them are retried by phones and re-run by
 * admins. The first row for (event, orderId | publisherId | advertiserId)
 * stands; a second call returns it rather than paying twice. Which key applies
 * is the first of the three that is set, in that order.
 */
export async function recordIncentiveOnce(input: IncentiveInput, now = new Date()) {
  const key = input.orderId
    ? { orderId: input.orderId }
    : input.publisherId
      ? { publisherId: input.publisherId }
      : input.advertiserId
        ? { advertiserId: input.advertiserId }
        : null;
  if (key) {
    const existing = await repository.findIncentiveFor(input.event, key);
    if (existing) return existing;
  }
  return recordIncentive(input, now);
}

export async function recordIncentive(
  input: {
    agentId: string;
    event: IncentiveEvent;
    tier: string;
    orderId?: string | null;
    publisherId?: string | null;
    advertiserId?: string | null;
    note?: string | null;
    /**
     * The amount, when the event carries its own. A MILESTONE_BONUS pays what
     * the milestone's template promised — "₹5,000 REWARD" on the card — not a
     * flat rate, so the rate table's row for it is a fallback for a template
     * that names no reward, never the figure. Every other event prices from
     * the effective-dated rate as before.
     */
    amount?: Money | null;
    notice?: IncentiveNotice;
    side?: 'PUBLISHER' | 'ADVERTISER' | null;
  },
  now = new Date()
) {
  await ensureIncentiveRates();
  const rate = await repository.findIncentiveRate(input.event, input.tier, now, input.side ?? undefined);
  if (!rate && !input.amount) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `No incentive rate is configured for ${input.event} at tier ${input.tier}`
    );
  }

  const amount = money(input.amount ?? rate!.amount);
  const tax = await withholdingFor('AGENT', amount, now);

  const incentive = await repository.createIncentive({
    agentId: input.agentId,
    event: input.event,
    tier: input.tier,
    rateId: rate?.id ?? null,
    amount: new Decimal(amount),
    taxWithheld: new Decimal(tax.taxWithheld),
    taxRatePct: new Decimal(tax.ratePct),
    netAmount: new Decimal(money(new Decimal(amount).minus(new Decimal(tax.taxWithheld)))),
    orderId: input.orderId ?? null,
    publisherId: input.publisherId ?? null,
    advertiserId: input.advertiserId ?? null,
    note: input.note ?? null,
  });
  await tellAgentIncentiveRecorded(incentive, input.notice);
  return incentive;
}

/** The three events the frames draw as a modal the moment they are earned. */
export const INCENTIVE_NOTICE_EVENTS: readonly IncentiveEvent[] = ['CAMPAIGN_ASSIST', 'ADVERTISER_ONBOARDED', 'PUBLISHER_ONBOARDED'];

export const INCENTIVE_RECORDED_EVENT = 'INCENTIVE_RECORDED';

const EVENT_LABEL: Partial<Record<IncentiveEvent, string>> = {
  CAMPAIGN_ASSIST: 'Campaign assist',
  ADVERTISER_ONBOARDED: 'Advertiser onboarded',
  PUBLISHER_ONBOARDED: 'Publisher onboarded',
};

/**
 * Lot F (E7-1): the agent is told, in-app, that an incentive was recorded —
 * `{ event, amount, campaignId?, partyName }`: the event in the title, the
 * amount in the subtitle, the party in the message, `relatedId` the campaign
 * (an assist) or the party the row names, so the tap lands on the thing the
 * money is for. E9: the same facts ride the row's `payload` —
 * `{ event, amount, campaignId, partyName }` — and `relatedType` says what
 * `relatedId` opens. Recorded, not paid: the message says ops still verify
 * it. Never a failure of the record itself.
 */
export function incentiveRecordedNotice(
  incentive: Pick<IncentiveRow, 'id' | 'event' | 'amount' | 'orderId' | 'publisherId' | 'advertiserId' | 'note'>,
  notice: IncentiveNotice | undefined,
): (Omit<Parameters<typeof createNotification>[0], 'userId'> & { payload: IncentiveRecordedPayload }) | null {
  if (!INCENTIVE_NOTICE_EVENTS.includes(incentive.event)) return null;
  const amount = money(incentive.amount);
  const partyName = notice?.partyName?.trim() || incentive.note?.trim() || 'the account';
  const label = EVENT_LABEL[incentive.event] ?? incentive.event;
  const related: { relatedId: string; relatedType: RelatedType | undefined } = notice?.campaignId
    ? { relatedId: notice.campaignId, relatedType: 'CAMPAIGN' }
    : incentive.publisherId
      ? { relatedId: incentive.publisherId, relatedType: 'PUBLISHER' }
      : incentive.advertiserId
        ? { relatedId: incentive.advertiserId, relatedType: 'ADVERTISER' }
        : incentive.orderId
          ? { relatedId: incentive.orderId, relatedType: 'ORDER' }
          : { relatedId: incentive.id, relatedType: undefined };
  return {
    type: 'PAYOUT',
    title: `${label}: ₹${amount} recorded`,
    subtitle: `₹${amount}`,
    message: `${label} for ${partyName} — ₹${amount} recorded, paid once ops verify it. (${INCENTIVE_RECORDED_EVENT}:${incentive.event})`,
    suggestedAction: 'View earnings',
    ...related,
    payload: { event: incentive.event, amount, campaignId: notice?.campaignId ?? null, partyName },
  };
}

async function tellAgentIncentiveRecorded(incentive: IncentiveRow, notice: IncentiveNotice | undefined): Promise<void> {
  const body = incentiveRecordedNotice(incentive, notice);
  if (!body) return;
  try {
    const recipient = await repository.findIncentiveRecipient(incentive.agentId);
    if (!recipient) return;
    await createNotification({ userId: recipient.userId, ...body });
  } catch (err) {
    logger.warn('Incentive-recorded notice was not sent', { incentiveId: incentive.id, reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Ops checks the work and the money moves.
 *
 * Idempotent on the incentive id, so a double-tapped Verify credits once.
 */
export async function creditIncentive(
  incentiveId: string,
  input: { byUserId: string },
  now = new Date()
) {
  const incentive = await repository.findIncentive(incentiveId);
  if (!incentive) throw new ApiError(404, 'NOT_FOUND', 'Incentive not found');
  if (incentive.status === 'CREDITED') return incentive;
  if (incentive.status === 'REJECTED') {
    throw new ApiError(409, 'CONFLICT', 'That incentive was rejected.');
  }

  const wallet = await ensureWallet({ kind: 'AGENT', id: incentive.agentId }, 'Agent wallet');

  const gross = money(incentive.amount);
  const tax = money(incentive.taxWithheld);
  const net = money(incentive.netAmount);

  const result = await move({
    walletId: wallet.id,
    walletLabel: 'Agent wallet',
    amount: net,
    entryType: incentive.event === 'MILESTONE_BONUS' ? 'BONUS' : 'EARNING',
    ledgerKind: 'AGENT_INCENTIVE',
    idempotencyKey: `incentive:${incentive.id}`,
    counterLegs: [
      { accountCode: 'platform:payables', amount: money(new Decimal(gross).negated()) },
      ...(new Decimal(tax).isZero()
        ? []
        : [{ accountCode: 'platform:tax-withheld', amount: tax, note: 'TDS on agent incentive' }]),
    ],
    reference: incentive.id,
    orderId: incentive.orderId,
    note: `${incentive.event.replace(/_/g, ' ').toLowerCase()} incentive`,
    createdByUserId: input.byUserId,
    occurredAt: now,
  });

  return repository.updateIncentive(incentiveId, {
    status: 'CREDITED',
    verifiedAt: now,
    verifiedByUserId: input.byUserId,
    walletEntryId: result.entry?.id ?? null,
    ledgerTransactionId: result.ledgerTransactionId,
  });
}

export async function rejectIncentive(
  incentiveId: string,
  input: { byUserId: string; reason: string },
  now = new Date()
) {
  if (!input.reason.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the incentive was refused.');
  }
  const incentive = await repository.findIncentive(incentiveId);
  if (!incentive) throw new ApiError(404, 'NOT_FOUND', 'Incentive not found');
  if (incentive.status === 'CREDITED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'That has already been paid. Reverse it with an adjustment rather than rejecting it.'
    );
  }
  return repository.updateIncentive(incentiveId, {
    status: 'REJECTED',
    verifiedAt: now,
    verifiedByUserId: input.byUserId,
    rejectionReason: input.reason.trim(),
  });
}

/**
 * LH10 (the Lead Hunt): the clawback.
 *
 * An incentive that was earned on something that did not last — the catch
 * paid on an account that closed, or a listing that came down inside the
 * watch window — comes back. Money that never moved is simply refused with
 * the reason (the same REJECTED the desk writes by hand); money that moved
 * is **reversed**: an equal and opposite movement out of the agent's wallet
 * under `REVERSAL`, so the ledger holds both legs and nothing is edited in
 * place. Idempotent on the incentive, so a watch that runs twice claws back
 * once.
 *
 * The agent is told (the caller notifies) and the write is audited by the
 * caller; this door only moves the money and stamps the row.
 */
export async function clawbackIncentive(
  incentiveId: string,
  input: { reason: string; byUserId?: string | null },
  now = new Date()
) {
  if (!input.reason.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the incentive is being clawed back.');
  }
  const incentive = await repository.findIncentive(incentiveId);
  if (!incentive) throw new ApiError(404, 'NOT_FOUND', 'Incentive not found');
  if (incentive.status === 'REVERSED') return incentive;
  if (incentive.status === 'REJECTED') {
    throw new ApiError(409, 'CONFLICT', 'That incentive was already refused; there is nothing to claw back.');
  }

  // Nothing moved yet: the row is refused with the reason, and the money
  // never leaves the platform.
  if (incentive.status === 'PENDING_VERIFICATION') {
    return repository.updateIncentive(incentiveId, {
      status: 'REVERSED',
      reversedAt: now,
      reversalReason: input.reason.trim(),
      ...(input.byUserId ? { verifiedByUserId: input.byUserId } : {}),
    });
  }

  const wallet = await ensureWallet({ kind: 'AGENT', id: incentive.agentId }, 'Agent wallet');
  const gross = money(incentive.amount);
  const tax = money(incentive.taxWithheld);
  const net = money(incentive.netAmount);
  const result = await move({
    walletId: wallet.id,
    walletLabel: 'Agent wallet',
    amount: money(new Decimal(net).negated()),
    entryType: 'ADJUSTMENT',
    ledgerKind: 'REVERSAL',
    idempotencyKey: `incentive-clawback:${incentive.id}`,
    counterLegs: [
      { accountCode: 'platform:payables', amount: gross },
      ...(new Decimal(tax).isZero() ? [] : [{ accountCode: 'platform:tax-withheld', amount: money(new Decimal(tax).negated()), note: 'TDS reversed with the incentive' }]),
    ],
    reference: incentive.id,
    orderId: incentive.orderId,
    note: `${incentive.event.replace(/_/g, ' ').toLowerCase()} clawed back: ${input.reason.trim()}`,
    createdByUserId: input.byUserId ?? null,
    occurredAt: now,
    // The wallet may be frozen for other reasons; money coming BACK to the
    // platform is never what a freeze is protecting against.
    allowFrozen: true,
  });

  return repository.updateIncentive(incentiveId, {
    status: 'REVERSED',
    reversedAt: now,
    reversalReason: input.reason.trim(),
    reversalLedgerTransactionId: result.ledgerTransactionId,
  });
}

export const listIncentives = (filter: {
  agentId?: string;
  /** Lot B: the finance queue's per-order facet — "what was this order's commission?" */
  orderId?: string;
  status?: IncentiveStatus[];
  events?: IncentiveEvent[];
  /** E6: the note, the order id or the agent's name, contains. */
  q?: string;
  cursor?: string;
  limit?: number;
}) => repository.listIncentives({ ...filter, limit: Math.min(filter.limit ?? 50, 201) });

/** The three figures the earnings frame prints across its header. */
export async function incentiveSummary(agentId: string) {
  const [credited, pending, byEvent] = await Promise.all([
    repository.sumIncentives(agentId, 'CREDITED'),
    repository.sumIncentives(agentId, 'PENDING_VERIFICATION'),
    repository.countIncentivesByEvent(agentId),
  ]);

  const counts = Object.fromEntries(byEvent.map((row) => [row.event, row.count]));
  return {
    creditedTotal: money(credited.total),
    creditedCount: credited.count,
    /** Earned, waiting on ops. The frame's "credited within 24h" line. */
    pendingTotal: money(pending.total),
    pendingCount: pending.count,
    publishersOnboarded: counts['PUBLISHER_ONBOARDED'] ?? 0,
    siteVisits: counts['SITE_VISIT'] ?? 0,
    campaignAssists: counts['CAMPAIGN_ASSIST'] ?? 0,
    milestoneBonuses: counts['MILESTONE_BONUS'] ?? 0,
    /** Lot B: the two events B3b added, counted the same way. */
    installations: counts['INSTALLATION'] ?? 0,
    advertisersOnboarded: counts['ADVERTISER_ONBOARDED'] ?? 0,
  };
}
