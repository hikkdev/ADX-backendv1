import { prisma } from '../database/prisma';
import { redis } from '../cache/redis';
import { env } from '../../config/env';
import type { SmsRailName, SmsRailTemplates } from '../sms/kinds';

/**
 * Lot E (Q128): the SMS section is a routing table, not one key. `authKey`
 * and `templateId` are MSG91's (the latter is the pre-DLT single template,
 * kept only so an old row still parses); `primaryRail` and `fallbackRails`
 * pick the adapters in `shared/sms/rails`; `dltEntityId` and `senderId` are
 * the TRAI registration every rail quotes; `templates` is each rail's own id
 * for each kind of message ADX sends. A kind with no registration on the rail
 * in use is skipped, never sent.
 */
export interface SmsConfig {
  authKey?: string;
  templateId?: string;
  primaryRail?: SmsRailName;
  fallbackRails?: SmsRailName[];
  dltEntityId?: string;
  senderId?: string;
  templates?: Partial<Record<SmsRailName, SmsRailTemplates>>;
}
/** Lot E (Q87): `primary` says which door outbound email leaves by — the SMTP settings here, or Resend. */
export type EmailPrimary = 'SMTP' | 'RESEND';
export const EMAIL_PRIMARIES: readonly EmailPrimary[] = ['SMTP', 'RESEND'];
/**
 * AE-B: `mode` is the SMTP door's switch between a real host and an
 * Ethereal test inbox. SMTP (the default) sends through `host`; ETHEREAL
 * creates a throwaway nodemailer test account once (cached in Redis for a
 * day) and sends through it — nothing is delivered, every message gets a
 * preview URL. It bears on the SMTP door only: under `primary: 'RESEND'`
 * the mode is not consulted.
 */
export type EmailMode = 'SMTP' | 'ETHEREAL';
export const EMAIL_MODES: readonly EmailMode[] = ['SMTP', 'ETHEREAL'];
export interface EmailConfig { host?: string; port?: number; user?: string; password?: string; from?: string; primary?: EmailPrimary; mode?: EmailMode }
export interface StorageConfig { accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucketName?: string; publicUrl?: string }
/**
 * Lot D (Q129): `kycProvider` is the Digio switch beside the keys. DIGIO is
 * the normal state; DEGRADED is what the probe (`shared/vendors/probe.ts`)
 * writes when Digio stops answering and clears when it answers again;
 * MANUAL is ops' explicit switch, which the probe never touches.
 */
export type KycProviderState = 'DIGIO' | 'DEGRADED' | 'MANUAL';
export const KYC_PROVIDER_STATES: readonly KycProviderState[] = ['DIGIO', 'DEGRADED', 'MANUAL'];
export interface KycConfig { clientId?: string; clientSecret?: string; baseUrl?: string; kycProvider?: KycProviderState }
export interface TwilioConfig { accountSid?: string; authToken?: string; phoneNumber?: string }
/** The pre-G7 row: one Google key. Kept so an old row parses; read as the server key's last fallback. */
export interface GoogleMapsConfig { apiKey?: string }
/**
 * G7 (Q101/132/137): the maps provider seam. One provider at a time — Google
 * or Mapbox — chosen on the screen. Two keys per vendor because they are
 * two different things: the browser/public key is what a phone or the
 * console draws tiles with (restricted by bundle id / referrer, published by
 * `GET /app/maps`), the server/secret key is what this backend spends on
 * geocoding and directions (restricted by IP, never leaves the server).
 */
