import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { getOrderSummary } from '../orders';
import type { OrderPrintJob, PickupPoint } from '../orders';
import { withholdingFor } from '../payouts';
import { ensureWallet, move } from '../wallets';
import { prismaPrintPartnersRepository as repository } from './prisma-print-partners.repository';
import { walletLabelFor } from './print-partners.service';
import type { JobWithPartner } from './print-partners.repository';
import type { OpenJobInput, UpdateJobInput } from './print-partners.schema';
import type { PrintJobStatus } from '../../shared/database';

/**
 * Print jobs — one per order, at a print partner, paid at cost approval
 * (owner decision 122).
 *
 * The ladder is REQUESTED → ACCEPTED → PRINTING → READY → COLLECTED, entered
 * by ops as the shop reports back; CANCELLED from any rung before the cost
 * is approved. Forward only: a rung may be skipped (ops records what they
 * know) and never walked back, because a job that was READY and is now
 * PRINTING again is two jobs and a reason, not an edit. The agent's
 * collect-prints step marks COLLECTED through the port `orders` declares.
 *
 * The money is one movement. Approving the cost posts PRINT_COST into the
 * partner's wallet — wallet +net, `platform:cost-of-sales` −gross,
 * `platform:tax-withheld` +tax under 194C — keyed on the job, so a second
 * approval returns the first. The wallet then holds net-of-tax money and the
 * withdrawal deducts nothing, the same rule every other party is paid under.
 */

/** An order is printable once the publisher has accepted it, until it is cancelled. */
export const PRINTABLE_ORDER_STATUSES = new Set([
  'PENDING_PRINT',
  'SELF_INSTALL',
  'PENDING_AGENT',
  'AGENT_REJECTED',
  'SLOT_PROPOSED',
  'SLOT_CONFIRMED',
  'IN_PROGRESS',
  'PENDING_OTP',
  'PENDING_APPROVAL',
  'COMPLETED',
]);

const RUNG: Record<PrintJobStatus, number> = {
  REQUESTED: 0,
  ACCEPTED: 1,
  PRINTING: 2,
  READY: 3,
  COLLECTED: 4,
  CANCELLED: -1,
};

export const pickupPointOf = (job: JobWithPartner): PickupPoint => ({
  printPartnerId: job.printPartner.id,
  name: job.printPartner.name,
  contactName: job.printPartner.contactName,
  mobile: job.printPartner.mobile,
  address: job.printPartner.address,
  city: job.printPartner.city,
  latitude: job.printPartner.latitude,
  longitude: job.printPartner.longitude,
});

/** The job as `orders` prints it on the order read and the pickup code. */
export const orderPrintJobOf = (job: JobWithPartner): OrderPrintJob => ({
  id: job.id,
  status: job.status,
  quotedCost: job.quotedCost === null ? null : money(job.quotedCost),
  actualCost: job.actualCost === null ? null : money(job.actualCost),
  requestedAt: job.requestedAt,
  readyAt: job.readyAt,
  collectedAt: job.collectedAt,
  pickup: pickupPointOf(job),
});

export async function getJobForOrder(orderId: string): Promise<JobWithPartner> {
  const job = await repository.findJobByOrder(orderId);
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'No print job for this order');
  return job;
}

/** For the port: null rather than 404 when the order has no job. */
export async function printJobFor(orderId: string): Promise<OrderPrintJob | null> {
  const job = await repository.findJobByOrder(orderId);
  return job ? orderPrintJobOf(job) : null;
}

/** E9, for the port: a page of orders' pickup points in one read, keyed by order; absent where nobody is printing. */
export async function pickupsForOrders(orderIds: readonly string[]): Promise<Map<string, PickupPoint>> {
  if (orderIds.length === 0) return new Map();
  const jobs = await repository.findJobsByOrders(orderIds);
  return new Map(jobs.map((job) => [job.orderId, pickupPointOf(job)]));
}

/**
 * A job opened against an order that has reached PENDING_PRINT, at an active
 * partner. One per order (`orderId` is unique): a second open is refused,
 * except over a CANCELLED job, which is reopened in place — at the partner
 * named now, with the clock restarted.
 */
export async function openPrintJob(orderId: string, input: OpenJobInput, now = new Date()): Promise<JobWithPartner> {
  const order = await getOrderSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (!PRINTABLE_ORDER_STATUSES.has(order.status)) {
    throw new ApiError(
      409,
      'CONFLICT',
      `An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} is not ready to print.`
    );
  }
  const partner = await repository.findPartner(input.printPartnerId);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Print partner not found');
  if (!partner.isActive) throw new ApiError(409, 'CONFLICT', 'That print partner is off the roster.');

  const quotedCost = input.quotedCost ? new Decimal(input.quotedCost) : null;
  const specs = input.specs === undefined ? null : (input.specs as never);

  const existing = await repository.findJobByOrder(orderId);
  if (existing) {
    if (existing.status !== 'CANCELLED') {
      throw new ApiError(
        409,
        'CONFLICT',
        `This order already has a print job (${existing.status.toLowerCase()}).`,
        { printJobId: existing.id }
      );
    }
    return repository.updateJob(existing.id, {
      printPartnerId: partner.id,
      status: 'REQUESTED',
      quotedCost,
      actualCost: null,
      specs,
      requestedAt: now,
      readyAt: null,
      collectedAt: null,
      notes: input.notes ?? null,
      // Lot H: a reopened job is a fresh ask of the partner named now.
      awardedQuoteId: input.awardedQuoteId ?? null,
      partnerAcceptedAt: null,
      partnerDeclinedAt: null,
      declineReason: null,
      handoverConfirmedAt: null,
      handoverQrId: null,
    });
  }
  return repository.createJob({
    orderId,
    printPartnerId: partner.id,
    quotedCost,
    specs,
    notes: input.notes ?? null,
    awardedQuoteId: input.awardedQuoteId ?? null,
  });
}

