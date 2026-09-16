import { ApiError } from '../../shared/errors';
import { getPlatformSettings } from '../app-config';
import { getAdvertiserForUser } from '../advertisers';
import { registerWaitlistLead } from '../leads';
import { findPublisherForUser } from '../publishers';
import { findUserSummaries } from '../users';
import type { CityStageValue } from '../pricing';
import { requireCity } from './rollout.service';
import type { WaitlistBody } from './rollout.schema';

/**
 * The coming-soon waitlist — W-B.
 *
 * The pickers (`GET /app/geo/cities`) show the SEEDING cities and the
 * PLANNED capitals as "coming soon" while `settings.geo.comingSoonWaitlist`
 * is on; this is the tap under them. It becomes a lead through `leads`
 * (`registerWaitlistLead`): the side from the body, the business, contact
 * and phone from the caller's own account — the profile on the side asked
 * for first, the other side's next, the login's name and mobile last — the
 * city, point from the catalogue row, `source` WAITLIST, interest "Notify
 * me when <city> launches". The phone rule dedupes: a second tap answers
 * the lead the number already has (`created: false`, the route's 200).
 *
 * Refused: a LAUNCHED city (409 ALREADY_LIVE — go there instead), the
 * setting off (503 FEATURE_OFF `{ key }`, the platform's settings-off
 * shape). Nothing is audited — it is the requester's own act, and the
 * lead's IMPORTED row names the source.
 */

export const WAITLIST_SETTING_KEY = 'geo.comingSoonWaitlist';

export type WaitlistOutcome = { leadId: string; city: string; stage: CityStageValue; created: boolean };

type Caller = { businessName: string; contactName: string | undefined; phone: string | undefined };

/** The account behind the tap, on the side asked for first. */
async function callerOf(userId: string, side: WaitlistBody['side']): Promise<Caller> {
  const asPublisher = async (): Promise<Caller | null> => {
    const publisher = await findPublisherForUser(userId);
    return publisher ? { businessName: publisher.name, contactName: publisher.contactName ?? publisher.name, phone: publisher.mobile } : null;
  };
  const asAdvertiser = async (): Promise<Caller | null> => {
    const advertiser = await getAdvertiserForUser(userId);
    return advertiser ? { businessName: advertiser.companyName ?? advertiser.name, contactName: advertiser.name, phone: advertiser.mobile } : null;
  };
  const [first, second] = side === 'PUBLISHER' ? [asPublisher, asAdvertiser] : [asAdvertiser, asPublisher];
  const profile = (await first()) ?? (await second());
  if (profile) return profile;
  const user = (await findUserSummaries([userId])).get(userId);
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  const name = user.name ?? user.mobile;
  return { businessName: name, contactName: user.name ?? undefined, phone: user.mobile };
}

export async function joinWaitlist(body: WaitlistBody, userId: string): Promise<WaitlistOutcome> {
  const settings = (await getPlatformSettings()).geo;
  if (!settings.comingSoonWaitlist) throw new ApiError(503, 'FEATURE_OFF', 'The waitlist is switched off', { key: WAITLIST_SETTING_KEY });
  const city = await requireCity(body.citySlug);
  if (city.stage === 'LAUNCHED') {
    throw new ApiError(409, 'ALREADY_LIVE', `ADX is already open in ${city.name}`, { city: city.slug, stage: city.stage });
  }
  const caller = await callerOf(userId, body.side);
  const { lead, created } = await registerWaitlistLead(
    {
      side: body.side,
      businessName: caller.businessName,
      ...(caller.contactName !== undefined ? { contactName: caller.contactName } : {}),
      ...(caller.phone !== undefined ? { phone: caller.phone } : {}),
      city: city.name,
      ...(city.latitude !== null ? { latitude: city.latitude } : {}),
      ...(city.longitude !== null ? { longitude: city.longitude } : {}),
      interest: `Notify me when ${city.name} launches`,
      ...(body.note !== undefined ? { note: body.note } : {}),
    },
    userId,
  );
  return { leadId: lead.id, city: city.name, stage: city.stage, created };
}
