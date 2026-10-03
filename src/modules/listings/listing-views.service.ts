import { createHmac } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import { isoIST } from '../../shared/time';
import type { ListingViewSource } from './listing-views.repository';
import { prismaListingViewsRepository as repository } from './prisma-listing-views.repository';

/**
 * LD-1 (the owner, 3 Oct 2026): count spot-page views.
 *
 * `POST /listings/:displayIdOrId/view { source: 'WEB' | 'APP' }` — public,
 * metered by IP, behind `listings.spot-views`. The website's spot page and
 * marketplace detail fire it once per page view; the apps' advertiser
 * listing screen once per open. It answers `{ counted }` and nothing else:
 * no id, no address, no count.
 *
 * Counted per listing per Indian day, as views and unique visitors:
 *  - a visitor is the signed-in user, else the address and the browser —
 *    each only ever as an HMAC keyed with a server secret and salted with
 *    the day and the listing, so the stored key cannot be turned back into
 *    an address and does not link a person across days or spots;
 *  - a repeat by the same visitor within a minute is the same view (a page
 *    that fired twice); later ones are views but not new visitors;
 *  - never counted: obvious bots (no browser, or a crawler's name), ADX
 *    staff, and the listing's own publisher and agent (the one who keyed
 *    it in, and the one who manages the publisher).
 */

/** A repeat within this window is the same view. */
export const VIEW_REPEAT_WINDOW_MS = 60_000;

/** Crawlers, link previews, monitors and scripts — what is not a person opening a page. */
const BOT_AGENT =
  /bot\b|bot\/|crawl|spider|slurp|scrape|preview|facebookexternalhit|whatsapp|telegram|discord|embedly|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget\/|python-|httpclient|axios\/|node-fetch|go-http|java\/|libwww|postman/i;

/** No browser string worth the name, or one a crawler, a link preview or a script sends. */
export function isLikelyBot(userAgent: string | undefined | null): boolean {
  const agent = (userAgent ?? '').trim();
  return agent.length < 8 || BOT_AGENT.test(agent);
}

export type ViewRequest = {
  idOrDisplayId: string;
  source: ListingViewSource;
  /** The signed-in caller, when there is one. */
  user: { id: string; roles: readonly string[] } | null;
  ip: string | null;
  userAgent: string | null;
};

/** The visitor's key for one listing on one day. */
export function visitorKey(listingId: string, day: string, visitor: { userId: string | null; ip: string | null; userAgent: string | null }): string {
  const who = visitor.userId ? `u:${visitor.userId}` : `a:${visitor.ip ?? '?'}|${visitor.userAgent ?? ''}`;
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`listing-view|${day}|${listingId}|${who}`).digest('base64url');
}

export async function recordListingView(request: ViewRequest, now = new Date()): Promise<{ counted: boolean }> {
  const idOrDisplayId = request.idOrDisplayId.trim();
  if (!idOrDisplayId || idOrDisplayId.length > 64) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  const listing = await repository.findLiveForView(idOrDisplayId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');

  if (isLikelyBot(request.userAgent)) return { counted: false };
  const user = request.user;
  if (user) {
    if (user.roles.includes('ADMIN')) return { counted: false };
    const own = [listing.publisherUserId, listing.publisherAgentUserId, listing.agentUserId];
    if (own.includes(user.id)) return { counted: false };
  }

  const day = isoIST(now).slice(0, 10);
  const { counted } = await repository.record({
    listingId: listing.id,
    day,
    visitorHash: visitorKey(listing.id, day, { userId: user?.id ?? null, ip: request.ip, userAgent: request.userAgent }),
    source: request.source,
    now,
    repeatWithinMs: VIEW_REPEAT_WINDOW_MS,
  });
  return { counted };
}