export type MapsProvider = 'GOOGLE' | 'MAPBOX' | 'OSM';
export const MAPS_PROVIDERS: readonly MapsProvider[] = ['GOOGLE', 'MAPBOX', 'OSM'];
/**
 * Z-B (the owner, 15 Sep 2026): "In maps, let's integrate OpenStreetMap
 * besides Google and Mapbox." OSM has no key but has USAGE POLICIES, and
 * the section is shaped around them:
 *
 *   - the public Nominatim (nominatim.openstreetmap.org) allows ONE request
 *     a second, with a User-Agent naming the app and a contact email, and
 *     no bulk geocoding — so `contactEmail` is REQUIRED to select OSM, the
 *     adapter meters the public host through a Redis bucket, and
 *     `nominatimBaseUrl` can point at a self-hosted or commercial Nominatim
 *     (uncapped by us, capped by them);
 *   - the public OSRM demo router (router.project-osrm.org) is for testing
 *     only — production points `osrmBaseUrl` at a self-hosted OSRM or an
 *     OSRM-compatible host;
 *   - the public tile server (tile.openstreetmap.org) forbids heavy app use
 *     — production points `tileUrlTemplate` at MapTiler / Stadia /
 *     Thunderforest / Geoapify or a self-hosted stack (all OSM-based), with
 *     `tileApiKey` where the host wants one. `publicTiles` is the warning
 *     flag the read surfaces while the template still names the public
 *     server.
 *
 * `tileAttribution` is mandatory on every map ("(c) OpenStreetMap
 * contributors") and travels to the clients through `GET /app/maps`.
 */
export interface OsmConfig {
  nominatimBaseUrl?: string;
  osrmBaseUrl?: string;
  photonBaseUrl?: string;
  contactEmail?: string;
  userAgent?: string;
  tileUrlTemplate?: string;
  tileAttribution?: string;
  tileMaxZoom?: number;
  /** Masked on the read; appended as `?key=` or put in for `{key}` in the template. */
  tileApiKey?: string;
  /** Stored by the PUT when the template names the public tile server; the read derives it either way. */
  publicTiles?: boolean;
}
export interface MapsConfig {
  provider?: MapsProvider;
  googleBrowserKey?: string;
  googleServerKey?: string;
  mapboxPublicToken?: string;
  mapboxSecretToken?: string;
  osm?: OsmConfig;
}

export const OSM_DEFAULTS = {
  nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
  osrmBaseUrl: 'https://router.project-osrm.org',
  photonBaseUrl: 'https://photon.komoot.io',
  tileUrlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '(c) OpenStreetMap contributors',
  tileMaxZoom: 19,
} as const;
/** The public Nominatim host — the one the 1 request/second bucket meters. */
export const OSM_PUBLIC_NOMINATIM_HOST = 'nominatim.openstreetmap.org';
/** The public tile server — the one `publicTiles` warns about. */
export const OSM_PUBLIC_TILE_HOST = 'tile.openstreetmap.org';
const ADX_VERSION = process.env.npm_package_version ?? '1.0.0';

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.replace(/\{[^}]*\}/g, 'x')).hostname.toLowerCase();
  } catch {
    return null;
  }
}
/** Does this tile template still draw from the public OSM server (or one of its `a.`/`b.`/`c.` mirrors)? */
export function isPublicOsmTileTemplate(template: string | undefined): boolean {
  const host = hostOf(template ?? OSM_DEFAULTS.tileUrlTemplate);
  return host === OSM_PUBLIC_TILE_HOST || host?.endsWith(`.${OSM_PUBLIC_TILE_HOST}`) === true;
}
/** Is this Nominatim base the public one whose policy caps us at 1 request/second? */
export function isPublicNominatim(baseUrl: string | undefined): boolean {
  return hostOf(baseUrl ?? OSM_DEFAULTS.nominatimBaseUrl) === OSM_PUBLIC_NOMINATIM_HOST;
}

