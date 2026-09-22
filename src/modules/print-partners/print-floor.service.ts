import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { confirmPickupHandover } from '../qr';
import { prismaPrintPartnersRepository as repository } from './prisma-print-partners.repository';
import { reopenRequestAfterDecline } from './print-quotes.service';
import { tellJobReady, tellOps } from './print-partners.notify';
import { assertServiceAgreementSigned } from './service-agreement';
import type { JobRow, JobWithPartner, OrderForPrint, PartnerJobsFilter, PartnerRow } from './print-partners.repository';

/**
 * The partner's own jobs — Lot H (Q147).
 *
 * Lot B's ladder, walked from the shop floor instead of the desk:
 *
 *   REQUESTED ─accept─▶ ACCEPTED ─printing─▶ PRINTING ─ready─▶ READY ─handover─▶ COLLECTED
 *       └──────decline (with a reason)──────▶ CANCELLED
 *
 * Forward only, one rung at a time — the partner reports what happened,
 * not what they know. A decline cancels the job and, when the job came
 * from a quote request, reopens the request for the other partners; ops
 * are told the reason either way. READY tells the agent who collects;
 * the handover is the partner scanning the agent's pickup code — the same
 * PICKUP_MATERIAL code the agent scans off the package — and lands the job
 * at COLLECTED with the scan on it, idempotent with the agent's own
 * collect-prints (whichever side records it first, the other is a no-op).
 * The order itself moves on the agent's step, as before.
 *
 * Every move is audited by the controller under the partner's user.
 */

export const orderRefOf = (orderId: string) => orderId.slice(-6).toUpperCase();

/** A job that is not this partner's reads as missing, never as forbidden. */
export async function getPartnerJob(partner: PartnerRow, jobId: string): Promise<JobWithPartner> {
  const job = await repository.findJob(jobId);
  if (!job || job.printPartnerId !== partner.id) throw new ApiError(404, 'NOT_FOUND', 'Print job not found');
  return job;
}

export async function listPartnerJobs(partner: PartnerRow, query: PartnerJobsFilter) {
  const { items, total, counts } = await repository.listPartnerJobs(partner.id, query);
  const orders = await repository.findOrdersForPrint(items.map((job) => job.orderId));
  const byOrder = new Map(orders.map((order) => [order.id, order]));
  return toListPage(
    items.map((job) => ({ job, order: byOrder.get(job.orderId) ?? null })),
    total,
    counts,
    query,
  );
}

/** The job page: the job, and the order as the partner sees it — artwork, specs, size, site, the agent who collects. */
export async function partnerJobDetail(partner: PartnerRow, jobId: string): Promise<{ job: JobWithPartner; order: OrderForPrint | null }> {
  const job = await getPartnerJob(partner, jobId);
  const order = await repository.findOrderForPrint(job.orderId);
  return { job, order };
}

/* ── The moves ──────────────────────────────────────────────────── */

type Move = { before: JobWithPartner; after: JobWithPartner };

const refuseFinished = (job: JobRow): void => {
  if (job.status === 'CANCELLED') throw new ApiError(409, 'CONFLICT', 'This job was cancelled.');
  if (job.status === 'COLLECTED') throw new ApiError(409, 'CONFLICT', 'The material has been collected; the job is finished.');
};

export async function acceptJob(partner: PartnerRow, jobId: string, now = new Date()): Promise<Move> {
  const before = await getPartnerJob(partner, jobId);
  if (before.status === 'ACCEPTED') return { before, after: before };
  refuseFinished(before);
  // DS-2: a job is accepted under a signed service agreement, when the policy asks for one.
  await assertServiceAgreementSigned(partner.id, 'Accepting a job');
  if (before.status !== 'REQUESTED') {
    throw new ApiError(409, 'CONFLICT', `This job is already ${before.status.toLowerCase()}.`);
  }
  const after = await repository.updateJob(before.id, { status: 'ACCEPTED', partnerAcceptedAt: now });
  return { before, after };
}

/**
 * Declining is allowed until the shop has started printing: a job that is
 * PRINTING or READY is work done, and backing out of it is a call for ops,
 * not a button. The reason is kept on the job and told to ops; a job that
 * came from a quote request reopens it for the other partners.
 */
