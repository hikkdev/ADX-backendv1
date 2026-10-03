import { prisma } from '../../shared/database';
import type { ListingViewsRepository } from './listing-views.repository';

type RecordRow = { counted: boolean; unique_visitor: boolean | null };

/**
 * LD-1: the spot-page view count's writes. Raw SQL because the count is an
 * upsert that adds, gated on a second upsert's outcome — one statement of
 * data-modifying CTEs, every value bound as a parameter:
 *
 *   v      the visitor's key for the day; on a conflict it is touched only
 *          when the last view is older than the repeat window, so a page
 *          that fired twice returns no row and counts nothing;
 *   d      the day's row, +1 view (and +1 visitor when `v` inserted);
 *   purge  on the day's first row, the listing's keys of earlier days —
 *          only today's keys are ever read.
 */
export const prismaListingViewsRepository: ListingViewsRepository = {
  async findLiveForView(idOrDisplayId) {
    const row = await prisma.listing.findFirst({
      where: { status: 'ACTIVE', OR: [{ id: idOrDisplayId }, { displayId: idOrDisplayId }] },
      select: {
        id: true,
        publisher: { select: { userId: true, agent: { select: { userId: true } } } },
        agent: { select: { userId: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      publisherUserId: row.publisher?.userId ?? null,
      publisherAgentUserId: row.publisher?.agent?.userId ?? null,
      agentUserId: row.agent?.userId ?? null,
    };
  },

  async record({ listingId, day, visitorHash, source, now, repeatWithinMs }) {
    const cutoff = new Date(now.getTime() - repeatWithinMs);
    const web = source === 'WEB' ? 1 : 0;
    const app = source === 'APP' ? 1 : 0;
    const rows = await prisma.$queryRaw<RecordRow[]>`
      WITH v AS (
        INSERT INTO "ListingViewVisitor" ("listingId", "day", "visitorHash", "lastViewAt")
        VALUES (${listingId}, ${day}::date, ${visitorHash}, ${now})
        ON CONFLICT ("listingId", "day", "visitorHash")
        DO UPDATE SET "lastViewAt" = EXCLUDED."lastViewAt"
        WHERE "ListingViewVisitor"."lastViewAt" < ${cutoff}
        RETURNING (xmax = 0) AS fresh
      ),
      d AS (
        INSERT INTO "ListingView" ("listingId", "day", "views", "uniqueVisitors", "webViews", "appViews", "updatedAt")
        SELECT ${listingId}, ${day}::date, 1, CASE WHEN v.fresh THEN 1 ELSE 0 END, ${web}, ${app}, ${now} FROM v
        ON CONFLICT ("listingId", "day") DO UPDATE SET
          "views" = "ListingView"."views" + 1,
          "uniqueVisitors" = "ListingView"."uniqueVisitors" + EXCLUDED."uniqueVisitors",
          "webViews" = "ListingView"."webViews" + EXCLUDED."webViews",
          "appViews" = "ListingView"."appViews" + EXCLUDED."appViews",
          "updatedAt" = EXCLUDED."updatedAt"
        RETURNING (xmax = 0) AS fresh_day
      ),
      purge AS (
        DELETE FROM "ListingViewVisitor"
         WHERE "listingId" = ${listingId} AND "day" < ${day}::date
           AND EXISTS (SELECT 1 FROM d WHERE d.fresh_day)
      )
      SELECT EXISTS (SELECT 1 FROM v) AS counted, (SELECT fresh FROM v) AS unique_visitor`;
    const row = rows[0];
    return { counted: row?.counted === true, uniqueVisitor: row?.unique_visitor === true };
  },
};