export type ResolvedOsmConfig = Required<Omit<OsmConfig, 'contactEmail' | 'tileApiKey' | 'userAgent'>> & {
  contactEmail: string | undefined;
  tileApiKey: string | undefined;
  userAgent: string;
};
/** The OSM section in force: the stored subset laid over the defaults; the User-Agent the policy asks for; `publicTiles` derived from the template. */
export function resolveOsmConfig(stored?: OsmConfig | null): ResolvedOsmConfig {
  const strip = (url: string | undefined, fallback: string): string => (url?.trim() || fallback).replace(/\/+$/, '');
  const contactEmail = stored?.contactEmail?.trim() || undefined;
  const tileUrlTemplate = stored?.tileUrlTemplate?.trim() || OSM_DEFAULTS.tileUrlTemplate;
  return {
    nominatimBaseUrl: strip(stored?.nominatimBaseUrl, OSM_DEFAULTS.nominatimBaseUrl),
    osrmBaseUrl: strip(stored?.osrmBaseUrl, OSM_DEFAULTS.osrmBaseUrl),
    photonBaseUrl: strip(stored?.photonBaseUrl, OSM_DEFAULTS.photonBaseUrl),
    contactEmail,
    userAgent: stored?.userAgent?.trim() || `ADX/${ADX_VERSION} (${contactEmail ?? 'no contact email set'})`,
    tileUrlTemplate,
    tileAttribution: stored?.tileAttribution?.trim() || OSM_DEFAULTS.tileAttribution,
    tileMaxZoom: stored?.tileMaxZoom ?? OSM_DEFAULTS.tileMaxZoom,
    tileApiKey: stored?.tileApiKey?.trim() || undefined,
    publicTiles: isPublicOsmTileTemplate(tileUrlTemplate),
  };
}
/**
 * G7 (Q109): the audience / footfall vendor seam. NONE is the default and
 * means "nothing backs an audience figure" — the analytics say so rather
 * than draw one. `catchmentRadiusM` is what the vendor is asked for around
 * a spot; `geoiqVariables` maps the catchment's fields to the GeoIQ
 * catalogue ids the account was sold (they are per-account, picked at
 * catalog.geoiq.io — a field with no id is null, never guessed).
 */
export type AudienceProvider = 'NONE' | 'GEOIQ' | 'AZIRA';
export const AUDIENCE_PROVIDERS: readonly AudienceProvider[] = ['NONE', 'GEOIQ', 'AZIRA'];
/**
 * Y-B (the owner, 15 Sep 2026): both vendors at once. `providers` is the
 * enabled SET — empty means nothing backs an audience figure; the legacy
 * one-of-three `provider` is still read as a one-element set so a stored
 * row keeps working. `policy` says, per field group, which vendor's answer
 * is printed (`primary`), whether the other fills a null (`fallback`) and,
 * for footfall, whether two answers are averaged (`blend`). The defaults
 * put Azira — a mobility panel — first on footfall and average the two
 * when both answer; GeoIQ — a data panel — first on demographics and
 * affinities, each with the fallback on.
 */