/**
 * Ops moves the job along and records what it cost. Forward only, and the
 * cost is locked once approved — the number that was paid is the number.
 */
export async function updatePrintJob(
  orderId: string,
  input: UpdateJobInput,
  now = new Date()
): Promise<{ before: JobWithPartner; after: JobWithPartner }> {
  const before = await getJobForOrder(orderId);
  const patch: Parameters<typeof repository.updateJob>[1] = {};

  if (input.status !== undefined && input.status !== before.status) {
    if (before.status === 'CANCELLED') {
      throw new ApiError(409, 'CONFLICT', 'This job was cancelled. Open a new one against the order.');
    }
    if (before.status === 'COLLECTED') {
      throw new ApiError(409, 'CONFLICT', 'The material has been collected; the job is finished.');
    }
    if (input.status === 'CANCELLED') {
      if (before.costApprovedAt) {
        throw new ApiError(
          409,
          'CONFLICT',
          'The cost has been approved and paid into the partner wallet; reverse the ledger transaction instead.'
        );
      }
    } else if (RUNG[input.status] < RUNG[before.status]) {
      throw new ApiError(
        409,
        'CONFLICT',
        `A job that is ${before.status.toLowerCase()} cannot go back to ${input.status.toLowerCase()}.`
      );
    }
    patch.status = input.status;
    if (input.status === 'READY' && !before.readyAt) patch.readyAt = now;
    if (input.status === 'COLLECTED') {
      if (!before.readyAt) patch.readyAt = now;
      patch.collectedAt = now;
    }
  }

  if (input.actualCost !== undefined) {
    if (before.costApprovedAt) {
      throw new ApiError(409, 'CONFLICT', 'The cost has been approved; it can no longer change.');
    }
    patch.actualCost = input.actualCost ? new Decimal(input.actualCost) : null;
  }
  if (input.notes !== undefined) patch.notes = input.notes;

  if (Object.keys(patch).length === 0) return { before, after: before };
  const after = await repository.updateJob(before.id, patch);
  return { before, after };
}

/** For the port: the agent (or the publisher) has the material. */
export async function markCollected(orderId: string, at = new Date()): Promise<void> {
  const job = await repository.findJobByOrder(orderId);
  if (!job || job.status === 'COLLECTED' || job.status === 'CANCELLED') return;
  await repository.updateJob(job.id, {
    status: 'COLLECTED',
    collectedAt: at,
    ...(job.readyAt ? {} : { readyAt: at }),
  });
}

export type CostApproval = {
  job: JobWithPartner;
  gross: Money;
  taxWithheld: Money;
  taxRatePct: Money;
  taxSection: string | null;
  net: Money;
  walletId: string;
  ledgerTransactionId: string;
  /** False when a previous approval had already posted the movement. */
  created: boolean;
};

/**
 * The money. READY (or already COLLECTED) with an actual cost, and not yet
 * approved: PRINT_COST into the partner's wallet, TDS withheld under 194C
 * at the rate in force today, keyed `print-cost:<jobId>` so a double tap
 * and a retried request pay once. The tax split rides on the ledger legs
 * and the audit row; the job keeps the transaction id.
 */
export async function approvePrintCost(
  orderId: string,
  input: { byUserId: string },
  now = new Date()
): Promise<CostApproval> {
  const job = await getJobForOrder(orderId);
  if (job.status !== 'READY' && job.status !== 'COLLECTED') {
    throw new ApiError(
      409,
      'CONFLICT',
      `Only a job that is ready can have its cost approved; this one is ${job.status.toLowerCase()}.`
    );
  }
  if (job.actualCost === null || new Decimal(job.actualCost).lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Record the actual cost on the job before approving it.');
  }

  const partner = await repository.findPartner(job.printPartnerId);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Print partner not found');

  const gross = money(job.actualCost);
  const tax = await withholdingFor('PARTNER', gross, now);
  const net = money(new Decimal(gross).minus(new Decimal(tax.taxWithheld)));

  const wallet = await ensureWallet({ kind: 'PRINT_PARTNER', id: partner.id }, walletLabelFor(partner));
  const result = await move({
    walletId: wallet.id,
    walletLabel: walletLabelFor(partner),
    amount: net,
    entryType: 'EARNING',
    ledgerKind: 'PRINT_COST',
    idempotencyKey: `print-cost:${job.id}`,
    counterLegs: [
      { accountCode: 'platform:cost-of-sales', amount: money(new Decimal(gross).negated()), note: 'Print cost' },
      ...(new Decimal(tax.taxWithheld).isZero()
        ? []
        : [
            {
              accountCode: 'platform:tax-withheld',
              amount: tax.taxWithheld,
              note: `TDS ${tax.section ?? ''} @ ${tax.ratePct}% on print cost`.replace(/\s+/g, ' '),
            },
          ]),
    ],
    orderId,
    reference: job.id,
    note: `Print job ${job.id} · order ${orderId}`,
    createdByUserId: input.byUserId,
    occurredAt: now,
  });

  const stamped = job.costApprovedAt
    ? job
    : await repository.updateJob(job.id, {
        costApprovedByUserId: input.byUserId,
        costApprovedAt: now,
        ledgerTransactionId: result.ledgerTransactionId,
      });

  return {
    job: stamped,
    gross,
    taxWithheld: tax.taxWithheld,
    taxRatePct: tax.ratePct,
    taxSection: tax.section,
    net,
    walletId: wallet.id,
    ledgerTransactionId: result.ledgerTransactionId,
    created: result.created,
  };
}
