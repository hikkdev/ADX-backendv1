import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage } from '../../shared/pagination';
import { findOpenFraudCasesForDisputes } from '../fraud';
import { allocateIdentifier } from '../identifiers';
import { createNotification } from '../notifications';
import { findMilestoneStatuses, raiseReinstallMilestone } from '../order-milestones';
import { getUserDisplayName, listAdminUserIds } from '../users';
import { ensureWallet, move } from '../wallets';
import { prismaDisputesRepository as repository } from './prisma-disputes.repository';
import type { DisputeDetail, DisputeRow } from './disputes.repository';
import { assertParty, assertRaiser, isAdmin, mayView } from './disputes.policy';
import { partyRecordsForUsers, pickPartyRecord } from './party-lookup.port';
import {
  agentStateOf,
  isClosed,
  REOPEN_DAYS,
  SLA_HOURS,
  type Actor,
  type DisputeOutcome,
  type DisputePatch,
  type DisputeParty,
  type DisputeReason,
  type DisputeStatus,
  type QueueFilter,
} from './disputes.types';

/** The name every desk message wears on the thread. */
export const OPS_AUTHOR = 'ADX Ops';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const notifyAll = (userIds: (string | null | undefined)[], build: (userId: string) => Parameters<typeof createNotification>[0]) =>
  Promise.all([...new Set(userIds.filter((id): id is string => !!id))].map((userId) => createNotification(build(userId))));

const reasonLabel = (reason: DisputeReason) => reason.toLowerCase().replace(/_/g, ' ');

/**
 * Which hat the raiser wears on the order, and who the case is against.
 *
 * The Raise frame names the order and not a person, so both are derived: the
 * raiser is whichever party of the order they are; a payout complaint is with
 * ADX; otherwise an advertiser's complaint is with the publisher, a
 * publisher's is with the agent who did the work (or the advertiser when
 * nobody did), and an agent's is with the publisher whose site it was.
 */
export function partiesFor(
  actor: Actor,
  order: { advertiserUserId: string; publisherUserId: string | null; agentUserId: string | null },
  reason: DisputeReason,
): { raisedAs: DisputeParty; againstParty: DisputeParty; againstUserId: string | null } {
  const raisedAs: DisputeParty | null =
    order.advertiserUserId === actor.sub
      ? 'ADVERTISER'
      : order.publisherUserId === actor.sub
        ? 'PUBLISHER'
        : order.agentUserId === actor.sub
          ? 'AGENT'
          : null;
  if (!raisedAs) throw new ApiError(403, 'FORBIDDEN', 'You are not a party to this order');

  if (reason === 'PAYOUT_ISSUE') return { raisedAs, againstParty: 'ADX', againstUserId: null };
  if (raisedAs === 'ADVERTISER') return { raisedAs, againstParty: 'PUBLISHER', againstUserId: order.publisherUserId };
  if (raisedAs === 'PUBLISHER') {
    return order.agentUserId
      ? { raisedAs, againstParty: 'AGENT', againstUserId: order.agentUserId }
      : { raisedAs, againstParty: 'ADVERTISER', againstUserId: order.advertiserUserId };
  }
  return { raisedAs, againstParty: 'PUBLISHER', againstUserId: order.publisherUserId };
}

