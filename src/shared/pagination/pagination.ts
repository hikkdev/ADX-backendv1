/**
 * Bounded reads.
 *
 * The default across this codebase used to be an unbounded `findMany`, which is
 * fine at a few thousand rows and a table scan into an out-of-region database at
 * a few million. Rather than remembering a `take` at 62 call sites, list
 * repositories take a `PageQuery` and return a `Page`, so the bound is part of
 * the contract instead of a thing to forget.
 *
 * Cursor rather than offset: these lists are queues that are written to while
 * they are being read, and OFFSET both drifts (a row inserted above page 1
 * pushes a row from page 1 onto page 2, unseen) and degrades, because the
 * database still walks the skipped rows.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageQuery {
  /** Id of the last row of the previous page. */
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  rows: T[];
  /** Pass back as `cursor` for the next page. Null when the list is exhausted. */
  nextCursor: string | null;
}

/** Clamps a caller-supplied limit into something the database can be asked for. */
export function pageSize(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/**
 * Prisma arguments for one page. Takes one row more than asked for, which is
 * how `toPage` knows whether another page exists without a second count query.
 */
export function pageArgs(query: PageQuery = {}) {
  const size = pageSize(query.limit);
  return {
    take: size + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  };
}

/** Trims the probe row off and reports the cursor for the next page. */
export function toPage<T extends { id: string }>(rows: T[], query: PageQuery = {}): Page<T> {
  const size = pageSize(query.limit);
  if (rows.length <= size) return { rows, nextCursor: null };
  const page = rows.slice(0, size);
  return { rows: page, nextCursor: page[page.length - 1]?.id ?? null };
}

/** Parses `?cursor=&limit=` off a request query without trusting either. */
export function pageQueryFrom(query: Record<string, unknown>): PageQuery {
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : undefined;
  const rawLimit = query['limit'];
  const limit = typeof rawLimit === 'string' ? Number(rawLimit) : undefined;
  return { cursor, limit: Number.isFinite(limit) ? limit : undefined };
}
