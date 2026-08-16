import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { env } from '../config/env';
import { logActivity } from '../services/activityLog.service';
import { getIntegrationsConfig, updateIntegrationsConfig, type IntegrationsConfig } from '../services/integrationConfig.service';

function maskSecret(value?: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):([^@]+)@/, '://$1:••••@');
}

// GET /integrations — current effective config (DB override, falling back to
// .env). Secrets are always masked; the raw value never leaves the server.
export async function getIntegrationsHandler(_req: Request, res: Response): Promise<void> {
  const cfg = await getIntegrationsConfig();

  res.json({
    success: true,
    data: {
      sms: {
        authKey: maskSecret(cfg.sms?.authKey ?? env.MSG91_AUTH_KEY),
        templateId: cfg.sms?.templateId ?? env.MSG91_TEMPLATE_ID ?? null,
      },
      email: {
        host: cfg.email?.host ?? env.SMTP_HOST ?? null,
        port: cfg.email?.port ?? env.SMTP_PORT ?? null,
        user: cfg.email?.user ?? env.SMTP_USER ?? null,
        password: maskSecret(cfg.email?.password ?? env.SMTP_PASSWORD),
        from: cfg.email?.from ?? env.SMTP_FROM,
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
        adminSecret: 'configured',
        qrSecret: 'configured',
      },
    },
  });
}

const sectionSchema = z.enum(['sms', 'email', 'storage', 'kyc', 'twilio', 'resend', 'googleMaps', 'razorpay', 'stripe', 'branding']);

const patchSchemas = {
  sms: z.object({
    authKey: z.string().optional(),
    templateId: z.string().optional(),
  }),
  email: z.object({
    host: z.string().optional(),
    port: z.coerce.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    from: z.string().optional(),
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
} satisfies Record<keyof IntegrationsConfig, z.ZodTypeAny>;

// PUT /integrations — body: { section: 'sms'|'email'|'storage'|'kyc'|'twilio'|'googleMaps'|'razorpay'|'stripe'|'branding', patch: {...} }
// Any field omitted (or sent empty) from `patch` keeps its existing stored
// value — since secrets are never sent back to the client, the form can't
// round-trip the real value anyway, only a deliberately-entered new one.
export async function updateIntegrationsHandler(req: Request, res: Response): Promise<void> {
  const sectionParsed = sectionSchema.safeParse(req.body?.section);
  if (!sectionParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or missing "section"', sectionParsed.error.flatten());
  }

  const section = sectionParsed.data;
  const patchParsed = patchSchemas[section].safeParse(req.body?.patch ?? {});
  if (!patchParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', patchParsed.error.flatten());
  }

  await updateIntegrationsConfig(section, patchParsed.data);
  await logActivity(req.user!.sub, 'INTEGRATION_CONFIG_UPDATED', req, { section, fields: Object.keys(patchParsed.data) });

  res.json({ success: true, data: { message: `${section} configuration updated` } });
}