export async function raiseDispute(
  actor: Actor,
  input: {
    orderId: string;
    reason: DisputeReason;
    detail: string;
    expectedResolution?: string;
    amountClaimed?: Money;
    evidence: { url: string; kind: 'IMG' | 'PDF' | 'OTHER'; fileName?: string }[];
  },
  now = new Date(),
) {
  const order = await repository.findOrderParties(input.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  const parties = partiesFor(actor, order, input.reason);

  const displayId = await allocateIdentifier('DISPUTE');
  const dispute = await repository.create({
    displayId,
    raisedByUserId: actor.sub,
    ...parties,
    orderId: order.id,
    listingId: order.listingId,
    reason: input.reason,
    detail: input.detail,
    expectedResolution: input.expectedResolution ?? null,
    amountClaimed: input.amountClaimed ?? null,
    slaDueAt: new Date(now.getTime() + SLA_HOURS * HOUR),
  });
  for (const item of input.evidence) {
    await repository.addEvidence({
      disputeId: dispute.id,
      uploadedByUserId: actor.sub,
      url: item.url,
      kind: item.kind,
      fileName: item.fileName ?? null,
    });
  }

  const admins = await listAdminUserIds();
  await notifyAll([...admins, parties.againstUserId], (userId) => ({
    userId,
    type: 'DISPUTE',
    title: admins.includes(userId) ? 'New dispute' : 'A dispute names your order',
    subtitle: displayId,
    message: `${order.listingTitle} — ${reasonLabel(input.reason)}`,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  }));
  return dispute;
}

/** The person's cases and the counts strip above them. */
export async function listMine(actor: Actor, now = new Date()) {
  const rows = await repository.findManyForUser(actor.sub);
  const counts = { open: 0, underReview: 0, resolved: 0 };
  for (const row of rows) {
    const state = agentStateOf(row.status);
    if (state === 'OPEN') counts.open += 1;
    else if (state === 'UNDER_REVIEW') counts.underReview += 1;
    else counts.resolved += 1;
  }
  return { disputes: await rowViews(rows, now), counts };
}

/** Null for a stranger as for a missing id, so a case's existence leaks nothing. */
export async function getVisibleDispute(disputeId: string, actor: Actor, now = new Date()) {
  const dispute = await repository.findById(disputeId);
  if (!dispute || !mayView(dispute, actor)) return null;
  return detailView(dispute, actor, now);
}

/**
 * T-B: what a desk write answers — the same detail view `GET /disputes/:id`
 * answers (the order card, the raiser, the thread, the clock, the fraud
 * link, the party record), re-read once after the write so the desk
 * updates the case it holds from the answer.
 */
async function writtenView(disputeId: string, actor: Actor, now: Date) {
  const dispute = await repository.findById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  return detailView(dispute, actor, now);
}

/* ── Lot D (Q53/Q91): the clock, paused while AWAITING_RESPONSE ──── */

type ClockFields = { status: DisputeStatus; slaDueAt: Date | null; slaPausedAt: Date | null; slaPausedMs: number };

/**
 * Whether the case is late, at `now`. A running pause is added to the due
 * date before the comparison, so a case waiting on a party never breaches
 * while it waits; a closed case is never late.
 */
export function slaOf(dispute: ClockFields, now = new Date()) {
  const paused = dispute.status === 'AWAITING_RESPONSE' && dispute.slaPausedAt instanceof Date;
  const running = paused ? Math.max(0, now.getTime() - (dispute.slaPausedAt as Date).getTime()) : 0;
  const dueAt = dispute.slaDueAt ? new Date(dispute.slaDueAt.getTime() + running) : null;
  const breached = !isClosed(dispute.status) && !paused && dueAt !== null && dueAt.getTime() < now.getTime();
  return { breached, paused, dueAt, dueIn: dueAt && !isClosed(dispute.status) ? dueAt.getTime() - now.getTime() : null };
}

/** The patch that ends a pause: the wait is banked and the due date moves by it. */
function resumeClock(dispute: ClockFields, now: Date): Pick<DisputePatch, 'slaPausedAt' | 'slaPausedMs' | 'slaDueAt'> {
  const waited = dispute.slaPausedAt ? Math.max(0, now.getTime() - dispute.slaPausedAt.getTime()) : 0;
  return {
    slaPausedAt: null,
    slaPausedMs: (dispute.slaPausedMs ?? 0) + waited,
    slaDueAt: dispute.slaDueAt ? new Date(dispute.slaDueAt.getTime() + waited) : null,
  };
}

async function loadForWrite(disputeId: string, actor: Actor) {
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  const standing = assertParty(dispute, actor);
  return { dispute, standing };
}

/**
 * A reply on the thread. The desk writes as "ADX Ops"; a party under their
 * own name. Whoever did not write hears about it.
 */
export async function addMessage(disputeId: string, actor: Actor, body: string, now = new Date()) {
  const { dispute, standing } = await loadForWrite(disputeId, actor);
  const fromOps = standing === 'ADMIN';
  const authorName = fromOps ? OPS_AUTHOR : (await getUserDisplayName(actor.sub)) ?? 'You';
  const message = await repository.addMessage({ disputeId, authorUserId: actor.sub, authorName, isFromOps: fromOps, body });

  // Lot D (Q91): a party answering an AWAITING_RESPONSE case is what ADX was
  // waiting for — the case goes back under review and the clock restarts
  // with the wait banked. ADX's own messages do not lift the pause.
  if (!fromOps && dispute.status === 'AWAITING_RESPONSE') {
    await repository.update(disputeId, { status: 'UNDER_REVIEW', ...resumeClock(dispute, now) });
  }

  const others = fromOps
    ? [dispute.raisedByUserId, dispute.againstUserId]
    : [...(await listAdminUserIds()), dispute.raisedByUserId, dispute.againstUserId].filter((id) => id !== actor.sub);
  await notifyAll(others, (userId) => ({
    userId,
    type: 'DISPUTE',
    title: fromOps ? 'ADX Ops replied on your case' : `${authorName} replied on a case`,
    subtitle: dispute.displayId,
    message: body.length > 140 ? `${body.slice(0, 139)}…` : body,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  }));
  return message;
}

export async function addEvidence(
  disputeId: string,
  actor: Actor,
  item: { url: string; kind: 'IMG' | 'PDF' | 'OTHER'; fileName?: string },
) {
  const { dispute, standing } = await loadForWrite(disputeId, actor);
  const evidence = await repository.addEvidence({
    disputeId,
    uploadedByUserId: actor.sub,
    url: item.url,
    kind: item.kind,
    fileName: item.fileName ?? null,
  });
  if (standing !== 'ADMIN') {
    await notifyAll(await listAdminUserIds(), (userId) => ({
      userId,
      type: 'DISPUTE',
      title: 'Evidence added to a case',
      subtitle: dispute.displayId,
      message: item.fileName ?? 'A file was attached.',
      relatedId: dispute.id,
      relatedType: 'DISPUTE',
    }));
  }
  return evidence;
}

/**
 * Lot F: the people who may open a DISPUTE_EVIDENCE file — the raiser and
 * the party the case is against, for every case the file is attached to.
 * `uploads` asks this through its `FileAccessPort` (filled in bootstrap):
 * a file is stored by the hand that uploaded it, and the counter-party
 * needs to see what was said against them. Never ADX's own staff: the desk
 * is ADMIN and opens anything.
 *
 * `holders` are the file's own people — its owner and the hand that uploaded
 * it. An evidence URL is text the raiser typed, so only a case one of the
 * holders is themselves a party to counts: a stranger who attaches somebody
 * else's `/files/:id` to a case of their own does not become its reader.
 */
/** The id a `/files/:id` evidence URL names — exactly: `f1` is not `f12`, whatever path, query or fragment follows. */
export function evidenceFileIdOf(url: string): string | null {
  const match = /\/files\/([A-Za-z0-9_-]+)(?=[/?#]|$)/.exec(url);
  return match ? match[1]! : null;
}

export async function disputePartiesForEvidenceFile(fileId: string, holders: readonly string[]): Promise<string[]> {
  // E9 (the E7 verifier): the rows are matched on the exact file id and each
  // resolves to its own case by `disputeId`; the URL text never picks a case.
  const rows = await repository.findEvidenceByFileId(fileId);
  const disputeIds = [...new Set(rows.filter((row) => evidenceFileIdOf(row.url) === fileId).map((row) => row.disputeId))];
  const parties = disputeIds.length ? await repository.findPartiesByDisputeIds(disputeIds) : [];
  const people = new Set<string>();
  for (const party of parties) {
    if (!holders.includes(party.raisedByUserId) && !(party.againstUserId && holders.includes(party.againstUserId))) continue;
    people.add(party.raisedByUserId);
    if (party.againstUserId) people.add(party.againstUserId);
  }
  return [...people];
}

/**
 * Ops moving a case by hand: under review, awaiting a response, escalated,
 * or back to open. The note is required and goes on the thread as ADX Ops,
 * which is what the detail frame's "Evidence requested" line reads.
 */
export async function setStatus(
  disputeId: string,
  admin: Actor,
  status: Exclude<DisputeStatus, 'RESOLVED' | 'REJECTED'>,
  note: string,
  now = new Date(),
) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX moves a case');
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  if (isClosed(dispute.status)) {
    throw new ApiError(409, 'CONFLICT', 'This case is closed. Reopen it first, or leave it be.');
  }
  // Lot D (Q91): into AWAITING_RESPONSE stamps the pause; out of it banks the wait.
  const clock =
    status === 'AWAITING_RESPONSE'
      ? dispute.status === 'AWAITING_RESPONSE'
        ? {}
        : { slaPausedAt: now }
      : dispute.status === 'AWAITING_RESPONSE'
        ? resumeClock(dispute, now)
        : {};
  const updated = await repository.update(disputeId, {
    status,
    statusNote: note,
    reviewStartedAt: dispute.reviewStartedAt ?? (status === 'OPEN' ? null : now),
    ...(status === 'ESCALATED' ? { escalatedAt: now } : {}),
    ...clock,
  });
  await repository.addMessage({ disputeId, authorUserId: admin.sub, authorName: OPS_AUTHOR, isFromOps: true, body: note });
  await notifyAll([dispute.raisedByUserId, dispute.againstUserId], (userId) => ({
    userId,
    type: 'DISPUTE',
    title: status === 'AWAITING_RESPONSE' ? 'ADX Ops needs something from you' : `Your case is ${status.toLowerCase().replace(/_/g, ' ')}`,
    subtitle: dispute.displayId,
    message: note,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  }));
  return writtenView(updated.id, admin, now);
}

/**
 * The decision. A credit is recorded, never moved: DR 04 says nothing that
 * moves money is automatic, so the case says "credit approved, finance
 * releases it" and `releaseCredit` is the second, human step (decision 2).
 * NO_FAULT closes the case as rejected; the other outcomes resolve it.
 */
export async function resolve(
  disputeId: string,
  admin: Actor,
  input: { outcome: DisputeOutcome; note: string; creditAmount?: Money; agentId?: string },
  now = new Date(),
) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX decides a case');
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  if (isClosed(dispute.status)) throw new ApiError(409, 'CONFLICT', 'This case has already been decided');

  let credit: Money | null = null;
  if (input.outcome === 'PARTIAL_CREDIT') credit = input.creditAmount ?? null;
  if (input.outcome === 'FULL_CREDIT') {
    credit = input.creditAmount ?? (dispute.amountClaimed ? money(dispute.amountClaimed) : null);
    if (!credit) throw new ApiError(400, 'VALIDATION_ERROR', 'A full credit needs an amount when none was claimed');
  }
  if (credit && dispute.amountClaimed && new Decimal(credit).greaterThan(new Decimal(money(dispute.amountClaimed)))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The credit cannot exceed the amount claimed');
  }

  // Lot D (Q54/Q92): REINSTALL raises an INSTALLATION visit on the order,
  // offered to the agent who did the work by default. Raised before the case
  // is written so a visit that cannot be raised (no template, an agent who
  // is suspended) leaves the case open rather than resolved with nothing
  // behind it.
  let reinstallMilestoneId: string | null = null;
  if (input.outcome === 'REINSTALL') {
    if (!dispute.orderId) throw new ApiError(409, 'CONFLICT', 'A re-install needs an order to re-install on');
    const milestone = await raiseReinstallMilestone({ orderId: dispute.orderId, disputeId: dispute.id, agentId: input.agentId });
    reinstallMilestoneId = milestone.id;
  }

  const status: DisputeStatus = input.outcome === 'NO_FAULT' ? 'REJECTED' : 'RESOLVED';
  const updated = await repository.update(disputeId, {
    status,
    outcome: input.outcome,
    resolutionNote: input.note,
    resolvedAt: now,
    resolvedByUserId: admin.sub,
    reviewStartedAt: dispute.reviewStartedAt ?? now,
    creditedAmount: credit,
    creditStatus: credit ? 'PENDING' : 'NONE',
    reopenUntil: new Date(now.getTime() + REOPEN_DAYS * DAY),
    ...(reinstallMilestoneId ? { reinstallMilestoneId } : {}),
    ...(dispute.status === 'AWAITING_RESPONSE' ? resumeClock(dispute, now) : {}),
  });
  await repository.addMessage({ disputeId, authorUserId: admin.sub, authorName: OPS_AUTHOR, isFromOps: true, body: input.note });
  await notifyAll([dispute.raisedByUserId, dispute.againstUserId], (userId) => ({
    userId,
    type: 'DISPUTE',
    title: status === 'REJECTED' ? 'Dispute closed' : 'Dispute resolved',
    subtitle: dispute.displayId,
    message: credit && userId === dispute.raisedByUserId
      ? `${input.note} ₹${credit} credit approved — ADX finance releases it to your wallet.`
      : input.note,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  }));
  return writtenView(updated.id, admin, now);
}

/**
 * Finance releases the approved credit and the wallet moves — the one place
 * in this module money changes hands, idempotent on the case id. An advertiser
 * is refunded (ADX foregoes revenue); a publisher or agent is adjusted (ADX
 * owes them more).
 */
export async function releaseCredit(disputeId: string, admin: Actor, now = new Date()) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX finance releases a credit');
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  if (dispute.creditStatus === 'RELEASED') return writtenView(dispute.id, admin, now);
  if (dispute.creditStatus !== 'PENDING' || !dispute.creditedAmount) {
    throw new ApiError(409, 'CONFLICT', 'There is no approved credit on this case');
  }

  const ids = await repository.partyIdsForUser(dispute.raisedByUserId);
  const owner =
    dispute.raisedAs === 'ADVERTISER' && ids.advertiserId
      ? { kind: 'ADVERTISER' as const, id: ids.advertiserId }
      : dispute.raisedAs === 'PUBLISHER' && ids.publisherId
        ? { kind: 'PUBLISHER' as const, id: ids.publisherId }
        : dispute.raisedAs === 'AGENT' && ids.agentId
          ? { kind: 'AGENT' as const, id: ids.agentId }
          : null;
  if (!owner) throw new ApiError(409, 'CONFLICT', 'The raiser has no wallet to credit');

  const label = `${owner.kind.charAt(0)}${owner.kind.slice(1).toLowerCase()} wallet`;
  const wallet = await ensureWallet(owner, label);
  const amount = money(dispute.creditedAmount);
  const refund = owner.kind === 'ADVERTISER';
  const result = await move({
    walletId: wallet.id,
    walletLabel: label,
    amount,
    entryType: refund ? 'REFUND' : 'ADJUSTMENT',
    ledgerKind: refund ? 'REFUND' : 'ADJUSTMENT',
    idempotencyKey: `dispute-credit:${dispute.id}`,
    counterLegs: [
      {
        accountCode: refund ? 'platform:revenue' : 'platform:payables',
        amount: money(new Decimal(amount).negated()),
        note: `Dispute ${dispute.displayId}`,
      },
    ],
    reference: dispute.id,
    orderId: dispute.orderId,
    note: `Dispute ${dispute.displayId} credit`,
    createdByUserId: admin.sub,
    occurredAt: now,
  });

  const updated = await repository.update(disputeId, {
    creditStatus: 'RELEASED',
    creditReleasedAt: now,
    creditReleasedById: admin.sub,
    creditWalletEntryId: result.entry?.id ?? null,
  });
  await createNotification({
    userId: dispute.raisedByUserId,
    type: 'DISPUTE',
    title: 'Credit released',
    subtitle: dispute.displayId,
    message: `₹${amount} has been credited to your wallet.`,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  });
  return writtenView(updated.id, admin, now);
}