export type AudienceVendorName = 'GEOIQ' | 'AZIRA';
export const AUDIENCE_VENDORS: readonly AudienceVendorName[] = ['GEOIQ', 'AZIRA'];
export type AudienceFootfallBlend = 'PRIMARY' | 'AVERAGE';
export const AUDIENCE_FOOTFALL_BLENDS: readonly AudienceFootfallBlend[] = ['PRIMARY', 'AVERAGE'];
export interface AudiencePolicy {
  footfall: { primary: AudienceVendorName; fallback: boolean; blend: AudienceFootfallBlend };
  demographics: { primary: AudienceVendorName; fallback: boolean };
  affinities: { primary: AudienceVendorName; fallback: boolean };
}
/** What a stored row or a PUT may carry: any subset, filled from the defaults. */
export type AudiencePolicyPatch = {
  footfall?: Partial<AudiencePolicy['footfall']>;
  demographics?: Partial<AudiencePolicy['demographics']>;
  affinities?: Partial<AudiencePolicy['affinities']>;
};
export const DEFAULT_AUDIENCE_POLICY: AudiencePolicy = {
  footfall: { primary: 'AZIRA', fallback: true, blend: 'AVERAGE' },
  demographics: { primary: 'GEOIQ', fallback: true },
  affinities: { primary: 'GEOIQ', fallback: true },
};
/** The full policy: the stored (or patched) subset laid over the defaults. */
export function resolveAudiencePolicy(stored?: AudiencePolicyPatch | null): AudiencePolicy {
  return {
    footfall: { ...DEFAULT_AUDIENCE_POLICY.footfall, ...(stored?.footfall ?? {}) },
    demographics: { ...DEFAULT_AUDIENCE_POLICY.demographics, ...(stored?.demographics ?? {}) },
    affinities: { ...DEFAULT_AUDIENCE_POLICY.affinities, ...(stored?.affinities ?? {}) },
  };
}
/** The enabled set: `providers` when the row has it, else the legacy `provider` as a one-element set (NONE = empty). Deduplicated, in catalogue order. */
export function resolveAudienceProviders(audience?: Pick<AudienceConfig, 'provider' | 'providers'> | null): AudienceVendorName[] {
  const set = audience?.providers ?? (audience?.provider && audience.provider !== 'NONE' ? [audience.provider] : []);
  return AUDIENCE_VENDORS.filter((vendor) => set.includes(vendor));
}
/** The one name old readers print: the footfall primary when it is enabled, else the first enabled vendor, else NONE. */
export function legacyAudienceProvider(providers: readonly AudienceVendorName[], policy: AudiencePolicy): AudienceProvider {
  if (providers.length === 0) return 'NONE';
  return providers.includes(policy.footfall.primary) ? policy.footfall.primary : providers[0]!;
}
export interface AudienceConfig {
  /** Legacy (pre Y-B): one vendor. Read as a one-element set when `providers` is absent; never written any more. */
  provider?: AudienceProvider;
  providers?: AudienceVendorName[];
  policy?: AudiencePolicyPatch;
  geoiqApiKey?: string;
  geoiqBaseUrl?: string;
  geoiqVariables?: Record<string, string>;
  aziraApiKey?: string;
  aziraClientId?: string;
  aziraBaseUrl?: string;
  catchmentRadiusM?: number;
}
/**
 * Lot C (Q110): the three payment gateways. Razorpay is live first; Cashfree
 * and CCAvenue are adapters that target the sandbox host while `testMode` is
 * on, which is how they ship before their credentials arrive. Every adapter
 * answers "not configured" cleanly when its keys are missing.
 */
export interface RazorpayConfig { keyId?: string; keySecret?: string; webhookSecret?: string; testMode?: boolean }
export interface CashfreeConfig { appId?: string; secretKey?: string; webhookSecret?: string; testMode?: boolean }
export interface CcavenueConfig { merchantId?: string; accessCode?: string; workingKey?: string; testMode?: boolean }
export interface StripeConfig { publishableKey?: string; secretKey?: string; webhookSecret?: string }
export interface ResendConfig { apiKey?: string; fromEmail?: string }
export interface BrandingConfig { platformName?: string; headerLogoUrl?: string; authLogoUrl?: string }

/**
 * Which model writes listing descriptions and translates the marketplace.
 *
 * One section rather than one per vendor, because the platform uses one
 * provider at a time and switching is meant to be a form change rather than a
 * deployment. `custom` covers anything speaking the OpenAI chat-completions
 * shape, which is what self-hosted and most smaller vendors offer — that is the
 * "room for our own" slot, and it needs no code to use.
 *
 * Quotas live here too. They are commercial dials, not constants: the free and
 * paid regeneration allowances are the kind of number that gets tuned after
 * launch, and nobody should need a deploy to tune them.
 */
export interface AiConfig {
  provider?: AiProviderKind;
  apiKey?: string;
  model?: string;
  /** Required by `custom` and `azure-openai`; ignored by the rest. */
  baseUrl?: string;
  /** Off unless explicitly turned on, even with a key present. */
  enabled?: boolean;
  /** Regenerations allowed on one description without a subscription. */
  freeQuota?: number;
  /** Regenerations allowed on one description with an active subscription. */
  paidQuota?: number;
  /** Translate listing text into the reader's language on the way out. */
  translateOnRead?: boolean;
}

export type AiProviderKind = 'anthropic' | 'openai' | 'google' | 'azure-openai' | 'custom';

