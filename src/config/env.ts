import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  QR_SECRET: z.string().min(16).default('qr_dev_secret_change_in_prod'),
  BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)), // public base URL for file serving (prod)
  // SMS — MSG91
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  // Email — generic SMTP (works with Gmail, SES, SendGrid, Resend, etc.)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('ADX Admin <no-reply@adx.local>'),
  // Base URL of the admin UI, used to build password-reset links
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  // Comma-separated mobile numbers that can self-provision during local LOGIN OTP.
  DEV_LOGIN_MOBILES: z.string().default(''),
  // Cloudflare R2 (S3-compatible)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)), // e.g. https://pub-xxx.r2.dev
  // Digio KYC
  DIGIO_CLIENT_ID: z.string().optional(),
  DIGIO_CLIENT_SECRET: z.string().optional(),
  DIGIO_BASE_URL: z.string().url().default('https://ext-enterprise.digio.in'), // sandbox default
  // Twilio — SMS/WhatsApp for the future agent/publisher/advertiser apps
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  // Google Maps Platform — geocoding/maps for the future agent/publisher/advertiser apps
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Razorpay — payments
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Stripe — payments
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Resend — transactional email, alternative to generic SMTP
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // Admin secret for internal tools (flow editor) — skips JWT auth for PUT /config
  ADMIN_SECRET: z.string().min(8).default('adx_admin_dev_secret'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(`Invalid environment configuration: ${parsedEnv.error.message}`);
}

export const env = parsedEnv.data;