/** The raiser's second look, within the window the decision opened. */
export async function reopen(disputeId: string, actor: Actor, now = new Date()) {
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  assertRaiser(dispute, actor);
  if (!isClosed(dispute.status)) throw new ApiError(409, 'CONFLICT', 'This case is still open');
  if (!dispute.reopenUntil || dispute.reopenUntil.getTime() < now.getTime()) {
    throw new ApiError(409, 'CONFLICT', 'The window to reopen this case has passed');
  }
  const updated = await repository.update(disputeId, { status: 'UNDER_REVIEW', reopenUntil: null });
  await notifyAll(await listAdminUserIds(), (userId) => ({
    userId,
    type: 'DISPUTE',
    title: 'A case was reopened',
    subtitle: dispute.displayId,
    message: dispute.detail.length > 140 ? `${dispute.detail.slice(0, 139)}…` : dispute.detail,
    relatedId: dispute.id,
    relatedType: 'DISPUTE',
  }));
  return updated;
}

/**
 * RATE RESOLUTION (DR 07 4417:8289). The raiser scores a CLOSED case, once —
 * a rating of ADX's handling, not of the other party. A second rating is a
 * 409, and the table's `Dispute_rating_is_dated` check keeps the score and
 * its date together.
 */
export async function rateResolution(
  disputeId: string,
  actor: Actor,
  input: { rating: number; note?: string },
  now = new Date(),
) {
  const dispute = await repository.findSummaryById(disputeId);
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  assertRaiser(dispute, actor);
  if (!isClosed(dispute.status)) throw new ApiError(409, 'CONFLICT', 'Rate the resolution once the case is decided');
  if (dispute.resolutionRating !== null) throw new ApiError(409, 'CONFLICT', 'This resolution has already been rated');
  return repository.update(disputeId, {
    resolutionRating: input.rating,
    resolutionRatingNote: input.note ?? null,
    resolutionRatedAt: now,
  });
}