/**
 * Lot E (Q98): the HR tool ADX links to. A portal link only — no sync job
 * until the chosen tier has an API — so `apiBaseUrl` and `apiKey` are held
 * for that day and read by nothing today. `employeeLinkTemplate` is the
 * deep link `employees` builds `hrmsLink` from, `{externalId}` standing for
 * `Employee.externalHrmsId`.
 */
export type HrmsProvider = 'NONE' | 'ZOHO_PEOPLE' | 'KEKA' | 'GREYTHR';
export const HRMS_PROVIDERS: readonly HrmsProvider[] = ['NONE', 'ZOHO_PEOPLE', 'KEKA', 'GREYTHR'];
export interface HrmsConfig {
  provider?: HrmsProvider;
  portalUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  employeeLinkTemplate?: string;
}

/**
 * E10-1: the work tool ADX links to — a portal link beside the HR tool's,
 * nothing more. No credentials: there is no sync and nothing to mask.
 */
export type WorkToolProvider = 'NONE' | 'JIRA' | 'TRELLO' | 'ASANA' | 'OTHER';
export const WORK_TOOL_PROVIDERS: readonly WorkToolProvider[] = ['NONE', 'JIRA', 'TRELLO', 'ASANA', 'OTHER'];
export interface WorkToolConfig {
  provider?: WorkToolProvider;
  portalUrl?: string;
  /** What the console calls it — "ADX Jira", "Ops board". */
  name?: string;
}

export interface IntegrationsConfig {
  sms?: SmsConfig;
  email?: EmailConfig;
  storage?: StorageConfig;
  kyc?: KycConfig;
  twilio?: TwilioConfig;
  resend?: ResendConfig;
  googleMaps?: GoogleMapsConfig;
  razorpay?: RazorpayConfig;
  cashfree?: CashfreeConfig;
  ccavenue?: CcavenueConfig;
  stripe?: StripeConfig;
  branding?: BrandingConfig;
  ai?: AiConfig;
  hrms?: HrmsConfig;
  workTool?: WorkToolConfig;
  maps?: MapsConfig;
  audience?: AudienceConfig;
}

const CONFIG_KEY = 'integrations';
const CACHE_KEY = 'config:integrations';
// Safety net in case a write's cache update is ever missed — not the primary
// invalidation path (every write overwrites the cache directly below).
const CACHE_TTL_SECONDS = 300;

// Cached in Redis rather than a module-level variable, so reads never need a
// DB round-trip on the hot path (sending an SMS/email, uploading a file) and
// a write on one instance is immediately visible to every other instance.
async function loadConfig(): Promise<IntegrationsConfig> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as IntegrationsConfig;

  const row = await prisma.appConfig.findUnique({ where: { key: CONFIG_KEY } });
  const value = (row?.value as IntegrationsConfig | undefined) ?? {};
  await redis.set(CACHE_KEY, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
  return value;
}

export async function getIntegrationsConfig(): Promise<IntegrationsConfig> {
  return loadConfig();
}

// Merges `patch` into the stored section. `undefined`/empty-string fields are
// skipped, so a blank form field means "keep existing value" rather than
// "clear it" — credentials are never round-tripped back to the client, so
// the form can't submit the real value back anyway. An explicit `null`,
// however, deliberately clears the field — used by branding's "remove logo"
// action, which (unlike secrets) needs a way to unset a previously-saved value.
export async function updateIntegrationsConfig(
  section: keyof IntegrationsConfig,
  patch: Record<string, unknown>,
): Promise<IntegrationsConfig> {
  const current = await loadConfig();
  const merged: Record<string, unknown> = { ...(current[section] as object ?? {}) };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined && value !== '') {
      merged[key] = value;
    }
  }

  const next: IntegrationsConfig = { ...current, [section]: merged };

  await prisma.appConfig.upsert({
    where: { key: CONFIG_KEY },
    update: { value: next as any },
    create: { key: CONFIG_KEY, value: next as any },
  });

  await redis.set(CACHE_KEY, JSON.stringify(next), 'EX', CACHE_TTL_SECONDS);
  return next;
}

// ─── Effective config getters — DB value wins, per field, over .env ──────────

