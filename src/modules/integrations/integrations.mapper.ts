import { env } from '../../config/env';
import {
  DEFAULT_AUDIENCE_CATCHMENT_RADIUS_M,
  GEOIQ_DEFAULT_BASE_URL,
  effectiveEmailMode,
  legacyAudienceProvider,
  resolveAudiencePolicy,
  resolveAudienceProviders,
  resolveOsmConfig,
  type IntegrationsConfig,
} from '../../shared/integrations';
import { readServiceAccount } from '../../shared/push';
import { ETHEREAL_WEB_URL } from '../../shared/email';

/**
 * AE-B: what the controller reads beside the row — the Ethereal inbox's
 * login when the mode is ETHEREAL (from Redis, never created by a read).
 * The login name is a throwaway, not a secret; the password is not a field
 * of this type and never reaches the mapper.
 */
export interface IntegrationsReadExtras {
  ethereal?: { user: string | null } | undefined;
}

/**
 * Builds the GET /integrations response.
 *
 * Every secret is masked here and nowhere else, so there is exactly one place
 * to audit that a raw credential never leaves the server. Values fall back
 * from the stored override to the matching .env setting.
 */
function maskSecret(value?: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):([^@]+)@/, '://$1:••••@');
}

/**
 * G11-2: is push configured? The same read the FCM sender makes before
 * every send (`FIREBASE_SERVICE_ACCOUNT_JSON`, raw or base64). Only the
 * verdict leaves: a Firebase service account is a key pair, and neither
 * it nor a masked tail of it is a field of this response.
 */
function pushConfiguration(): { configured: boolean; reason?: 'FCM_NOT_CONFIGURED' | 'FCM_MISCONFIGURED' } {
  const read = readServiceAccount();
  return read.account ? { configured: true } : { configured: false, reason: read.reason ?? 'FCM_NOT_CONFIGURED' };
}

function osmView(cfg: IntegrationsConfig) {
  const osm = resolveOsmConfig(cfg.maps?.osm);
  return {
    nominatimBaseUrl: osm.nominatimBaseUrl,
    osrmBaseUrl: osm.osrmBaseUrl,
    photonBaseUrl: osm.photonBaseUrl,
    contactEmail: osm.contactEmail ?? null,
    userAgent: osm.userAgent,
    tileUrlTemplate: osm.tileUrlTemplate,
    tileAttribution: osm.tileAttribution,
    tileMaxZoom: osm.tileMaxZoom,
    tileApiKey: maskSecret(osm.tileApiKey),
    publicTiles: osm.publicTiles,
  };
}

