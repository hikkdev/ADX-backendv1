import { logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { closeOpenLeadsInCity } from '../leads';
import { unpublishListing } from '../listings';
import { notify } from '../notifications';
import type { GeoCityRow, GeoRepository } from './geo.repository';
import { prismaGeoRepository, WIND_DOWN_MARK } from './prisma-geo.repository';
import { matchOf } from './rollout.service';

/**
 * The wind-down — Lot V.
 *
 * A stage change to WITHDRAWN switches everything off at once (no new
 * listings, no publishing, no campaigns, no agents, no partners, no leads
 * — the gates do that) and leaves four duties for the hourly job
 * (`jobs/city-winddown.job.ts`), one city at a time:
 *
 *   1. every ACTIVE listing in the city off the market, through
 *      `listings.unpublishListing` (INACTIVE, audited LISTING_UNPUBLISHED
 *      with cause CITY_WITHDRAWN), and each publisher told once —
 *      CITY_WITHDRAWN, email + push + in-app;
 *   2. running campaigns left to complete — nothing here touches an order
 *      or a campaign; `demand` off is what stops new bookings;
 *   3. every open lead in the city LOST, "city withdrawn" on the thread;
 *   4. every active agent in the city told, once.
 *
 * Idempotent by a marker: when a city is done the job writes a
 * CityRolloutEvent WITHDRAWN → WITHDRAWN noted `WIND_DOWN_DONE` with the
 * counts, and a city whose marker is newer than its `withdrawnAt` is not
 * walked again. Re-entry (WITHDRAWN → SEEDING or LAUNCHED) republishes
 * nothing: the listings stay INACTIVE and each publisher relists what they
 * still have. PAUSED has no wind-down.
 */

export type WindDownSummary = {
  city: string;
  listingsUnpublished: number;
  listingsFailed: number;
  publishersTold: number;
  leadsClosed: number;
  agentsTold: number;
};

let repository: GeoRepository = prismaGeoRepository;

/** Tests only: swap the repository. */
export function setWindDownRepository(next: GeoRepository | null): void {
  repository = next ?? prismaGeoRepository;
}

const TAG = 'cityWindDown';

async function tell(userId: string, city: string, detail: string, title: string): Promise<void> {
  try {
    await notify(
      'CITY_WITHDRAWN',
      userId,
      { city, detail },
      { type: 'SYSTEM', inApp: { type: 'SYSTEM', title, subtitle: city, message: detail } },
    );
  } catch (err) {
    logger.warn('City wind-down notice not sent', { tag: TAG, userId, city, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** The four duties for one WITHDRAWN city, then the marker. */
export async function windDownCity(city: GeoCityRow, actorUserId: string, now = new Date()): Promise<WindDownSummary> {
  // Lot X-B: every row keyed to the city, however typed — and the rows typed under one of its spellings with no key.
  const match = matchOf(city);
  const summary: WindDownSummary = { city: city.slug, listingsUnpublished: 0, listingsFailed: 0, publishersTold: 0, leadsClosed: 0, agentsTold: 0 };

  // 1. The live listings, each through the listings module's own door.
  const listings = await repository.activeListings(match);
  const perPublisher = new Map<string, number>();
  for (const listing of listings) {
    try {
      await unpublishListing(listing.id, { reason: `ADX has withdrawn from ${city.name}.`, actorUserId, cause: 'CITY_WITHDRAWN' });
      summary.listingsUnpublished += 1;
      if (listing.publisherUserId) perPublisher.set(listing.publisherUserId, (perPublisher.get(listing.publisherUserId) ?? 0) + 1);
    } catch (err) {
      summary.listingsFailed += 1;
      logger.warn('City wind-down could not unpublish a listing', { tag: TAG, listingId: listing.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const [userId, count] of perPublisher) {
    await tell(
      userId,
      city.name,
      `${count} of your listing${count === 1 ? '' : 's'} in ${city.name} ${count === 1 ? 'was' : 'were'} taken off the market. Bookings already running complete as scheduled and are paid out as usual.`,
      'Your listings are off the market',
    );
    summary.publishersTold += 1;
  }

  // 2. Running campaigns complete on their own; `demand` off stops new ones.

  // 3. The open leads.
  summary.leadsClosed = (await closeOpenLeadsInCity(match, actorUserId)).length;

  // 4. The agents.
  for (const userId of new Set(await repository.agentUserIds(match))) {
    await tell(userId, city.name, `No new work will be offered in ${city.name}. Work you have already accepted completes as scheduled.`, `ADX has closed in ${city.name}`);
    summary.agentsTold += 1;
  }

  await repository.createRolloutEvents([
    { cityId: city.id, fromStage: 'WITHDRAWN', toStage: 'WITHDRAWN', flags: { winddown: summary }, byUserId: actorUserId, note: WIND_DOWN_MARK, at: now },
  ]);
  await logActivity(actorUserId, 'CITY_WOUND_DOWN', { module: 'geo', targetType: 'City', targetId: city.slug, metadata: { ...summary } });
  return summary;
}

/** Every WITHDRAWN city not yet wound down since it was withdrawn. */
export async function runCityWindDown(actorUserId: string, now = new Date()): Promise<WindDownSummary[]> {
  const due = (await repository.withdrawnCities()).filter(
    ({ city, woundDownAt }) => city.withdrawnAt !== null && (woundDownAt === null || woundDownAt.getTime() < city.withdrawnAt.getTime()),
  );
  const out: WindDownSummary[] = [];
  for (const { city } of due) out.push(await windDownCity(city, actorUserId, now));
  return out;
}