export async function getEffectiveSmsConfig(): Promise<SmsConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    authKey: cfg.sms?.authKey || env.MSG91_AUTH_KEY,
    templateId: cfg.sms?.templateId || env.MSG91_TEMPLATE_ID,
    // Lot E (Q128): MSG91 stays the default so a row written before the
    // routing table existed keeps sending the way it did.
    primaryRail: cfg.sms?.primaryRail ?? 'msg91',
    fallbackRails: cfg.sms?.fallbackRails ?? [],
    dltEntityId: cfg.sms?.dltEntityId,
    senderId: cfg.sms?.senderId,
    templates: cfg.sms?.templates ?? {},
  };
}

export async function getEffectiveEmailConfig(): Promise<EmailConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    host: cfg.email?.host || env.SMTP_HOST,
    port: cfg.email?.port || env.SMTP_PORT,
    user: cfg.email?.user || env.SMTP_USER,
    password: cfg.email?.password || env.SMTP_PASSWORD,
    from: cfg.email?.from || env.SMTP_FROM,
    // Lot E (Q87): SMTP unless ops chose Resend — or unless only a Resend key
    // is on file, in which case that is plainly the door they meant.
    primary: cfg.email?.primary ?? (!(cfg.email?.host || env.SMTP_HOST) && (cfg.resend?.apiKey || env.RESEND_API_KEY) ? 'RESEND' : 'SMTP'),
    mode: effectiveEmailMode(cfg),
  };
}

/** AE-B: the SMTP door's mode in force — the row, then `EMAIL_MODE`, then SMTP. Pure, so the masked read draws the same answer. */
export function effectiveEmailMode(cfg: IntegrationsConfig): EmailMode {
  return cfg.email?.mode ?? env.EMAIL_MODE ?? 'SMTP';
}

export async function getEffectiveStorageConfig(): Promise<StorageConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    accountId: cfg.storage?.accountId || env.R2_ACCOUNT_ID,
    accessKeyId: cfg.storage?.accessKeyId || env.R2_ACCESS_KEY_ID,
    secretAccessKey: cfg.storage?.secretAccessKey || env.R2_SECRET_ACCESS_KEY,
    bucketName: cfg.storage?.bucketName || env.R2_BUCKET_NAME,
    publicUrl: cfg.storage?.publicUrl || env.R2_PUBLIC_URL,
  };
}

export async function getEffectiveKycConfig(): Promise<KycConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    clientId: cfg.kyc?.clientId || env.DIGIO_CLIENT_ID,
    clientSecret: cfg.kyc?.clientSecret || env.DIGIO_CLIENT_SECRET,
    baseUrl: cfg.kyc?.baseUrl || env.DIGIO_BASE_URL,
    kycProvider: cfg.kyc?.kycProvider ?? 'DIGIO',
  };
}

// Not yet consumed anywhere — no feature in this codebase sends SMS/WhatsApp
// via Twilio, calls Google Maps, or takes payments via Razorpay yet. These
// getters exist so the future agent/publisher/advertiser apps (or features
// added to this backend later) have a ready-made, DB-overridable config
// source to call into, matching the pattern used by the SMS/Email/Storage/KYC
// integrations above.

export async function getEffectiveTwilioConfig(): Promise<TwilioConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    accountSid: cfg.twilio?.accountSid || env.TWILIO_ACCOUNT_SID,
    authToken: cfg.twilio?.authToken || env.TWILIO_AUTH_TOKEN,
    phoneNumber: cfg.twilio?.phoneNumber || env.TWILIO_PHONE_NUMBER,
  };
}

export async function getEffectiveResendConfig(): Promise<ResendConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    apiKey: cfg.resend?.apiKey || env.RESEND_API_KEY,
    fromEmail: cfg.resend?.fromEmail || env.RESEND_FROM_EMAIL,
  };
}

/**
 * G7: the maps seam in force. Google unless ops chose Mapbox. The Google
 * server key falls back through the pre-G7 `googleMaps.apiKey` row and then
 * `GOOGLE_MAPS_API_KEY`, so a deployment that never opened the new section
 * keeps geocoding the way it did.
 */
