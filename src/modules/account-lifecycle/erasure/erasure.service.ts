import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { listArgs, toListPage, type ListPage } from '../../../shared/pagination';
import type { ErasureRequest, ErasureVia } from '../../../shared/database';
import { getPlatformSettings } from '../../app-config';
import { prismaAccountLifecycleRepository as repository } from '../prisma-account-lifecycle.repository';
import type { ErasureFootprint, ErasureRow } from '../account-lifecycle.repository';
import type { ErasureQuery } from '../account-lifecycle.schema';
import { requireParties } from '../closure/closure-review';
import {
  DEFAULT_RETENTION_YEARS,
  dueAtFor,
  erasedMobile,
  hashMobile,
  retainUntilFor,
} from './retention';

/**
 * Erasing a person -- Lot A (Q60).
 *
 * The right to erasure is not a right to delete ADX's books. The decision the
 * owner took splits the person from the record: everything that identifies
 * somebody goes, and everything that balances stays.
 *
 *   erased      name, email, mobile, avatar, password; the party profiles'
 *               names, contact fields, addresses and GSTINs; every KYC
 *               document and the uploaded files behind them.
 *   kept        Wallet, Ledger, WithdrawalRequest, AgreementAcceptance and
 *               ActivityLog rows, plus each KYC record's Digio identifiers and
 *               the last four of its PAN -- the minimum that lets a payout or
 *               a signed agreement be traced to a row that no longer names a
 *               person. Held until `retainUntil`.
 *
 * Four gates, in this order, and none of them is skippable:
 *
 *   1. somebody asks (the person, from the app; or ops, on their behalf).
 *   2. the account is CLOSED. Erasing a running account would blank the name
 *      on live orders and leave publishers dealing with a ghost.
 *   3. a DPO approves, holding `dpo.erasure` -- its own permission group so
 *      "give them everything in settings" never quietly includes this.
 *   4. an admin executes it. Approval and execution are separate because the
 *      execution is irreversible and should not be a side effect of a signature.
 */

export type ErasureView = ErasureRequest & {
  user: ErasureRow['user'];
  footprint?: ErasureFootprint;
};

const view = (row: ErasureRequest & { user?: ErasureRow['user'] }): ErasureView => ({
  ...row,
  user: row.user ?? null,
});

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

/**
 * Opens a request, PENDING, due in thirty days.
 *
 * One open request per person: asking twice is the same ask, and two clocks on
 * one obligation is how a deadline gets missed.
 */
export async function requestErasure(
  userId: string,
  input: { reason?: string | undefined; requestedVia: ErasureVia },
): Promise<{ request: ErasureView; created: boolean }> {
  await requireParties(userId);

  const open = await repository.findOpenErasureForUser(userId);
  if (open) return { request: view(open), created: false };

  const request = await repository.createErasure({
    userId,
    requestedVia: input.requestedVia,
    dueAt: dueAtFor(new Date()),
    reason: input.reason ?? null,
  });
  return { request: view(request), created: true };
}

/**
 * E6: `GET /users/:id/erasure` — the request standing against an account
 * (PENDING or APPROVED), or null. The console's account page reads it before
 * it offers the button, so ops see the open clock rather than starting one.
 */
export async function openErasureFor(userId: string): Promise<ErasureView | null> {
  const open = await repository.findOpenErasureForUser(userId);
  return open ? view(open) : null;
}