export async function declineJob(partner: PartnerRow, jobId: string, reason: string, now = new Date()): Promise<Move & { reopenedRequestId: string | null }> {
  const before = await getPartnerJob(partner, jobId);
  refuseFinished(before);
  if (before.status !== 'REQUESTED' && before.status !== 'ACCEPTED') {
    throw new ApiError(409, 'CONFLICT', `A job that is ${before.status.toLowerCase()} cannot be declined; call ADX.`);
  }
  const after = await repository.updateJob(before.id, { status: 'CANCELLED', partnerDeclinedAt: now, declineReason: reason });
  const reopened = await reopenRequestAfterDecline(after, now);
  await tellOps(
    'Print job declined',
    `${partner.name} declined the print for order ${orderRefOf(after.orderId)}: ${reason}${reopened ? ' The quote request is open again.' : ''}`,
    after.orderId,
  );
  return { before, after, reopenedRequestId: reopened?.id ?? null };
}

export async function markPrinting(partner: PartnerRow, jobId: string): Promise<Move> {
  const before = await getPartnerJob(partner, jobId);
  if (before.status === 'PRINTING') return { before, after: before };
  refuseFinished(before);
  if (before.status === 'REQUESTED') throw new ApiError(409, 'CONFLICT', 'Accept the job before starting to print.');
  if (before.status !== 'ACCEPTED') throw new ApiError(409, 'CONFLICT', `This job is already ${before.status.toLowerCase()}.`);
  const after = await repository.updateJob(before.id, { status: 'PRINTING' });
  return { before, after };
}

/** READY: `readyAt` stamped, the agent who collects and ops told. */
export async function markReady(partner: PartnerRow, jobId: string, now = new Date()): Promise<Move> {
  const before = await getPartnerJob(partner, jobId);
  if (before.status === 'READY') return { before, after: before };
  refuseFinished(before);
  if (before.status === 'REQUESTED') throw new ApiError(409, 'CONFLICT', 'Accept the job before marking it ready.');
  const after = await repository.updateJob(before.id, { status: 'READY', readyAt: now });
  const order = await repository.findOrderForPrint(after.orderId);
  const agentUserId = order?.agent?.userId ?? null;
  await Promise.all([
    agentUserId ? tellJobReady(agentUserId, { orderId: after.orderId, partnerName: partner.name, address: partner.address }) : Promise.resolve(),
    tellOps('Prints ready for pickup', `${partner.name} has the material for order ${orderRefOf(after.orderId)} ready.`, after.orderId),
  ]);
  return { before, after };
}

/**
 * The handover: the partner scans the pickup code the agent holds. The
 * code has to be this order's live PICKUP code (`qr.confirmPickupHandover`
 * writes the scan down); the job goes COLLECTED with the scan on it. A job
 * the agent already collected takes the scan and moves nothing — the two
 * sides are idempotent with each other. A job not yet READY is refused:
 * nothing is handed over that was not ready. G13-B: a job whose handover
 * is already on record answers before the code is scanned again — the
 * first scan is the record, and a second would only log a second scan.
 */
export async function handoverJob(partner: PartnerRow, jobId: string, qrToken: string, now = new Date()): Promise<Move> {
  const before = await getPartnerJob(partner, jobId);
  if (before.status === 'CANCELLED') throw new ApiError(409, 'CONFLICT', 'This job was cancelled.');
  if (before.status !== 'READY' && before.status !== 'COLLECTED') {
    throw new ApiError(409, 'CONFLICT', 'Mark the job ready before handing the material over.');
  }
  if (before.status === 'COLLECTED' && before.handoverConfirmedAt) return { before, after: before };
  let scan: { qrId: string };
  try {
    scan = await confirmPickupHandover(qrToken, before.orderId, partner.userId);
  } catch (err) {
    const sentinel = err instanceof Error ? err.message : '';
    if (sentinel === 'QR_INVALID') throw new ApiError(400, 'INVALID_QR', 'That is not an ADX pickup code.');
    if (sentinel === 'QR_MISMATCH') throw new ApiError(409, 'PICKUP_CODE_MISMATCH', 'That pickup code is not for this order.');
    throw err;
  }
  const after = await repository.updateJob(before.id, {
    ...(before.status === 'COLLECTED' ? {} : { status: 'COLLECTED', collectedAt: now, ...(before.readyAt ? {} : { readyAt: now }) }),
    handoverConfirmedAt: now,
    handoverQrId: scan.qrId,
  });
  await tellOps('Material handed over', `${partner.name} handed the material for order ${orderRefOf(after.orderId)} to the agent.`, after.orderId);
  return { before, after };
}