/* ── The desk ────────────────────────────────────────────────────── */

export async function listQueue(filter: QueueFilter, now = new Date()) {
  return rowViews(await repository.findQueue(filter), now);
}

/**
 * E6: the same queue on the list contract — `{ items, total, page, pageSize,
 * counts }`, the chips counted with the status facet removed.
 */
export async function listQueuePage(
  filter: Pick<QueueFilter, 'status' | 'q'> & { page: number; pageSize: number },
  now = new Date(),
) {
  const facets = { ...(filter.q ? { q: filter.q } : {}), ...(filter.status ? { status: filter.status } : {}) };
  const [items, { total, counts }] = await Promise.all([
    listQueue({ ...facets, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }, now),
    repository.countQueue(facets),
  ]);
  return toListPage(items, total, counts, filter);
}

export const summary = (now = new Date()) => repository.summary(now);

/* ── Views: money as strings, always ─────────────────────────────── */

type MoneyFields = { amountClaimed: unknown; creditedAmount: unknown };

function moneyView<T extends MoneyFields>(row: T) {
  return {
    ...row,
    amountClaimed: row.amountClaimed === null || row.amountClaimed === undefined ? null : money(row.amountClaimed as never),
    creditedAmount: row.creditedAmount === null || row.creditedAmount === undefined ? null : money(row.creditedAmount as never),
  };
}

