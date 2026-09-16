import { getFlow, ONBOARDING_FLOW_KEY } from '../app-config';
import { logger } from '../../shared/logging';

/**
 * Lot F (E7-1, migration `lot_e_addendum_2`): the onboarding-manifest version
 * a party climbs is pinned on their KYC row — `PublisherKyc.manifestVersion`
 * / `AdvertiserKyc.manifestVersion` — at the first submission, so a console
 * edit to `flows.onboarding` does not move the rungs under somebody
 * mid-ladder. The pin used to be the phone's (`?version=` on every read);
 * it is the server's now: `GET /users/me/onboarding-manifest` answers the
 * pinned version when the row has one and no `?version=` is given.
 *
 * What is pinned is the version the phone sends with the documents (the
 * `manifestVersion` the manifest read handed it), or — for a phone built
 * before it sent one — the version live at the moment of the first
 * submission, which is the one it rendered. Once set the pin never moves;
 * the repositories write it only where the column is still null.
 */
export async function resolveManifestVersion(sent: number | null | undefined): Promise<number | null> {
  if (typeof sent === 'number' && Number.isInteger(sent) && sent > 0) return sent;
  try {
    const flow = await getFlow(ONBOARDING_FLOW_KEY);
    const version = flow?.['version'];
    return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null;
  } catch (err) {
    logger.warn('Could not read the live onboarding flow version; the KYC row stays unpinned', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
