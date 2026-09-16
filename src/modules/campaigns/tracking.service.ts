import { randomBytes } from 'crypto';
import { ApiError } from '../../shared/errors';
import { env } from '../../config/env';
import { logger } from '../../shared/logging';
import { dynamicCodesAvailable, registerDynamicCodes } from '../../shared/qr-engine';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { TrackingCodeRow } from './campaigns.repository';

/**
 * Measurement, and the reason it is worth anything.
 *
 * DR 02 offers four answers to "how will you track?", and three of them are only
 * as good as who counts. A QR code printed by the advertiser and pointed
 * straight at their own site produces a number ADX cannot see and cannot stand
 * behind. So every code issued here resolves through the platform first: the
 * scan is recorded, then the visitor is sent on, with the advertiser's UTM tags
 * intact. One redirect, one row, one number both sides can audit.
 *
 * Location lift is not measured. It needs a mobile-panel provider, ADX has no
 * contract with one, and a lift figure invented from nothing would be the worst
 * kind of number on this screen — so that path records the brief and reports
 * "not measured" until a provider exists.
 */

/**
 * Unambiguous in print and over a phone: no 0/O, no 1/I/L. A QR that scans as a
 * different campaign because someone read an O for a zero is a bad afternoon.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[bytes[index]! % ALPHABET.length];
  }
  return code;
}

async function uniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    if (!(await repository.codeExists(code))) return code;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a tracking code');
}

/**
 * The scan URL a QR encodes.
 *
 * `BASE_URL` is the platform's public address. Unset in development, where a
 * localhost URL in a printed QR would be useless anyway, so the code falls back
 * to the local port and the caller sees plainly that it is not printable.
 */
