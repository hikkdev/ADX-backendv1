import type { Request } from 'express';
import type { Prisma } from '../database';
import { prisma } from '../database/prisma';
import { listArgs, type ListPage } from '../pagination/list-page';

/**
 * The audit trail — Lot A, Q28.
 *
 * One table, two ways in. `logActivity` is the hand-written row: a controller
 * or service naming what happened in its own vocabulary (`ORDER_APPROVED`,
 * `WALLET_ADJUSTED`). `audit-admin-writes.ts` is the safety net underneath:
 * every successful admin write that nobody logged by hand still leaves a
 * generic row. The first suppresses the second through `res.locals.audited`.
 */

export type AuditDiff = Record<string, { before: unknown; after: unknown }>;

/**
 * The second form of `logActivity`. Everything is optional: a service that
 * has no request still names the target, and a job that acts on behalf of a
 * request it never saw can carry the id through.
 */
export interface LogActivityOptions {
  req?: Request | undefined;
  /** Model name — `Order`, `Wallet`, `Publisher`. */
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** Which module wrote it: the first path segment, `orders`, `wallets`. */
  module?: string | undefined;
  /** `{ field: { before, after } }` — build it with `auditDiff`. */
  diff?: AuditDiff | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Only when there is no `req` to take it from. */
  requestId?: string | undefined;
}

function isRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    'headers' in value &&
    'method' in value &&
    typeof (value as { headers: unknown }).headers === 'object'
  );
}

/**
 * Tells the generic admin-write tap that this response is already audited.
 * `req.res` is Express's back-reference; absent on a bare request in a test
 * or a job, in which case there is nothing to suppress.
 */
function markAudited(req: Request | undefined): void {
  const res = req?.res;
  if (res?.locals) res.locals['audited'] = true;
}

/**
 * Write one audit row.
 *
 * Two signatures, both live:
 *
 *   logActivity(userId, action, req?, metadata?)            — the original 59 call sites
 *   logActivity(userId, action, { req?, targetType?, targetId?, module?, diff?, metadata?, requestId? })
 *
 * The request id is taken from `req` when there is one. A call carrying a
 * request marks its response audited so `auditAdminWrites` writes no second row.
 */
export async function logActivity(userId: string, action: string, options: LogActivityOptions): Promise<void>;
// The original signature is the LAST overload on purpose: `Parameters<typeof
// logActivity>[2]` resolves against the last one, and safety.service types its
// `req` that way.
export async function logActivity(
  userId: string,
  action: string,
  req?: Request,
  metadata?: Record<string, unknown>,
): Promise<void>;
export async function logActivity(
  userId: string,
  action: string,
  reqOrOptions?: Request | LogActivityOptions,
  legacyMetadata?: Record<string, unknown>,
): Promise<void> {
  const options: LogActivityOptions = isRequest(reqOrOptions)
    ? { req: reqOrOptions, metadata: legacyMetadata }
    : { ...(reqOrOptions ?? {}), metadata: reqOrOptions?.metadata ?? legacyMetadata };
  const req = options.req;

  markAudited(req);

  await prisma.activityLog.create({
    data: {
      userId,
      action,
      metadata: options.metadata as Prisma.InputJsonValue | undefined,
      ipAddress: req?.ip,
      userAgent: req?.headers['user-agent'],
      targetType: options.targetType,
      targetId: options.targetId,
      module: options.module,
      requestId: req?.requestId ?? options.requestId,
      diff: options.diff as Prisma.InputJsonValue | undefined,
    },
  });
}

/* ── reading it back ─────────────────────────────────────────────── */

export interface ActivityFilter {
  /** Contains, case-insensitive, on action or targetId. */
  q?: string | undefined;
  action?: string | undefined;
  module?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  userId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export const ACTIVITY_SORTS = ['newest', 'oldest'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

export interface ActivityPage {
  page: number;
  pageSize: number;
  sort: ActivitySort;
}

/** Rows with no module — the pre-Lot-A call sites — are counted under this key. */
export const NO_MODULE = '(none)';

export function activityWhere(filter: ActivityFilter, facets: { module: boolean } = { module: true }): Prisma.ActivityLogWhereInput {
  const where: Prisma.ActivityLogWhereInput = {};
  if (filter.action) where.action = filter.action;
  if (filter.module && facets.module) where.module = filter.module;
  if (filter.targetType) where.targetType = filter.targetType;
  if (filter.targetId) where.targetId = filter.targetId;
  if (filter.userId) where.userId = filter.userId;
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  if (filter.q) {
    where.OR = [
      { action: { contains: filter.q, mode: 'insensitive' } },
      { targetId: { contains: filter.q, mode: 'insensitive' } },
    ];
  }
  return where;
}

function orderBy(sort: ActivitySort): Prisma.ActivityLogOrderByWithRelationInput[] {
  const direction = sort === 'oldest' ? 'asc' : 'desc';
  return [{ createdAt: direction }, { id: direction }];
}

const ACTOR = { user: { select: { id: true, name: true, email: true } } } as const;

export type ActivityRow = Prisma.ActivityLogGetPayload<{ include: typeof ACTOR }>;

/**
 * The list contract over the audit trail: items with the actor joined, the
 * total, and a histogram by module counted with the module facet removed so
 * the chip row stays a way back out.
 */
export async function findActivity(filter: ActivityFilter, page: ActivityPage): Promise<ListPage<ActivityRow>> {
  const where = activityWhere(filter);
  const [items, total, groups] = await Promise.all([
    prisma.activityLog.findMany({ where, orderBy: orderBy(page.sort), ...listArgs(page), include: ACTOR }),
    prisma.activityLog.count({ where }),
    prisma.activityLog.groupBy({ by: ['module'], where: activityWhere(filter, { module: false }), _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const group of groups) counts[group.module ?? NO_MODULE] = group._count._all;
  return { items, total, page: page.page, pageSize: page.pageSize, counts };
}

/**
 * One slice of the same query without the count and histogram — what an
 * export walks through, a thousand rows at a time.
 */
export async function findActivityRows(
  filter: ActivityFilter,
  slice: { skip: number; take: number; sort: ActivitySort },
): Promise<ActivityRow[]> {
  return prisma.activityLog.findMany({
    where: activityWhere(filter),
    orderBy: orderBy(slice.sort),
    skip: slice.skip,
    take: slice.take,
    include: ACTOR,
  });
}

/**
 * Entries of the given actions whose metadata names a subject — the writes
 * made FOR an account rather than BY it (an agent editing a publisher under a
 * grant is logged against the agent, with the publisher in the metadata).
 * Newest first, with who did it.
 */
export async function findActivityByMetadata(actions: string[], key: string, value: string, limit = 100) {
  return prisma.activityLog.findMany({
    where: { action: { in: actions }, metadata: { path: [key], equals: value } },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function listActivity(userId: string, limit = 50) {
  return prisma.activityLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
