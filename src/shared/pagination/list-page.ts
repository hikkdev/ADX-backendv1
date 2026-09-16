import { z } from 'zod';

/**
 * Designed lists — the other half of the pagination contract.
 *
 * `pagination.ts` pages a queue with a cursor and deliberately reports no
 * total: a queue is written while it is read, so OFFSET drifts and a second
 * COUNT is a second table walk. That is the right shape for the desks
 * (supply, agreements, advertisers) and the wrong shape for every list DR 06
 * and DR 10 draw, because those screens print a count in the header
 * ("18 Publishers", "128 spaces", "1-10 of 12"), label their status chips, and
 * show a filtered preview before it is applied ("Show 43 spaces"). None of
 * that can be answered without a total and a per-status histogram.
 *
 * So: cursor for queues, this for catalogues. The rule is the shape of the
 * screen, not the size of the table — and the two live side by side on
 * purpose rather than one replacing the other.
 *
 * The shape here is the one that already works: `GET /listings/browse` has
 * returned `{ items, total, page, pageSize }` since DR 01 and the phone reads
 * it whole. This adds `counts` and makes the query parsing reusable so the
 * next eight endpoints do not each invent their own.
 */

export const DEFAULT_LIST_PAGE_SIZE = 20;
export const MAX_LIST_PAGE_SIZE = 100;

export interface ListPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Rows per status, for the chip labels.
   *
   * Counted against the filter with the status facet REMOVED — otherwise
   * selecting "Live" makes every other chip read zero and the row of chips
   * stops being a way back out. Every status the module declares appears,
   * including the ones at zero, so a chip never silently disappears.
   */
  counts: Record<string, number>;
}

/**
 * `?q=&status=&sort=&page=&pageSize=` for one module.
 *
 * Each module passes its own status values and sort keys, so the wire shape is
 * identical everywhere while the vocabulary stays the module's own. Status
 * arrives as a comma list because that is how a chip row serialises, and it is
 * parsed against the enum rather than cast — `GET /orders` takes
 * `z.string()` and casts it `as any` today, which turns a typo into a 500
 * instead of a 400.
 */
export function listQuerySchema<S extends readonly [string, ...string[]], K extends readonly [string, ...string[]]>(
  statuses: S,
  sorts: K,
) {
  return z.object({
    q: z.string().trim().min(1).max(120).optional(),
    status: z
      .string()
      .optional()
      .transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(statuses)).optional()),
    sort: z.enum(sorts).default(sorts[0]),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  });
}

/** What a `listQuerySchema` parses to, minus the module's own vocabulary. */
export interface ListQuery {
  page: number;
  pageSize: number;
  q?: string | undefined;
  status?: readonly string[] | undefined;
  sort?: string | undefined;
}

/** Prisma arguments for one page. Offset here is the point — see the header. */
export function listArgs(query: Pick<ListQuery, 'page' | 'pageSize'>): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/**
 * Folds a `groupBy({ by: ['status'], _count: { _all: true } })` into the chip
 * histogram, filling in every status the module declares.
 */
export function countsFrom(
  groups: readonly { status: string; _count: { _all: number } }[],
  statuses: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = 0;
  for (const group of groups) counts[group.status] = group._count._all;
  return counts;
}

/** The page, travelling whole — items, total and the chip counts together. */
export function toListPage<T>(
  items: T[],
  total: number,
  counts: Record<string, number>,
  query: Pick<ListQuery, 'page' | 'pageSize'>,
): ListPage<T> {
  return { items, total, page: query.page, pageSize: query.pageSize, counts };
}
