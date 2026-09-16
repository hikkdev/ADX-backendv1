import { z } from 'zod';
import {
  AUDIENCE_FOOTFALL_BLENDS,
  AUDIENCE_PROVIDERS,
  AUDIENCE_VENDORS,
  EMAIL_MODES,
  EMAIL_PRIMARIES,
  HRMS_PROVIDERS,
  MAPS_PROVIDERS,
  QR_ENGINE_PROVIDERS,
  WORK_TOOL_PROVIDERS,
  type HrmsProvider,
  type IntegrationsConfig,
  type WorkToolProvider,
} from '../../shared/integrations';
import { AUDIENCE_FIELD_PATTERN } from '../../shared/audience';
import { SMS_KINDS, SMS_RAIL_NAMES } from '../../shared/sms';

/** An http(s) base URL, trimmed; a trailing slash is the resolver's to strip. */
const HTTP_URL = z.string().trim().max(500).regex(/^https?:\/\/[^\s]+$/, 'Must be an http(s) URL');
/** Z-B: a raster tile template — an http(s) URL carrying `{z}`, `{x}` and `{y}`; `{key}` optional. */
const TILE_TEMPLATE = HTTP_URL.refine((value) => ['{z}', '{x}', '{y}'].every((slot) => value.includes(slot)), {
  message: 'The tile template must contain {z}, {x} and {y}',
});

/** AC-B2: `POST /integrations/audience/test { vendor }` — one of the two vendors behind the seam. */
export const audienceTestSchema = z.object({ vendor: z.enum(AUDIENCE_VENDORS) });
/** AE-B: `POST /integrations/email/test { to }` — where the one test message goes; strict, so nothing else rides along. */
export const emailTestSchema = z.strictObject({ to: z.string().trim().email().max(200) });

export const sectionSchema = z.enum(['sms', 'email', 'storage', 'kyc', 'twilio', 'resend', 'googleMaps', 'razorpay', 'cashfree', 'ccavenue', 'stripe', 'branding', 'ai', 'hrms', 'workTool', 'maps', 'audience', 'qrEngine']);

/** QR-1: a hex colour as GenQR validates it. */
const HEX_COLOR = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #rrggbb colour');
/**
 * QR-1: the style every printed code is drawn with on GenQR. Strict — a
 * stray key is refused — and `null` on a field clears it back to GenQR's
 * default. The logo must be https or a same-origin path, as GenQR insists.
 */
export const qrEngineStyleSchema = z.preprocess(
  // A blank field means "keep", as it does a level up on the row; it is
  // dropped here so the colour and URL rules only see a value someone typed.
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== ''))
      : value,
  z
    .strictObject({
      foregroundColor: HEX_COLOR.nullable().optional(),
      backgroundColor: HEX_COLOR.nullable().optional(),
      dotStyle: z.enum(['square', 'dots', 'rounded']).nullable().optional(),
      frameStyle: z.enum(['none', 'simple', 'label-below', 'label-above']).nullable().optional(),
      frameCaption: z.string().trim().max(120).nullable().optional(),
      logoUrl: z.string().trim().max(500).regex(/^(https:\/\/[^\s]+|\/[^\s]*)$/, 'Must be an https URL or a same-origin path').nullable().optional(),
    })
    .partial(),
);