/** Lot D (Q92): "resolved — re-install pending" until the visit completes. */
const REINSTALL_DONE = ['COMPLETED', 'SKIPPED'];

async function reinstallStatuses(rows: { reinstallMilestoneId: string | null }[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => (row.reinstallMilestoneId ? [row.reinstallMilestoneId] : []));
  if (ids.length === 0) return new Map();
  return new Map((await findMilestoneStatuses(ids)).map((row) => [row.id, row.status]));
}

function reinstallView(row: { reinstallMilestoneId: string | null }, statuses: Map<string, string>) {
  const status = row.reinstallMilestoneId ? statuses.get(row.reinstallMilestoneId) ?? null : null;
  return {
    reinstallStatus: status,
    reinstallPending: row.reinstallMilestoneId !== null && (status === null || !REINSTALL_DONE.includes(status)),
  };
}

async function rowViews(rows: DisputeRow[], now: Date) {
  const statuses = await reinstallStatuses(rows);
  return rows.map((row) => {
    const { _count, ...rest } = row;
    return {
      ...moneyView(rest),
      agentState: agentStateOf(row.status),
      sla: slaOf(row, now),
      ...reinstallView(row, statuses),
      messageCount: _count.messages,
      evidenceCount: _count.evidence,
    };
  });
}

async function detailView(dispute: DisputeDetail, actor: Actor, now: Date) {
  const admin = isAdmin(actor);
  const [statuses, fraudCases, parties] = await Promise.all([
    reinstallStatuses([dispute]),
    // Lot D (Q92): an open fraud case citing this dispute — ADX's to see, never a party's.
    admin ? findOpenFraudCasesForDisputes([dispute.id]) : Promise.resolve([]),
    // E7-3: the record the case is against — the desk's rail; a party's read says nothing.
    admin && dispute.againstUserId ? partyRecordsForUsers([dispute.againstUserId]) : Promise.resolve(new Map()),
  ]);
  const fraudCase = fraudCases.find((row) => row.disputeId === dispute.id) ?? null;
  return {
    ...moneyView(dispute),
    agentState: agentStateOf(dispute.status),
    sla: slaOf(dispute, now),
    ...reinstallView(dispute, statuses),
    openFraudCase: fraudCase ? { id: fraudCase.id, displayId: fraudCase.displayId, status: fraudCase.status } : null,
    against: dispute.againstUserId ? pickPartyRecord(parties.get(dispute.againstUserId), dispute.againstParty) : null,
  };
}
