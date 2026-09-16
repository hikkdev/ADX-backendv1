import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { Decimal, money, type Money } from '../../../shared/money';
import { listArgs, toListPage, type ListPage } from '../../../shared/pagination';
import type { AccountClosureCase, SuspensionScope } from '../../../shared/database';
import { revokeSessions } from '../../auth';
import { assertNotLastSuperAdmin } from '../../access-control';
import { retireListingsForPublisher } from '../../listings';
import { createNotification } from '../../notifications';
import { requestClosingWithdrawal } from '../../payouts';
import { raiseAccountTicket } from '../../support';
import { SCOPES_BY_PARTY, suspendParty, type PartyType } from '../../suspension';
import { prismaAccountLifecycleRepository as repository } from '../prisma-account-lifecycle.repository';
import type { ClosureCaseRow } from '../account-lifecycle.repository';
import type { ClosureCaseQuery } from '../account-lifecycle.schema';
import { blockingOf, closureReview, requireParties, type ClosureReview } from './closure-review';

/**
 * Closing an account -- Lot A (Q21).
 *
 * The decision the owner made, in one sentence: an account with history is
 * closed, never deleted. `users.deleteUserCascade` would take the orders and
 * the listings with it and leave the ledger legs describing a party that no
 * longer exists, so `DELETE /users/:id` refuses with USER_HAS_HISTORY and
 * names this path instead.
 *
 * A closure is a case before it is an act. Somebody asks -- the person from
 * the Privacy screen, or ops from the desk -- and the case records the four
 * numbers that mattered at that moment: the balance, the payouts in flight,
 * the open orders and the open agent work. An admin then decides it, and only
 * the CLOSED decision does anything.
 *
 * What CLOSED does, in order, and why that order:
 *
 *   1. re-runs the review. The case is a week old by now.
 *   2. suspends every profile the person holds on the four closure scopes.
 *      This is where the work actually stops -- the suspension module owns
 *      those consequences and re-implementing them here is how two modules
 *      end up with two ideas of what stopping means.
 *   3. stamps User.closedAt / closeReason / closedById.
 *   4. revokes the sessions. BLOCK_SIGNIN already took the refresh tokens;
 *      this takes the access tokens, which outlive the flag otherwise.
 *   5. retires the listings -- INACTIVE, never deleted.
 *   6. asks for the last payout, if there is money and nobody has written off
 *      a loss.
 *
 * Nothing here moves money by itself. The final withdrawal is a REQUESTED row
 * that a person still vets, exactly like every other one (DR 04: nothing is
 * auto-approved).
 */

/** What a closure suspends, on every profile that admits it. */
const CLOSURE_SCOPES: SuspensionScope[] = [
  'BLOCK_NEW',
  'STOP_OPEN_WORK',
  'FREEZE_WALLET',
  'BLOCK_SIGNIN',
];

export type ClosureCaseView = Omit<AccountClosureCase, 'walletBalance'> & {
  walletBalance: Money | null;
  user: ClosureCaseRow['user'];
};

export type ClosurePayout = {
  walletId: string;
  amount: Money;
  reference: string | null;
  outcome: 'REQUESTED' | 'NO_VERIFIED_METHOD' | 'NOTHING_WITHDRAWABLE';
};

export type ClosureOutcome = {
  userId: string;
  closedAt: Date;
  suspended: { partyType: PartyType; partyId: string; scopes: SuspensionScope[] }[];
  listingsRetired: string[];
  payouts: ClosurePayout[];
  /**
   * What the closure could not finish -- a balance left frozen because no
   * verified payout method exists, say. Written onto the case as well, so the
   * desk sees it on the queue rather than only in one response.
   */
  note: string | null;
};

const view = (row: ClosureCaseRow | (AccountClosureCase & { user?: ClosureCaseRow['user'] })): ClosureCaseView => ({
  ...row,
  walletBalance: row.walletBalance === null ? null : money(row.walletBalance),
  user: 'user' in row ? (row.user ?? null) : null,
});

/* ------------------------------------------------------------------ */
/* Raising a case                                                      */
/* ------------------------------------------------------------------ */

