import { logger } from '../../shared/logging';

/**
 * LM-1 (27 Sep 2026): sponsored listings — "some advertiser wants their space
 * advertised above all similar listings" (the owner).
 *
 * `promotions` sells the boosts and reads this module (the listing a boost is
 * for), so this module cannot read `promotions` back without closing a cycle.
 * The dependency is inverted: this declares what browse needs — the boosts
 * running today for one placement, and how many of them a page may carry —
 * `promotions` implements it, and `bootstrap/register-modules` connects the
 * two. Unregistered (a test, a stripped build) or failing, the answer is "no
 * sponsored listings": a page without them is still the right page.
 */

export type SponsoredPlacement = 'SEARCH_TOP' | 'SIMILAR_TOP';

export type SponsoredBoost = { boostId: string; listingId: string };

export interface SponsoredPort {
  /**
   * The boosts running today for this placement (LIVE, or SCHEDULED with
   * today inside their dates), and the placement's `maxConcurrent` — the
   * most a page shows. Empty while the `promotions.boosts` switch is off.
   */
  live(placement: SponsoredPlacement, now: Date): Promise<{ max: number; boosts: SponsoredBoost[] }>;
}

let registered: SponsoredPort | null = null;

export function registerSponsoredPort(port: SponsoredPort): void {
  registered = port;
}

export async function liveSponsored(placement: SponsoredPlacement, now = new Date()): Promise<{ max: number; boosts: SponsoredBoost[] }> {
  if (!registered) return { max: 0, boosts: [] };
  try {
    return await registered.live(placement, now);
  } catch (err) {
    logger.warn('Sponsored listings unreadable; the page goes without them', { placement, err });
    return { max: 0, boosts: [] };
  }
}

/** The page's order: a shuffle so the boosts sharing a placement take turns at the top. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}