export async function getEffectiveMapsConfig(): Promise<Required<Pick<MapsConfig, 'provider'>> & Omit<MapsConfig, 'osm'> & { osm: ResolvedOsmConfig }> {
  const cfg = await getIntegrationsConfig();
  const maps = cfg.maps ?? {};
  return {
    provider: maps.provider ?? 'GOOGLE',
    googleBrowserKey: maps.googleBrowserKey || env.GOOGLE_MAPS_BROWSER_KEY,
    googleServerKey: maps.googleServerKey || cfg.googleMaps?.apiKey || env.GOOGLE_MAPS_API_KEY,
    mapboxPublicToken: maps.mapboxPublicToken || env.MAPBOX_PUBLIC_TOKEN,
    mapboxSecretToken: maps.mapboxSecretToken || env.MAPBOX_SECRET_TOKEN,
    // Z-B: OSM has no key to fall back to the environment for — the section is
    // the defaults plus whatever the screen stored.
    osm: resolveOsmConfig(maps.osm),
  };
}

/** The Google SERVER key — kept for the callers that predate the seam; the same value `getEffectiveMapsConfig().googleServerKey` answers. */
export async function getEffectiveGoogleMapsConfig(): Promise<GoogleMapsConfig> {
  const maps = await getEffectiveMapsConfig();
  return { apiKey: maps.googleServerKey };
}

export const DEFAULT_AUDIENCE_CATCHMENT_RADIUS_M = 500;
/**
 * AC-B2 (the live probe of 16 Sep 2026): GeoIQ's Data Serving API is
 * served per region — `dataserving-in.geoiq.io` for India (docs.geoiq.io),
 * `dataserving-us.geoiq.io` for the US. The bare `dataserving.geoiq.io` of
 * the first cut does not resolve. India is the default; `geoiqBaseUrl` on
 * the row (or `GEOIQ_BASE_URL`) points elsewhere.
 */
export const GEOIQ_DEFAULT_BASE_URL = 'https://dataserving-in.geoiq.io/production/v1.0';

/**
 * G7 (Q109) / Y-B: the audience vendors in force. `providers` is the enabled
 * set (empty until ops choose), `policy` the full blend policy, `provider`
 * the one name old readers print (`legacyAudienceProvider`); keys fall back
 * to the environment.
 */
export async function getEffectiveAudienceConfig(): Promise<
  Required<Pick<AudienceConfig, 'provider' | 'providers' | 'catchmentRadiusM' | 'geoiqVariables'>> & { policy: AudiencePolicy } & AudienceConfig
> {
  const cfg = await getIntegrationsConfig();
  const audience = cfg.audience ?? {};
  const providers = resolveAudienceProviders(audience);
  const policy = resolveAudiencePolicy(audience.policy);
  return {
    provider: legacyAudienceProvider(providers, policy),
    providers,
    policy,
    geoiqApiKey: audience.geoiqApiKey || env.GEOIQ_API_KEY,
    geoiqBaseUrl: (audience.geoiqBaseUrl || env.GEOIQ_BASE_URL || GEOIQ_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    geoiqVariables: audience.geoiqVariables ?? {},
    aziraApiKey: audience.aziraApiKey || env.AZIRA_API_KEY,
    aziraClientId: audience.aziraClientId || env.AZIRA_CLIENT_ID,
    aziraBaseUrl: (audience.aziraBaseUrl || env.AZIRA_BASE_URL || '').replace(/\/+$/, '') || undefined,
    catchmentRadiusM: audience.catchmentRadiusM ?? DEFAULT_AUDIENCE_CATCHMENT_RADIUS_M,
  };
}

export async function getEffectiveRazorpayConfig(): Promise<RazorpayConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    keyId: cfg.razorpay?.keyId || env.RAZORPAY_KEY_ID,
    keySecret: cfg.razorpay?.keySecret || env.RAZORPAY_KEY_SECRET,
    webhookSecret: cfg.razorpay?.webhookSecret || env.RAZORPAY_WEBHOOK_SECRET,
    testMode: cfg.razorpay?.testMode ?? env.RAZORPAY_TEST_MODE,
  };
}

