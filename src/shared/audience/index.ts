/**
 * The audience / footfall seam — G7 (Q109), Y-B.
 *
 * Y-B (the owner, 15 Sep 2026): "both GeoIQ and Azira at the same time,
 * for rich data on the audience in a particular geography." The enabled
 * SET is on `/settings/integrations` (`audience.providers`, empty until ops
 * choose; a legacy one-vendor `provider` still reads as a one-element set)
 * with a blend `policy` beside it. Callers ask `audienceCatchment(lat, lng,
 * period)` and never name a vendor: EVERY enabled vendor is asked, in
 * parallel, each failure isolated — a 429 or a 502 from one never loses the
 * other's answer, a vendor with no credentials is skipped — and the answers
 * are blended per field by the policy (`blend.ts`). Nothing configured is
 * the one 503 `INTEGRATION_NOT_CONFIGURED`, so a screen can say "no panel
 * backs this" instead of drawing a figure. The catchment radius is the
 * row's too (`catchmentRadiusM`, 500 m by default) so every spot is asked
 * about the same circle and two spots' figures are comparable.
 *
 * Nothing here is stored: the per-(listing, vendor, period) snapshot that
 * keeps a vendor call to one per month is `listings`' (AudienceSnapshot),
 * which stores each vendor's raw answer and blends on read.
 */
import { ApiError } from '../errors';
import { getEffectiveAudienceConfig } from '../integrations';
import { logger } from '../logging';
import { aziraAudienceProvider } from './azira';
import { blendAudience } from './blend';
import { geoiqAudienceProvider } from './geoiq';
import type {
  AudienceCatchment,
  AudienceProvider,
  AudienceProviderName,
  AudienceSetup,
  AudienceVendor,
  BlendedAudienceCatchment,
} from './types';

export * from './types';
export * from './blend';
export { geoiqAudienceProvider, geoiqTest, clampGeoiqRadius, unwrapGeoiqAnswer, GEOIQ_RADIUS_MIN_M, GEOIQ_RADIUS_MAX_M, GEOIQ_MAX_VARIABLES_PER_CALL, GEOIQ_SAMPLE_VARIABLE } from './geoiq';
export { aziraAudienceProvider, aziraTest } from './azira';
// AC-B2: the vendor test behind the integrations card.
export { AUDIENCE_TEST_POINT, testAudienceVendor } from './probe';

/** The NONE stub: nothing backs an audience figure, and it says so. */
export const noneAudienceProvider: AudienceProvider = {
  name: 'NONE',
  async catchment() {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No audience vendor is configured.');
  },
};

const PROVIDERS: Record<AudienceProviderName, AudienceProvider> = {
  NONE: noneAudienceProvider,
  GEOIQ: geoiqAudienceProvider,
  AZIRA: aziraAudienceProvider,
};

/** The adapter for one vendor, by name. */
export function audienceProviderFor(vendor: AudienceVendor): AudienceProvider {
  return PROVIDERS[vendor];
}

/** The enabled set, the blend policy and the circle — one read of the row. */
export async function getAudienceSetup(): Promise<AudienceSetup> {
  const cfg = await getEffectiveAudienceConfig();
  return { vendors: cfg.providers, policy: cfg.policy, radiusM: cfg.catchmentRadiusM };
}

/** Y-B: the vendors in force, in catalogue order. Empty when nothing backs a figure. */
export async function audienceVendorsInForce(): Promise<AudienceVendor[]> {
  return (await getEffectiveAudienceConfig()).providers;
}

/**
 * The one vendor name an old reader prints beside a PANEL figure: the
 * footfall primary when it is enabled, else the first enabled vendor; NONE
 * when there is none.
 */
export async function audienceVendorName(): Promise<AudienceProviderName> {
  return (await getEffectiveAudienceConfig()).provider;
}

/** The adapter `audienceVendorName` names, and the radius it asks about — kept for readers that predate Y-B. */
export async function getAudienceProvider(): Promise<{ provider: AudienceProvider; radiusM: number }> {
  const cfg = await getEffectiveAudienceConfig();
  return { provider: PROVIDERS[cfg.provider] ?? noneAudienceProvider, radiusM: cfg.catchmentRadiusM };
}

const isNotConfigured = (err: unknown): boolean => err instanceof ApiError && err.statusCode === 503 && err.code === 'INTEGRATION_NOT_CONFIGURED';

export type VendorAsk = {
  /** Each vendor's raw answer — absent when it was skipped, failed, or had nothing. */
  raw: Partial<Record<AudienceVendor, AudienceCatchment>>;
  /** Vendors that were asked and answered (a null answer counts: the call happened). */
  asked: AudienceVendor[];
  /** Vendors enabled but without credentials — skipped, not asked. */
  skipped: AudienceVendor[];
  /** Vendors whose call failed, with the error, so a caller can decide what is fatal. */
  failed: { vendor: AudienceVendor; error: unknown }[];
};

/**
 * Asks every vendor in `vendors` about the circle, in parallel, each
 * failure isolated. Never throws: the caller reads `raw`, `skipped` and
 * `failed` and decides. Used by the seam and by `listings`' snapshot read
 * (which asks only the vendors that lack a fresh row).
 */
export async function askVendors(vendors: readonly AudienceVendor[], lat: number, lng: number, radiusM: number, period: string): Promise<VendorAsk> {
  const out: VendorAsk = { raw: {}, asked: [], skipped: [], failed: [] };
  await Promise.all(
    vendors.map(async (vendor) => {
      try {
        const answer = await audienceProviderFor(vendor).catchment(lat, lng, radiusM, period);
        out.asked.push(vendor);
        if (answer) out.raw[vendor] = answer;
      } catch (err) {
        if (isNotConfigured(err)) {
          logger.warn('audience vendor enabled but not configured; skipped', { vendor });
          out.skipped.push(vendor);
        } else {
          logger.warn('audience vendor failed; the other vendors\' answers stand', { vendor, err: err instanceof Error ? err.message : String(err) });
          out.failed.push({ vendor, error: err });
        }
      }
    }),
  );
  return out;
}

/**
 * What to throw when an ask produced nothing: the first real failure (a
 * 429 or a 502 the caller may retry), else 503 when every enabled vendor
 * was unconfigured. Null when the vendors simply had nothing — the caller
 * answers null.
 */
export function askFailure(ask: VendorAsk, vendors: readonly AudienceVendor[]): unknown | null {
  if (ask.failed.length > 0) return ask.failed[0]!.error;
  if (vendors.length > 0 && ask.skipped.length === vendors.length) {
    return new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No enabled audience vendor is configured: every vendor in force lacks credentials.');
  }
  return null;
}

/**
 * The catchment around a point for a month, from every vendor in force,
 * blended by the policy. Null when the vendors have nothing for the
 * circle. 503 `INTEGRATION_NOT_CONFIGURED` when no vendor is enabled or
 * none has credentials; a vendor's own 429 / 502 only when no vendor
 * answered at all.
 */
export async function audienceCatchment(lat: number, lng: number, period: string): Promise<BlendedAudienceCatchment | null> {
  const { vendors, policy, radiusM } = await getAudienceSetup();
  if (vendors.length === 0) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No audience vendor is configured.');
  const ask = await askVendors(vendors, lat, lng, radiusM, period);
  const blended = blendAudience(ask.raw, policy);
  if (blended) return blended;
  const failure = askFailure(ask, vendors);
  if (failure) throw failure;
  return null;
}