export const patchSchemas = {
  sms: z.object({
    authKey: z.string().optional(),
    templateId: z.string().optional(),
    /** Lot E (Q128): the routing table — not secrets, drawn as-is. */
    primaryRail: z.enum(SMS_RAIL_NAMES).optional(),
    fallbackRails: z.array(z.enum(SMS_RAIL_NAMES)).max(SMS_RAIL_NAMES.length).optional(),
    dltEntityId: z.string().max(40).optional(),
    senderId: z.string().max(11).optional(),
    /** Per rail, per kind: the rail's template id, the variables it takes, the registered text. */
    templates: z
      .record(
        z.enum(SMS_RAIL_NAMES),
        z.record(
          z.enum(SMS_KINDS),
          z.object({
            templateId: z.string().min(1).max(80),
            vars: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(20).optional(),
            body: z.string().max(1_000).optional(),
          }),
        ),
      )
      .optional(),
  }),
  /**
   * AE-B: strict — the five SMTP fields, the primary door and the mode;
   * a stray key is refused rather than dropped. `mode` is SMTP (the host)
   * or ETHEREAL (a throwaway test inbox that never delivers); not a secret,
   * drawn as-is, and a change is audited `EMAIL_MODE_CHANGED`.
   */
  email: z.strictObject({
    host: z.string().optional(),
    port: z.coerce.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    from: z.string().optional(),
    /** Lot E (Q87): which door outbound email leaves by. */
    primary: z.enum(EMAIL_PRIMARIES as [string, ...string[]]).optional(),
    mode: z.enum(EMAIL_MODES).optional(),
  }),
  storage: z.object({
    accountId: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    bucketName: z.string().optional(),
    publicUrl: z.string().url().optional().or(z.literal('')),
  }),
  kyc: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    baseUrl: z.string().url().optional(),
    /** Lot D (Q129): DIGIO, DEGRADED (the probe's verdict) or MANUAL (ops' switch). */
    kycProvider: z.enum(['DIGIO', 'DEGRADED', 'MANUAL']).optional(),
  }),
  twilio: z.object({
    accountSid: z.string().optional(),
    authToken: z.string().optional(),
    phoneNumber: z.string().optional(),
  }),
  resend: z.object({
    apiKey: z.string().optional(),
    fromEmail: z.string().optional(),
  }),
  googleMaps: z.object({
    apiKey: z.string().optional(),
  }),
  razorpay: z.object({
    keyId: z.string().optional(),
    keySecret: z.string().optional(),
    webhookSecret: z.string().optional(),
    /** Lot C (Q110): not a secret — the switch the payments screen draws. */
    testMode: z.boolean().optional(),
  }),
  cashfree: z.object({
    appId: z.string().optional(),
    secretKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    testMode: z.boolean().optional(),
  }),
  ccavenue: z.object({
    merchantId: z.string().optional(),
    accessCode: z.string().optional(),
    workingKey: z.string().optional(),
    testMode: z.boolean().optional(),
  }),
  stripe: z.object({
    publishableKey: z.string().optional(),
    secretKey: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
  branding: z.object({
    platformName: z.string().nullable().optional(),
    headerLogoUrl: z.string().url().nullable().optional().or(z.literal('')),
    authLogoUrl: z.string().url().nullable().optional().or(z.literal('')),
  }),
  ai: z.object({
    provider: z.enum(['anthropic', 'openai', 'google', 'azure-openai', 'custom']).optional(),
    apiKey: z.string().optional(),
    model: z.string().max(120).optional(),
    // Nullable so an operator can clear it when moving off a self-hosted model,
    // the same way branding clears a logo.
    baseUrl: z.string().url().nullable().optional().or(z.literal('')),
    enabled: z.boolean().optional(),
    // Bounded rather than open: these spend money per press, and a mistyped
    // 1000 in a settings field should not be the way that is discovered.
    freeQuota: z.number().int().min(0).max(100).optional(),
    paidQuota: z.number().int().min(0).max(100).optional(),
    translateOnRead: z.boolean().optional(),
  }),
  /**
   * Lot E (Q98): the HR tool — a portal link, and the credentials held for
   * the day the tier has an API. `apiKey` is the one secret; the rest is
   * drawn as-is. `employeeLinkTemplate` must carry `{externalId}` or it
   * cannot build a link to anybody.
   */
  hrms: z.object({
    provider: z.enum(HRMS_PROVIDERS as [HrmsProvider, ...HrmsProvider[]]).optional(),
    portalUrl: z.string().url().nullable().optional().or(z.literal('')),
    apiBaseUrl: z.string().url().nullable().optional().or(z.literal('')),
    apiKey: z.string().optional(),
    employeeLinkTemplate: z
      .string()
      .url()
      .refine((value) => value.includes('{externalId}'), { message: 'The template must contain {externalId}' })
      .nullable()
      .optional()
      .or(z.literal('')),
  }),
  /** E10-1: the work tool — a portal link and a name; no secret in it. */
  workTool: z.object({
    provider: z.enum(WORK_TOOL_PROVIDERS as [WorkToolProvider, ...WorkToolProvider[]]).optional(),
    portalUrl: z.string().url().nullable().optional().or(z.literal('')),
    name: z.string().trim().max(80).nullable().optional().or(z.literal('')),
  }),
  /**
   * G7 (Q101/132/137): the maps seam. `provider` picks the vendor; the four
   * keys are two pairs — a browser/public one the phones draw tiles with
   * (published by GET /app/maps) and a server/secret one only this backend
   * spends. All four are secrets to the screen: masked on the way out,
   * blank means keep.
   */
  maps: z.object({
    provider: z.enum(MAPS_PROVIDERS).optional(),
    googleBrowserKey: z.string().max(200).optional(),
    googleServerKey: z.string().max(200).optional(),
    mapboxPublicToken: z.string().max(400).optional(),
    mapboxSecretToken: z.string().max(400).optional(),
    /**
     * Z-B: OpenStreetMap. No key to speak of — three service URLs, the
     * contact email and User-Agent the public Nominatim policy demands
     * (`contactEmail` is required to SELECT OSM; the controller refuses
     * otherwise), and the tile line the clients draw with. `tileApiKey` is
     * the one secret (a MapTiler / Stadia / Thunderforest / Geoapify key);
     * `publicTiles` is written by the controller, never by the screen. The
     * object is strict; a null clears a field back to its default; blank
     * keeps. It is merged over the stored sub-object, not swapped.
     */
    osm: z
      .strictObject({
        nominatimBaseUrl: HTTP_URL.nullable().optional().or(z.literal('')),
        osrmBaseUrl: HTTP_URL.nullable().optional().or(z.literal('')),
        photonBaseUrl: HTTP_URL.nullable().optional().or(z.literal('')),
        contactEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
        userAgent: z.string().trim().max(200).nullable().optional().or(z.literal('')),
        tileUrlTemplate: TILE_TEMPLATE.nullable().optional().or(z.literal('')),
        tileAttribution: z.string().trim().min(1).max(300).nullable().optional().or(z.literal('')),
        tileMaxZoom: z.number().int().min(1).max(22).nullable().optional(),
        tileApiKey: z.string().max(200).nullable().optional(),
      })
      .optional(),
  }),
  /**
   * G7 (Q109) / Y-B: the audience / footfall vendors. `providers` is the
   * enabled SET — empty means the analytics say no panel backs an audience
   * figure; the legacy one-of-three `provider` is still accepted and stored
   * as a one-element set (NONE = empty). `policy` is strict: per field
   * group, the primary vendor, whether the other fills a null, and for
   * footfall whether two answers are averaged. The keys are secrets; the
   * base URLs, the client id, the catchment radius and the GeoIQ variable
   * map are not. `geoiqVariables` maps the seam's field names
   * (`footfall.daily`, `age.18_24`, `gender.female`, `income.high`,
   * `affinity.<name>`) to the catalogue ids the account was sold — a field
   * with no id is null.
   */
  /**
   * QR-1: the QR engine — the switch, GenQR's host and key, the short
   * origin printed on hoardings, and the style. Strict: a stray key is 400.
   */
  qrEngine: z.strictObject({
    provider: z.enum(QR_ENGINE_PROVIDERS).optional(),
    baseUrl: HTTP_URL.optional(),
    apiKey: z.string().trim().max(200).optional(),
    shortBaseUrl: HTTP_URL.nullable().optional(),
    style: qrEngineStyleSchema.optional(),
  }),
  audience: z.object({
    provider: z.enum(AUDIENCE_PROVIDERS).optional(),
    providers: z
      .array(z.enum(AUDIENCE_VENDORS))
      .max(AUDIENCE_VENDORS.length)
      .transform((list) => AUDIENCE_VENDORS.filter((vendor) => list.includes(vendor)))
      .optional(),
    policy: z
      .strictObject({
        footfall: z
          .strictObject({ primary: z.enum(AUDIENCE_VENDORS), fallback: z.boolean(), blend: z.enum(AUDIENCE_FOOTFALL_BLENDS) })
          .partial()
          .optional(),
        demographics: z.strictObject({ primary: z.enum(AUDIENCE_VENDORS), fallback: z.boolean() }).partial().optional(),
        affinities: z.strictObject({ primary: z.enum(AUDIENCE_VENDORS), fallback: z.boolean() }).partial().optional(),
      })
      .optional(),
    geoiqApiKey: z.string().max(400).optional(),
    geoiqBaseUrl: z.string().url().nullable().optional().or(z.literal('')),
    /**
     * AC-B2: the keys are checked against the seam's pattern by hand so a
     * refusal NAMES the stray field(s) — a record's key schema alone would
     * only say "invalid key" — and the map is capped at 200 entries.
     */
    geoiqVariables: z
      .record(z.string(), z.string().min(1).max(120))
      .superRefine((map, ctx) => {
        const unknown = Object.keys(map).filter((field) => !AUDIENCE_FIELD_PATTERN.test(field));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `Not audience fields: ${unknown.join(', ')}. Use footfall.daily, age.<band>, gender.male|female|other, income.<band> or affinity.<name>.`,
            path: unknown.length === 1 ? [unknown[0]!] : [],
            params: { unknown },
          });
        }
        if (Object.keys(map).length > 200) ctx.addIssue({ code: 'custom', message: 'At most 200 variables can be mapped.' });
      })
      .optional(),
    aziraApiKey: z.string().max(400).optional(),
    aziraClientId: z.string().max(200).optional(),
    aziraBaseUrl: z.string().url().nullable().optional().or(z.literal('')),
    catchmentRadiusM: z.number().int().min(50).max(5_000).optional(),
  }),
} satisfies Record<keyof IntegrationsConfig, z.ZodTypeAny>;