export async function listErasureRequests(query: ErasureQuery): Promise<ListPage<ErasureView>> {
  const { items, total, counts } = await repository.listErasures(
    { status: query.status, q: query.q },
    listArgs(query),
  );
  return toListPage(items.map(view), total, counts, query);
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

async function requireRequest(id: string): Promise<ErasureRequest> {
  const request = await repository.findErasure(id);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Erasure request not found');
  return request;
}

export async function approveErasure(
  id: string,
  input: { dpoName: string },
  adminId: string,
): Promise<ErasureView> {
  const request = await requireRequest(id);
  if (request.status !== 'PENDING') {
    throw new ApiError(409, 'ERASURE_NOT_ALLOWED', 'Only a pending request can be approved.', {
      status: request.status,
    });
  }

  // The account has to be closed first. Blanking the name on a running account
  // would leave live orders, open offers and a publisher dealing with a party
  // nobody can identify -- and closure is the step that stops all of that.
  const parties = await requireParties(request.userId);
  if (!parties.closedAt) {
    throw new ApiError(
      409,
      'ERASURE_NOT_ALLOWED',
      'Close the account before erasing the person behind it.',
      { userId: request.userId, closeWith: 'account closure' },
    );
  }

  const approved = await repository.updateErasure(id, {
    status: 'APPROVED',
    approvedById: adminId,
    approvedAt: new Date(),
    dpoName: input.dpoName,
  });

  await logActivity(adminId, 'ERASURE_APPROVED', {
    module: 'account-lifecycle',
    targetType: 'ErasureRequest',
    targetId: id,
    metadata: { userId: request.userId, dpoName: input.dpoName, dueAt: request.dueAt },
  });

  return view(approved);
}

export async function refuseErasure(
  id: string,
  input: { reason: string },
  adminId: string,
): Promise<ErasureView> {
  const request = await requireRequest(id);
  if (request.status === 'DONE') {
    throw new ApiError(409, 'ERASURE_NOT_ALLOWED', 'This request has already been carried out.');
  }
  if (request.status === 'REFUSED') {
    throw new ApiError(409, 'ERASURE_NOT_ALLOWED', 'This request has already been refused.');
  }

  const refused = await repository.updateErasure(id, {
    status: 'REFUSED',
    refusedReason: input.reason,
  });

  await logActivity(adminId, 'ERASURE_REFUSED', {
    module: 'account-lifecycle',
    targetType: 'ErasureRequest',
    targetId: id,
    metadata: { userId: request.userId, reason: input.reason },
  });

  return view(refused);
}

/* ------------------------------------------------------------------ */
/* Carrying it out                                                     */
/* ------------------------------------------------------------------ */

/**
 * How many financial years the record is kept for.
 *
 * Read from the platform settings so the number is a policy somebody can
 * change rather than a constant in a file. A settings row that cannot be read
 * falls back to eight years, which is the longer of the two windows and the
 * only safe direction to be wrong in.
 */
async function retentionYears(): Promise<number> {
  try {
    const settings = await getPlatformSettings();
    return settings.retention?.financialYears ?? DEFAULT_RETENTION_YEARS;
  } catch (error) {
    logger.warn('Erasure could not read the retention setting; using the default', {
      years: DEFAULT_RETENTION_YEARS,
      cause: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_RETENTION_YEARS;
  }
}

export async function executeErasure(id: string, adminId: string): Promise<ErasureView> {
  const request = await requireRequest(id);
  if (request.status !== 'APPROVED') {
    throw new ApiError(
      409,
      'ERASURE_NOT_ALLOWED',
      'Only an approved request can be carried out. A DPO signs it off first.',
      { status: request.status },
    );
  }

  const parties = await requireParties(request.userId);
  if (!parties.closedAt) {
    throw new ApiError(
      409,
      'ERASURE_NOT_ALLOWED',
      'Close the account before erasing the person behind it.',
      { userId: request.userId },
    );
  }

  const footprint = await repository.erase({
    userId: parties.userId,
    userMobile: erasedMobile(parties.mobile),
    mobileHash: hashMobile(parties.mobile),
    publisher: parties.publisherId
      ? { id: parties.publisherId, mobile: erasedMobile(parties.mobile) }
      : null,
    advertiser: parties.advertiserId
      ? { id: parties.advertiserId, mobile: erasedMobile(parties.mobile) }
      : null,
    agentProfileId: parties.agentProfileId,
    advertiserKycUserId: parties.userId,
  });

  const completedAt = new Date();
  const years = await retentionYears();
  const retainUntil = retainUntilFor(completedAt, years);

  const done = await repository.updateErasure(id, {
    status: 'DONE',
    completedAt,
    retainUntil,
  });

  await logActivity(adminId, 'ACCOUNT_ERASED', {
    module: 'account-lifecycle',
    targetType: 'User',
    targetId: parties.userId,
    metadata: {
      erasureRequestId: id,
      dpoName: request.dpoName,
      approvedById: request.approvedById,
      retainUntil: retainUntil.toISOString(),
      retentionYears: years,
      ...footprint,
    },
  });

  return { ...view(done), footprint };
}

/* ------------------------------------------------------------------ */
/* The tombstone                                                       */
/* ------------------------------------------------------------------ */

/**
 * Whether this number was erased -- the answer behind auth's
 * `MobileTombstonePort`.
 *
 * Never refuses a registration: an erased person is entitled to come back, and
 * all this decides is whether the new account carries an activity row saying
 * the number has been here before.
 */
export async function wasMobileErased(mobile: string): Promise<boolean> {
  return repository.isTombstoned(hashMobile(mobile));
}

/**
 * For Lot E's retention sweep (`modules/ops`): the PENDING requests past
 * their thirty days, and the DONE ones past `retainUntil`. Reads only.
 */
export const erasuresDue = (now: Date): Promise<ErasureRequest[]> => repository.listErasuresDue(now);
export const erasuresPastRetention = (now: Date): Promise<ErasureRequest[]> =>
  repository.listErasuresPastRetention(now);