// Lot C (Q110): the two adapters beside Razorpay. `testMode` defaults on —
// an adapter with no credentials yet should never point at a live host.
export async function getEffectiveCashfreeConfig(): Promise<CashfreeConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    appId: cfg.cashfree?.appId || env.CASHFREE_APP_ID,
    secretKey: cfg.cashfree?.secretKey || env.CASHFREE_SECRET_KEY,
    webhookSecret: cfg.cashfree?.webhookSecret || env.CASHFREE_WEBHOOK_SECRET,
    testMode: cfg.cashfree?.testMode ?? env.CASHFREE_TEST_MODE,
  };
}

export async function getEffectiveCcavenueConfig(): Promise<CcavenueConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    merchantId: cfg.ccavenue?.merchantId || env.CCAVENUE_MERCHANT_ID,
    accessCode: cfg.ccavenue?.accessCode || env.CCAVENUE_ACCESS_CODE,
    workingKey: cfg.ccavenue?.workingKey || env.CCAVENUE_WORKING_KEY,
    testMode: cfg.ccavenue?.testMode ?? env.CCAVENUE_TEST_MODE,
  };
}

/**
 * The AI settings in force.
 *
 * The two quotas answer the same question the subscription does — what this
 * publisher is entitled to — so they are resolved here rather than read
 * separately by the service, and they have defaults because a deployment that
 * has never opened the settings screen should still behave.
 */
export async function getEffectiveAiConfig(): Promise<Required<Pick<AiConfig, 'freeQuota' | 'paidQuota' | 'enabled' | 'translateOnRead'>> & AiConfig> {
  const cfg = await getIntegrationsConfig();
  const ai = cfg.ai ?? {};
  return {
    ...ai,
    provider: (ai.provider || (env.AI_PROVIDER as AiProviderKind | undefined)) ?? 'anthropic',
    apiKey: ai.apiKey || env.AI_API_KEY,
    model: ai.model || env.AI_MODEL,
    baseUrl: ai.baseUrl || env.AI_BASE_URL,
    // Explicitly false rather than falsy: an operator who has turned this off
    // has said something, and an absent key saying the same thing by accident
    // must not be mistaken for it.
    enabled: ai.enabled ?? false,
    freeQuota: ai.freeQuota ?? 3,
    paidQuota: ai.paidQuota ?? 10,
    translateOnRead: ai.translateOnRead ?? false,
  };
}

/**
 * Lot E (Q98): the HR tool. Zoho People is the default provider; nothing
 * falls back to `.env` because the link is configured on the screen, not
 * deployed. `employeeLinkTemplate` defaults to Zoho's employee page when the
 * provider is Zoho and a portal URL is set.
 */
export async function getEffectiveHrmsConfig(): Promise<HrmsConfig> {
  const cfg = await getIntegrationsConfig();
  const hrms = cfg.hrms ?? {};
  const provider = hrms.provider ?? 'ZOHO_PEOPLE';
  const portalUrl = hrms.portalUrl?.replace(/\/+$/, '');
  const defaultTemplate =
    provider === 'ZOHO_PEOPLE' && portalUrl ? `${portalUrl}/employees/{externalId}` : undefined;
  return {
    provider,
    portalUrl,
    apiBaseUrl: hrms.apiBaseUrl,
    apiKey: hrms.apiKey,
    employeeLinkTemplate: hrms.employeeLinkTemplate || defaultTemplate,
  };
}

export async function getEffectiveStripeConfig(): Promise<StripeConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    publishableKey: cfg.stripe?.publishableKey || env.STRIPE_PUBLISHABLE_KEY,
    secretKey: cfg.stripe?.secretKey || env.STRIPE_SECRET_KEY,
    webhookSecret: cfg.stripe?.webhookSecret || env.STRIPE_WEBHOOK_SECRET,
  };
}
