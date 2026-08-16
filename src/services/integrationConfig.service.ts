import { prisma } from '../lib/prisma';
import { env } from '../config/env';

export interface SmsConfig { authKey?: string; templateId?: string }
export interface EmailConfig { host?: string; port?: number; user?: string; password?: string; from?: string }
export interface StorageConfig { accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucketName?: string; publicUrl?: string }
export interface KycConfig { clientId?: string; clientSecret?: string; baseUrl?: string }
export interface TwilioConfig { accountSid?: string; authToken?: string; phoneNumber?: string }
export interface GoogleMapsConfig { apiKey?: string }
export interface RazorpayConfig { keyId?: string; keySecret?: string; webhookSecret?: string }
export interface StripeConfig { publishableKey?: string; secretKey?: string; webhookSecret?: string }
export interface ResendConfig { apiKey?: string; fromEmail?: string }
export interface BrandingConfig { platformName?: string; headerLogoUrl?: string; authLogoUrl?: string }

export interface IntegrationsConfig {
  sms?: SmsConfig;
  email?: EmailConfig;
  storage?: StorageConfig;
  kyc?: KycConfig;
  twilio?: TwilioConfig;
  resend?: ResendConfig;
  googleMaps?: GoogleMapsConfig;
  razorpay?: RazorpayConfig;
  stripe?: StripeConfig;
  branding?: BrandingConfig;
}

const CONFIG_KEY = 'integrations';

// Simple in-memory cache — invalidated on every write, so reads never need a
// DB round-trip on the hot path (sending an SMS/email, uploading a file).
let cache: IntegrationsConfig | null = null;

async function loadConfig(): Promise<IntegrationsConfig> {
  if (cache) return cache;
  const row = await prisma.appConfig.findUnique({ where: { key: CONFIG_KEY } });
  cache = (row?.value as IntegrationsConfig | undefined) ?? {};
  return cache;
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

  cache = next;
  return next;
}

// ─── Effective config getters — DB value wins, per field, over .env ──────────

export async function getEffectiveSmsConfig(): Promise<SmsConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    authKey: cfg.sms?.authKey || env.MSG91_AUTH_KEY,
    templateId: cfg.sms?.templateId || env.MSG91_TEMPLATE_ID,
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
  };
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

export async function getEffectiveGoogleMapsConfig(): Promise<GoogleMapsConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    apiKey: cfg.googleMaps?.apiKey || env.GOOGLE_MAPS_API_KEY,
  };
}

export async function getEffectiveRazorpayConfig(): Promise<RazorpayConfig> {
  const cfg = await getIntegrationsConfig();
  return {
    keyId: cfg.razorpay?.keyId || env.RAZORPAY_KEY_ID,
    keySecret: cfg.razorpay?.keySecret || env.RAZORPAY_KEY_SECRET,
    webhookSecret: cfg.razorpay?.webhookSecret || env.RAZORPAY_WEBHOOK_SECRET,
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