/**
 * Opens a case with the snapshot numbers.
 *
 * One open case per account: a second ask while one is pending returns the
 * pending one rather than stacking two investigations of the same question.
 */
export async function openClosureCase(
  userId: string,
  input: { reason: string; ticketId?: string | undefined; requestedById?: string | null },
): Promise<{ case: ClosureCaseView; review: ClosureReview; created: boolean }> {
  const review = await closureReview(userId);

  const existing = await repository.findPendingCaseForUser(userId);
  if (existing) return { case: view(existing), review, created: false };

  const created = await repository.createCase({
    userId,
    reason: input.reason,
    ticketId: input.ticketId ?? null,
    requestedById: input.requestedById ?? null,
    walletBalance: new Decimal(review.summary.walletBalance),
    withdrawalsInFlight: review.summary.withdrawalsInFlight,
    openOrders: review.summary.openOrders,
    openWork: review.summary.openWork,
  });

  return { case: view(created), review, created: true };
}

/**
 * The Privacy screen's "close my account".
 *
 * The person is the requester, and the ask also raises the ordinary ACCOUNT
 * support ticket so it lands in the queue ops already works rather than in a
 * screen only this feature knows about. The ticket id is linked onto the case,
 * which is what lets the thread and the investigation be read together.
 */
export async function requestOwnClosure(
  userId: string,
  reason: string,
): Promise<{ case: ClosureCaseView; review: ClosureReview; created: boolean }> {
  const result = await openClosureCase(userId, { reason, requestedById: userId });
  if (!result.created || result.case.ticketId) return result;

  try {
    const ticket = await raiseAccountTicket({
      userId,
      title: 'Account closure requested',
      description:
        'The account holder asked for their account to be closed from the Privacy screen.\n\n' +
        'Reason: ' +
        reason,
    });
    const linked = await repository.setCaseTicket(result.case.id, ticket.id);
    return { ...result, case: view(linked) };
  } catch (error) {
    // A ticket that could not be raised is not a reason to lose the request:
    // the case is the record, the ticket is the conversation about it.
    logger.warn('Closure request raised no support ticket', {
      userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

export async function listClosureCases(query: ClosureCaseQuery): Promise<ListPage<ClosureCaseView>> {
  const { items, total, counts } = await repository.listCases(
    { decision: query.decision, q: query.q },
    listArgs(query),
  );
  return toListPage(items.map(view), total, counts, query);
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

export async function decideClosureCase(
  caseId: string,
  input: { decision: 'CLOSED' | 'REFUSED'; lossNote?: string | undefined },
  adminId: string,
): Promise<{ case: ClosureCaseView; outcome: ClosureOutcome | null }> {
  const existing = await repository.findCase(caseId);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Closure case not found');
  if (existing.decision !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', 'This case has already been decided.', {
      decision: existing.decision,
      decidedAt: existing.decidedAt,
    });
  }

  // The close runs BEFORE the case is marked decided: a refusal from the
  // blockers must leave the case open for somebody to work, not leave it
  // recorded as CLOSED over an account that is still running.
  const outcome =
    input.decision === 'CLOSED'
      ? await closeAccount(existing.userId, existing.reason, adminId, input.lossNote)
      : null;

  // The admin's own note and whatever the closure could not finish are two
  // different facts; the column holds both rather than one silently replacing
  // the other.
  const lossNote = [input.lossNote, outcome?.note].filter(Boolean).join(' ') || undefined;
  const decided = await repository.decideCase(caseId, {
    decision: input.decision,
    decidedById: adminId,
    decidedAt: new Date(),
    ...(lossNote === undefined ? {} : { lossNote }),
  });

  return { case: view(decided), outcome };
}

/* ------------------------------------------------------------------ */
/* The act                                                             */
/* ------------------------------------------------------------------ */

export async function closeAccount(
  userId: string,
  reason: string,
  adminId: string,
  lossNote?: string | undefined,
): Promise<ClosureOutcome> {
  const parties = await requireParties(userId);
  if (parties.closedAt) {
    throw new ApiError(409, 'CONFLICT', 'This account is already closed.', {
      closedAt: parties.closedAt,
      closeReason: parties.closeReason,
    });
  }

  // Lot K2: the last active super admin cannot be closed either — the same
  // LAST_SUPER_ADMIN rule the role-config, deactivate and delete doors apply.
  await assertNotLastSuperAdmin(userId, 'CLOSE');

  const review = await closureReview(userId);
  const blocking = blockingOf(review);
  if (blocking.length > 0) {
    throw new ApiError(
      409,
      'CLOSURE_BLOCKED',
      'This account still has ' +
        blocking.map((blocker) => blocker.count + ' ' + blocker.label.toLowerCase()).join(', ') +
        '. Settle those before closing it.',
      { userId, blockers: blocking },
    );
  }

  const at = new Date();
  const suspensionReason = 'Account closed: ' + reason;

  /* 1. Stop the work, through the module that owns stopping it. */
  const suspended: ClosureOutcome['suspended'] = [];
  const targets: { partyType: PartyType; partyId: string }[] = [
    ...(parties.publisherId ? [{ partyType: 'PUBLISHER' as const, partyId: parties.publisherId }] : []),
    ...(parties.advertiserId ? [{ partyType: 'ADVERTISER' as const, partyId: parties.advertiserId }] : []),
    ...(parties.agentProfileId ? [{ partyType: 'AGENT' as const, partyId: parties.agentProfileId }] : []),
  ];
  for (const target of targets) {
    const admitted = CLOSURE_SCOPES.filter((scope) =>
      SCOPES_BY_PARTY[target.partyType].includes(scope),
    );
    await suspendParty(target.partyType, target.partyId, {
      scopes: admitted,
      reason: suspensionReason,
      byUserId: adminId,
    });
    suspended.push({ ...target, scopes: admitted });
  }

  /* 2. Mark the person closed, and 3. end the sessions BLOCK_SIGNIN cannot. */
  await repository.closeUser(userId, { reason, byUserId: adminId, at });
  await revokeSessions(userId, 'ACCOUNT_CLOSED');

  /* 4. Take the spots off the market. Never deleted. */
  const listingsRetired = parties.publisherId
    ? await retireListingsForPublisher(parties.publisherId)
    : [];

  /* 5. The last payout. */
  const payouts: ClosurePayout[] = [];
  const notes: string[] = [];
  if (lossNote) {
    notes.push('No final payout raised: a loss was recorded on the case.');
  } else {
    for (const wallet of review.wallets) {
      if (!new Decimal(wallet.balance).greaterThan(0)) continue;
      const result = await requestClosingWithdrawal(wallet.walletId, { userId });
      payouts.push({
        walletId: wallet.walletId,
        amount: result.amount,
        reference: result.withdrawal?.reference ?? null,
        outcome: result.reason,
      });
      if (result.reason === 'NO_VERIFIED_METHOD') {
        notes.push(
          'The ' +
            wallet.kind.toLowerCase() +
            ' wallet holds ' +
            result.amount +
            ' and has no verified payout method. The balance stays frozen until one is added and a withdrawal is raised by hand.',
        );
      }
      if (result.reason === 'NOTHING_WITHDRAWABLE') {
        notes.push(
          'The ' +
            wallet.kind.toLowerCase() +
            ' wallet balance is held or still inside its clearing window; nothing could be paid out yet.',
        );
      }
    }
  }
  const note = notes.length > 0 ? notes.join(' ') : null;

  const outcome: ClosureOutcome = {
    userId,
    closedAt: at,
    suspended,
    listingsRetired,
    payouts,
    note,
  };

  await logActivity(adminId, 'ACCOUNT_CLOSED', {
    module: 'account-lifecycle',
    targetType: 'User',
    targetId: userId,
    diff: { closedAt: { before: null, after: at.toISOString() } },
    metadata: { reason, ...outcome, closedAt: at.toISOString() },
  });

  await createNotification({
    userId,
    type: 'SYSTEM',
    title: 'Your ADX account has been closed',
    message:
      'Your account is closed and sign-in is disabled. Reason: ' +
      reason +
      '. Your payment records are kept for as long as the law requires; ask support if you need a copy.',
    suggestedAction: 'Contact ADX support',
  }).catch((error: unknown) =>
    logger.warn('Closure notice not delivered', {
      userId,
      cause: error instanceof Error ? error.message : String(error),
    }),
  );

  return outcome;
}