export const trackingUrl = (code: string): string => {
  const base = env.BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base.replace(/\/$/, '')}/t/${code}`;
};

/**
 * QR-1: the URL the hoarding actually carries. The engine's short URL when
 * the code is hosted (GenQR `/r/XXXX`, which 302s to `/t/XXXX`), else `/t/`
 * itself. Everything that prints or draws a code asks this, so the two
 * never disagree.
 */
export const printedUrl = (code: Pick<TrackingCodeRow, 'code' | 'shortUrl'>): string => code.shortUrl ?? trackingUrl(code.code);

/** QR-1: what the engine names a code — the campaign's reference and the spot, for the desk on GenQR's side. */
function engineName(campaign: { reference: string }, code: TrackingCodeRow, spotTitle: string | null): string {
  return `${campaign.reference} · ${spotTitle ?? code.code}`;
}

/**
 * QR-1: puts the engine's dynamic code in front of every QR tracking code
 * the campaign has that is not yet hosted. Idempotent — a linked code is
 * skipped — and quiet when no engine hosts codes: the hoarding then carries
 * `/t/` and the sync route links it later. A failure of the engine itself
 * is thrown, so a deliberate sync can say what went wrong; `issueTrackingCodes`
 * catches it, because paying for a campaign must not fail on a vendor.
 *
 * Returns the codes linked on this call.
 */
export async function linkCodesToEngine(campaignId: string): Promise<TrackingCodeRow[]> {
  if (!(await dynamicCodesAvailable())) return [];
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  const pending = campaign.codes.filter((code) => code.method === 'QR_OR_DEEPLINK' && !code.engineCodeId);
  if (pending.length === 0) return [];

  const titles = new Map(campaign.spots.map((spot) => [spot.id, spot.listing?.title ?? null] as const));
  const minted = await registerDynamicCodes(
    pending.map((code) => ({ name: engineName(campaign, code, code.spotId ? (titles.get(code.spotId) ?? null) : null), target: trackingUrl(code.code) })),
  );
  const at = new Date();
  await repository.linkTrackingCodesToEngine(
    pending.map((code, index) => ({ id: code.id, engineCodeId: minted[index]!.engineCodeId, shortUrl: minted[index]!.shortUrl })),
    at,
  );
  return pending.map((code, index) => ({ ...code, engineCodeId: minted[index]!.engineCodeId, shortUrl: minted[index]!.shortUrl, engineLinkedAt: at }));
}

type QrConfig = { destinationUrl?: string; utmCampaign?: string };
type VanityConfig = { vanityUrl?: string; promoCode?: string; redemptionWindow?: string };

/**
 * Appends the campaign's UTM tags to the advertiser's destination.
 *
 * Their own tags win: an advertiser who has already put `utm_campaign` on the
 * URL has a reason, and overwriting it would break their own reporting.
 */
export function withUtm(destination: string, utmCampaign: string | null, code: string): string {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The destination has to be a full URL.');
  }
  if (!url.searchParams.has('utm_source')) url.searchParams.set('utm_source', 'adx');
  if (!url.searchParams.has('utm_medium')) url.searchParams.set('utm_medium', 'ooh');
  if (utmCampaign && !url.searchParams.has('utm_campaign')) {
    url.searchParams.set('utm_campaign', utmCampaign);
  }
  if (!url.searchParams.has('utm_content')) url.searchParams.set('utm_content', code);
  return url.toString();
}

/**
 * Issues the codes a campaign needs, once it is paid for.
 *
 * One per booked slot for QR, as the screen promises — a single code across
 * every site would tell you the campaign worked without telling you which
 * hoarding did the work. One per campaign for a vanity URL or promo code, which
 * is what a printed code is.
 *
 * Idempotent: a campaign that already has codes gets none.
 */
export async function issueTrackingCodes(campaignId: string): Promise<TrackingCodeRow[]> {
  const rows = await issueTrackingCodesLocally(campaignId);
  // QR-1: best effort — the engine's hold on the codes. A vendor that does
  // not answer at payment time is logged, not fatal; the hoarding carries
  // /t/ until the sync route links it.
  if (rows.some((row) => row.method === 'QR_OR_DEEPLINK' && !row.engineCodeId)) {
    try {
      const linked = await linkCodesToEngine(campaignId);
      if (linked.length > 0) {
        const byId = new Map(linked.map((row) => [row.id, row]));
        return rows.map((row) => byId.get(row.id) ?? row);
      }
    } catch (cause) {
      const reason = cause instanceof ApiError ? `${cause.code}: ${cause.message}` : String(cause);
      logger.warn('QR engine did not take the campaign codes; the hoarding carries /t/ until synced', { campaignId, reason });
    }
  }
  return rows;
}

async function issueTrackingCodesLocally(campaignId: string): Promise<TrackingCodeRow[]> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  if (campaign.codes.length > 0) return campaign.codes;

  if (campaign.trackingMethod === 'NONE' || campaign.trackingMethod === 'LOCATION_LIFT') {
    return [];
  }

  if (campaign.trackingMethod === 'QR_OR_DEEPLINK') {
    // Lot D (Q139): the destination is optional. Without one the code
    // resolves to the plain "Thanks for scanning" page — the scan still
    // counts — until Lot E's page builder gives the campaign a page.
    const config = (campaign.trackingConfig ?? {}) as QrConfig;
    const bookable = campaign.spots.filter((spot) => spot.status !== 'CANCELLED');
    const rows = [];
    for (const spot of bookable) {
      const code = await uniqueCode();
      rows.push({
        campaignId,
        spotId: spot.id,
        code,
        method: campaign.trackingMethod,
        destination: config.destinationUrl
          ? withUtm(config.destinationUrl, config.utmCampaign ?? null, code)
          : null,
        vanityPath: null,
        promoCode: null,
      });
    }
    return repository.createTrackingCodes(rows);
  }

  const config = (campaign.trackingConfig ?? {}) as VanityConfig;
  const code = await uniqueCode();
  return repository.createTrackingCodes([
    {
      campaignId,
      spotId: null,
      code,
      method: campaign.trackingMethod,
      destination: config.vanityUrl ? withUtm(config.vanityUrl, null, code) : null,
      vanityPath: config.vanityUrl ?? null,
      promoCode: config.promoCode ?? null,
    },
  ]);
}

/** Coarse device class. Enough to say "mostly phones", never enough to identify one. */
export function deviceClass(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const agent = userAgent.toLowerCase();
  if (/ipad|tablet/.test(agent)) return 'tablet';
  if (/mobile|android|iphone/.test(agent)) return 'mobile';
  if (/bot|crawler|spider|preview/.test(agent)) return 'bot';
  return 'desktop';
}

export type ScanContext = {
  userAgent: string | null;
  referer: string | null;
  city: string | null;
};

/** The hour of the day in IST (UTC+5:30), 0–23 — the breakdown the interactions panel draws. */
export function hourIst(at: Date): number {
  return new Date(at.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

export type InteractionType = 'VIEW' | 'CTA_CLICK' | 'FORM_SUBMIT';

/**
 * Lot D (Q7/Q139): an interaction on the landing page — the page was seen,
 * a call-to-action was pressed, a form went in. Public like the scan, and
 * counted the same way: bots are ignored, nothing identifying is kept, and
 * the row carries the IST hour and the CTA's label so the breakdown can be
 * drawn without a join. Every row is one ADX recorded itself: MEASURED.
 */
export async function recordInteraction(
  code: string,
  event: { type: InteractionType; ctaLabel?: string | null | undefined },
  context: ScanContext,
  now = new Date(),
): Promise<{ counted: boolean }> {
  const row = await repository.findTrackingCode(code);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unknown code');

  const device = deviceClass(context.userAgent);
  if (device === 'bot') return { counted: false };

  await repository.recordTrackingEvent({
    codeId: row.id,
    type: event.type,
    city: context.city,
    device,
    referer: context.referer,
    hourIst: hourIst(now),
    ctaLabel: event.type === 'CTA_CLICK' ? (event.ctaLabel ?? null) : null,
  });
  return { counted: true };
}

/**
 * Resolves a scanned code to where the visitor should go, and records it.
 *
 * Bots are followed but not counted. A link preview fetched by a messaging app
 * is not a person standing in front of a hoarding, and counting it would inflate
 * exactly the number an advertiser is paying attention to.
 *
 * Lot E (Q106): a code with no destination of its own goes to the campaign's
 * PUBLISHED landing page when there is one — `landingSlug` — with the code
 * appended so the page's beacon can attribute what happens next. The
 * redirect there is not a CLICK: the click was the advertiser's site, and
 * the page reports its own VIEW.
 */
export async function resolveScan(
  code: string,
  context: ScanContext
): Promise<{ destination: string | null; landingSlug: string | null; counted: boolean }> {
  const row = await repository.findTrackingCode(code);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unknown code');

  const device = deviceClass(context.userAgent);
  const counted = device !== 'bot';

  if (counted) {
    const hour = hourIst(new Date());
    await repository.recordTrackingEvent({
      codeId: row.id,
      type: 'SCAN',
      city: context.city,
      device,
      referer: context.referer,
      hourIst: hour,
    });
    await repository.bumpTrackingCounter(row.id, 'scans', 1);

    if (row.destination) {
      // The redirect is the click. Recorded separately so a code whose
      // destination is missing still counts the scan it undoubtedly got.
      await repository.recordTrackingEvent({
        codeId: row.id,
        type: 'CLICK',
        city: context.city,
        device,
        referer: context.referer,
        hourIst: hour,
      });
      await repository.bumpTrackingCounter(row.id, 'clicks', 1);
    }
  }

  const landing = row.destination ? null : await repository.findLandingPage(row.campaign.id);
  const landingSlug = landing?.status === 'PUBLISHED' ? landing.slug : null;

  return { destination: row.destination, landingSlug, counted };
}

/**
 * Promo-code redemptions, reported by the advertiser.
 *
 * Marked as reported rather than measured wherever it is shown: ADX is not in
 * the advertiser's till, and a number we did not observe should never sit on a
 * screen looking like one we did.
 */
export async function recordRedemptions(
  campaignId: string,
  count: number
): Promise<{ recorded: number }> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');

  const code = campaign.codes.find((row) => row.method === 'VANITY_OR_PROMO');
  if (!code) {
    throw new ApiError(409, 'CONFLICT', 'This campaign has no promo code to redeem against.');
  }
  if (count <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Report a redemption count above zero.');
  }

  for (let index = 0; index < Math.min(count, 500); index += 1) {
    await repository.recordTrackingEvent({
      codeId: code.id,
      type: 'REDEMPTION',
      city: null,
      device: null,
      referer: null,
    });
  }
  await repository.bumpTrackingCounter(code.id, 'redemptions', count);

  return { recorded: count };
}