// GET /integrations — current effective config (DB override, falling back to
// .env). Secrets are always masked; the raw value never leaves the server.
export function toIntegrationsResponse(cfg: IntegrationsConfig, extras: IntegrationsReadExtras = {}) {
  const emailMode = effectiveEmailMode(cfg);
  return {
      sms: {
        authKey: maskSecret(cfg.sms?.authKey ?? env.MSG91_AUTH_KEY),
        templateId: cfg.sms?.templateId ?? env.MSG91_TEMPLATE_ID ?? null,
        // Lot E (Q128): the routing table is not secret — the rail names, the
        // DLT ids and the per-kind template ids are what the screen edits.
        primaryRail: cfg.sms?.primaryRail ?? 'msg91',
        fallbackRails: cfg.sms?.fallbackRails ?? [],
        dltEntityId: cfg.sms?.dltEntityId ?? null,
        senderId: cfg.sms?.senderId ?? null,
        templates: cfg.sms?.templates ?? {},
      },
      email: {
        host: cfg.email?.host ?? env.SMTP_HOST ?? null,
        port: cfg.email?.port ?? env.SMTP_PORT ?? null,
        user: cfg.email?.user ?? env.SMTP_USER ?? null,
        password: maskSecret(cfg.email?.password ?? env.SMTP_PASSWORD),
        from: cfg.email?.from ?? env.SMTP_FROM,
        // Lot E (Q87): SMTP unless ops chose Resend — null means the resolver's own default.
        primary: cfg.email?.primary ?? null,
        // AE-B: the SMTP door's mode in force (row, then EMAIL_MODE, then
        // SMTP) and, under ETHEREAL only, where the test inbox is — its
        // login name and the web URL; the throwaway password never leaves.
        mode: emailMode,
        ...(emailMode === 'ETHEREAL' ? { ethereal: { user: extras.ethereal?.user ?? null, webUrl: ETHEREAL_WEB_URL } } : {}),
      },
      storage: {
        accountId: cfg.storage?.accountId ?? env.R2_ACCOUNT_ID ?? null,
        accessKeyId: maskSecret(cfg.storage?.accessKeyId ?? env.R2_ACCESS_KEY_ID),
        secretAccessKey: maskSecret(cfg.storage?.secretAccessKey ?? env.R2_SECRET_ACCESS_KEY),
        bucketName: cfg.storage?.bucketName ?? env.R2_BUCKET_NAME ?? null,
        publicUrl: cfg.storage?.publicUrl ?? env.R2_PUBLIC_URL ?? null,
      },
      kyc: {
        clientId: maskSecret(cfg.kyc?.clientId ?? env.DIGIO_CLIENT_ID),
        clientSecret: maskSecret(cfg.kyc?.clientSecret ?? env.DIGIO_CLIENT_SECRET),
        baseUrl: cfg.kyc?.baseUrl ?? env.DIGIO_BASE_URL,
        // Lot D (Q129): not a secret — the switch the KYC screen draws.
        kycProvider: cfg.kyc?.kycProvider ?? 'DIGIO',
      },
      twilio: {
        accountSid: cfg.twilio?.accountSid ?? env.TWILIO_ACCOUNT_SID ?? null,
        authToken: maskSecret(cfg.twilio?.authToken ?? env.TWILIO_AUTH_TOKEN),
        phoneNumber: cfg.twilio?.phoneNumber ?? env.TWILIO_PHONE_NUMBER ?? null,
      },
      resend: {
        apiKey: maskSecret(cfg.resend?.apiKey ?? env.RESEND_API_KEY),
        fromEmail: cfg.resend?.fromEmail ?? env.RESEND_FROM_EMAIL ?? null,
      },
      googleMaps: {
        apiKey: maskSecret(cfg.googleMaps?.apiKey ?? env.GOOGLE_MAPS_API_KEY),
      },
      razorpay: {
        keyId: cfg.razorpay?.keyId ?? env.RAZORPAY_KEY_ID ?? null,
        keySecret: maskSecret(cfg.razorpay?.keySecret ?? env.RAZORPAY_KEY_SECRET),
        webhookSecret: maskSecret(cfg.razorpay?.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET),
        // Lot C (Q110): not a secret — the mode switch the payments screen draws.
        testMode: cfg.razorpay?.testMode ?? env.RAZORPAY_TEST_MODE,
      },
      cashfree: {
        appId: cfg.cashfree?.appId ?? env.CASHFREE_APP_ID ?? null,
        secretKey: maskSecret(cfg.cashfree?.secretKey ?? env.CASHFREE_SECRET_KEY),
        webhookSecret: maskSecret(cfg.cashfree?.webhookSecret ?? env.CASHFREE_WEBHOOK_SECRET),
        testMode: cfg.cashfree?.testMode ?? env.CASHFREE_TEST_MODE,
      },
      ccavenue: {
        merchantId: cfg.ccavenue?.merchantId ?? env.CCAVENUE_MERCHANT_ID ?? null,
        accessCode: maskSecret(cfg.ccavenue?.accessCode ?? env.CCAVENUE_ACCESS_CODE),
        workingKey: maskSecret(cfg.ccavenue?.workingKey ?? env.CCAVENUE_WORKING_KEY),
        testMode: cfg.ccavenue?.testMode ?? env.CCAVENUE_TEST_MODE,
      },
      stripe: {
        publishableKey: cfg.stripe?.publishableKey ?? env.STRIPE_PUBLISHABLE_KEY ?? null,
        secretKey: maskSecret(cfg.stripe?.secretKey ?? env.STRIPE_SECRET_KEY),
        webhookSecret: maskSecret(cfg.stripe?.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET),
      },
      // Not secrets — shown as-is (no masking), unlike the sections above.
      branding: {
        platformName: cfg.branding?.platformName ?? null,
        headerLogoUrl: cfg.branding?.headerLogoUrl ?? null,
        authLogoUrl: cfg.branding?.authLogoUrl ?? null,
      },
      ai: {
        provider: cfg.ai?.provider ?? env.AI_PROVIDER ?? 'anthropic',
        apiKey: maskSecret(cfg.ai?.apiKey ?? env.AI_API_KEY),
        model: cfg.ai?.model ?? env.AI_MODEL ?? null,
        baseUrl: cfg.ai?.baseUrl ?? env.AI_BASE_URL ?? null,
        enabled: cfg.ai?.enabled ?? false,
        // The defaults here and in `getEffectiveAiConfig` are the same numbers
        // deliberately: the screen must show what the server would actually do
        // when nobody has saved anything yet.
        freeQuota: cfg.ai?.freeQuota ?? 3,
        paidQuota: cfg.ai?.paidQuota ?? 10,
        translateOnRead: cfg.ai?.translateOnRead ?? false,
      },
      // Lot E (Q98): the HR tool. A portal link and a deep-link template are
      // not secrets; the API key, held for the day the tier has an API, is.
      hrms: {
        provider: cfg.hrms?.provider ?? 'ZOHO_PEOPLE',
        portalUrl: cfg.hrms?.portalUrl ?? null,
        apiBaseUrl: cfg.hrms?.apiBaseUrl ?? null,
        apiKey: maskSecret(cfg.hrms?.apiKey),
        employeeLinkTemplate: cfg.hrms?.employeeLinkTemplate ?? null,
      },
      // E10-1: the work tool — a link the console follows. Not a secret;
      // drawn as-is, the way branding and the HR portal link are.
      workTool: {
        provider: cfg.workTool?.provider ?? 'NONE',
        portalUrl: cfg.workTool?.portalUrl ?? null,
        name: cfg.workTool?.name ?? null,
      },
      // G7 (Q101/132/137): the maps seam. The provider is the switch the
      // screen draws; all four keys are masked — the browser key is public
      // on a phone but is still a credential on a settings screen. The
      // server key falls back through the pre-G7 `googleMaps.apiKey` row
      // the way `getEffectiveMapsConfig` does, so the screen shows what the
      // server would actually spend.
      maps: {
        provider: cfg.maps?.provider ?? 'GOOGLE',
        googleBrowserKey: maskSecret(cfg.maps?.googleBrowserKey ?? env.GOOGLE_MAPS_BROWSER_KEY),
        googleServerKey: maskSecret(cfg.maps?.googleServerKey ?? cfg.googleMaps?.apiKey ?? env.GOOGLE_MAPS_API_KEY),
        mapboxPublicToken: maskSecret(cfg.maps?.mapboxPublicToken ?? env.MAPBOX_PUBLIC_TOKEN),
        mapboxSecretToken: maskSecret(cfg.maps?.mapboxSecretToken ?? env.MAPBOX_SECRET_TOKEN),
        // Z-B: OpenStreetMap — the section in force (defaults filled in, the
        // way the adapter sees it), the tile key masked, `publicTiles` the
        // warning the screen prints while the template still names the
        // public tile server.
        osm: osmView(cfg),
        // AC-B1 (16 Sep): under OSM the phones still run the Mapbox engine
        // and need the PUBLIC token to initialise it — the console says so.
        // Only the verdict leaves; the token itself is the masked field above
        // and the secret token is not consulted.
        ...(((cfg.maps?.provider ?? 'GOOGLE') === 'OSM')
          ? { phoneEngine: { engine: 'MAPBOX' as const, tokenPresent: Boolean((cfg.maps?.mapboxPublicToken ?? env.MAPBOX_PUBLIC_TOKEN)?.trim()) } }
          : {}),
      },
      // G7 (Q109) / Y-B: the audience vendors. `providers` is the enabled
      // set (empty until ops choose; a legacy `provider` row shows through
      // as a one-element set) and `policy` the full blend policy with the
      // defaults filled in — the screen shows what the seam would actually
      // do. `provider` stays for the old screen: the footfall primary in
      // force, or NONE. The two API keys are masked; the base URLs, the
      // client id, the radius and the GeoIQ variable map are drawn as-is.
      audience: {
        provider: legacyAudienceProvider(resolveAudienceProviders(cfg.audience), resolveAudiencePolicy(cfg.audience?.policy)),
        providers: resolveAudienceProviders(cfg.audience),
        policy: resolveAudiencePolicy(cfg.audience?.policy),
        geoiqApiKey: maskSecret(cfg.audience?.geoiqApiKey ?? env.GEOIQ_API_KEY),
        geoiqBaseUrl: cfg.audience?.geoiqBaseUrl ?? env.GEOIQ_BASE_URL ?? GEOIQ_DEFAULT_BASE_URL,
        geoiqVariables: cfg.audience?.geoiqVariables ?? {},
        aziraApiKey: maskSecret(cfg.audience?.aziraApiKey ?? env.AZIRA_API_KEY),
        aziraClientId: cfg.audience?.aziraClientId ?? env.AZIRA_CLIENT_ID ?? null,
        aziraBaseUrl: cfg.audience?.aziraBaseUrl ?? env.AZIRA_BASE_URL ?? null,
        catchmentRadiusM: cfg.audience?.catchmentRadiusM ?? DEFAULT_AUDIENCE_CATCHMENT_RADIUS_M,
      },
      // QR-1: the QR engine. LOCAL until ops choose GenQR; the key masked;
      // the host, the short origin and the style drawn as-is. `hostsDynamic`
      // is the verdict the campaign screens need: GenQR chosen AND reachable
      // credentials present — the seam's `dynamicCodesAvailable` from the
      // same fields, so the screen and the code agree.
      qrEngine: {
        provider: cfg.qrEngine?.provider ?? 'LOCAL',
        baseUrl: cfg.qrEngine?.baseUrl || env.GENQR_BASE_URL || null,
        apiKey: maskSecret(cfg.qrEngine?.apiKey || env.GENQR_API_KEY),
        shortBaseUrl: cfg.qrEngine?.shortBaseUrl || env.GENQR_SHORT_BASE_URL || null,
        style: cfg.qrEngine?.style ?? {},
        hostsDynamic:
          (cfg.qrEngine?.provider ?? 'LOCAL') === 'GENQR' &&
          Boolean((cfg.qrEngine?.baseUrl || env.GENQR_BASE_URL) && (cfg.qrEngine?.apiKey || env.GENQR_API_KEY)),
      },
      // G11-2: read-only — the key comes from the environment, never from
      // this screen; the section says whether the rail can send.
      push: pushConfiguration(),
      // Read-only — core infra values are not editable from this UI. A live
      // change to any of these (DB connection, JWT signing secret, etc.)
      // would either require a restart or immediately invalidate every
      // active session, including the editor's own.
      infra: {
        nodeEnv: env.NODE_ENV,
        port: env.PORT,
        frontendUrl: env.FRONTEND_URL,
        baseUrl: env.BASE_URL ?? null,
        databaseUrl: maskDatabaseUrl(env.DATABASE_URL),
        jwtAccessSecret: 'configured',
        jwtRefreshSecret: 'configured',
        qrSecret: 'configured',
      },
  };
}
