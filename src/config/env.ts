import './load-env';
import { z } from 'zod';
import { parseTrustProxy } from './trust-proxy';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // What sits in front of the process. Off unless told; see trust-proxy.ts.
  TRUST_PROXY: z.string().default('').transform(parseTrustProxy),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Lot E (decision 95): the direct — unpooled — Neon endpoint. The client
   * keeps DATABASE_URL, the pooled one; migrations, pg_dump and pg_restore
   * take this, because a pooler cannot hold a transaction across the DDL a
   * migration runs or the single session a dump needs. Unset, everything
   * falls back to DATABASE_URL, which is what a local Postgres wants.
   */
  DIRECT_URL: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * The AES-256-GCM key the nightly dump is sealed with (scripts/backup.ts):
   * 32 bytes as 64 hex characters or as base64. Unset, backup and restore
   * refuse to run rather than write a plaintext dump anywhere.
   */
  BACKUP_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * Lot K2: the AES-256-GCM key the admins' authenticator-app secrets are
   * sealed with at rest (auth/two-factor/totp.ts): 32 bytes as 64 hex
   * characters or base64. Unset, a key is derived from JWT_ACCESS_SECRET so
   * development works; production must set its own, since rotating the JWT
   * secret would otherwise unseal nobody's authenticator.
   */
  TOTP_ENCRYPTION_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * The scratch database the monthly restore drill restores the newest dump
   * into (jobs/restore-drill.job.ts). Optional: unset, the drill logs a
   * warning and does nothing. It must never name the production database.
   */
  DRILL_DATABASE_URL: z.string().optional().or(z.literal('').transform(() => undefined)),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  QR_SECRET: z.string().min(16).default('qr_dev_secret_change_in_prod'),
  BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)), // public base URL for file serving (prod)
  /**
   * E11-2: where a shared spot link points — `${PUBLIC_WEB_URL}/s/:displayId`
   * on every browse card. Optional: unset, the link is built on the API
   * origin (BASE_URL, else the local port), which serves the page itself.
   */
  PUBLIC_WEB_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** E11-2: the store listings the public spot page offers beside the deep link. Optional; unset, the button is not drawn. */
  APP_STORE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  PLAY_STORE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  // SMS — MSG91
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  // Email — generic SMTP (works with Gmail, SES, SendGrid, Resend, etc.)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('ADX Admin <no-reply@adx.local>'),
  // AE-B: the SMTP door's mode — SMTP (the host above) or ETHEREAL (a
  // throwaway test inbox, nothing delivered). The integrations row wins.
  EMAIL_MODE: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['SMTP', 'ETHEREAL']).optional()),
  // Base URL of the admin UI, used to build password-reset links
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  // Where an invitation link points (Lot A, Q26). The token is appended as
  // ?token=…, so this is the accept screen itself, not the app root.
  INVITE_ACCEPT_URL: z.string().default('http://localhost:5173/accept-invite'),
  /**
   * How often the email backup may answer for an admin's second factor in a
   * rolling 30 days (Lot A, Q25).
   *
   * The hijack guard: somebody holding the password and the mailbox but not
   * the phone gets this many sign-ins before only the phone will do. Lower is
   * stricter; 0 turns the email channel off entirely.
   */
  ADMIN_EMAIL_OTP_FALLBACK_LIMIT: z.coerce.number().int().min(0).default(3),
  // Comma-separated mobile numbers that can self-provision during local LOGIN
  // OTP. Each entry is `<mobile>` (an AGENT_PUBLISHER) or `<mobile>:<ROLE>`
  // (one of the seeded roles). Hard-disabled in production.
  DEV_LOGIN_MOBILES: z.string().default(''),
  /**
   * Q-B (owner's item 11): the dev-only admin door. A `<mobile>:ADMIN` entry
   * in DEV_LOGIN_MOBILES mints an ADMIN only when this is "true" AND
   * NODE_ENV is not production — both, or the entry is refused. Off by
   * default so the allowlist alone can never hand out an admin. The minted
   * admin still answers the console's second factor; nothing bypasses 2FA.
   * Not z.coerce.boolean(): that reads the string "false" as true.
   */
  DEV_ADMIN_LOGIN: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  // Outside production, OTP is delivered through the terminal and the send-otp
  // response, so a live SMS is a cost and a failure mode with nothing to gain.
  // Set to "true" only to test the MSG91 path itself. Not z.coerce.boolean():
  // that reads the string "false" as true.
  SMS_LIVE_IN_DEV: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
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
  /**
   * Shared secret Digio signs webhook bodies with.
   *
   * Without it POST /webhooks/digio refuses every call, which is deliberate.
   * The handler moves a publisher to VERIFIED, and that is what unlocks
   * payouts — an unauthenticated version of it lets anyone holding or guessing
   * a Digio request id verify themselves. Failing closed costs a sandbox its
   * webhook until the secret is set; failing open costs real money.
   */
  DIGIO_WEBHOOK_SECRET: z.string().optional(),
  // Twilio — SMS/WhatsApp for the future agent/publisher/advertiser apps
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  // Google Maps Platform — geocoding/maps for the future agent/publisher/advertiser apps
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // G7 (Q101/132): the maps seam. The browser key is what the phones and the
  // console draw tiles with (published by GET /app/maps); the server key
  // above is what this backend spends. Mapbox is the alternative provider.
  GOOGLE_MAPS_BROWSER_KEY: z.string().optional(),
  MAPBOX_PUBLIC_TOKEN: z.string().optional(),
  MAPBOX_SECRET_TOKEN: z.string().optional(),
  // G7 (Q109): the audience / footfall vendors. Keys only; the provider
  // switch lives on the integrations row and defaults to NONE.
  GEOIQ_API_KEY: z.string().optional(),
  GEOIQ_BASE_URL: z.string().optional(),
  AZIRA_API_KEY: z.string().optional(),
  AZIRA_CLIENT_ID: z.string().optional(),
  AZIRA_BASE_URL: z.string().optional(),
  /**
   * G6 (Q103/133): push through FCM HTTP v1. The Firebase service-account
   * JSON, raw or base64 — the sender mints its own OAuth2 token from it with
   * node:crypto (RS256 JWT grant), no SDK. Unset, every push answers
   * `{ skipped: true, reason: 'FCM_NOT_CONFIGURED' }` and the app is told
   * once in the log; nothing else changes.
   */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().or(z.literal('').transform(() => undefined)),
  // Google Sign-In — the OAuth client ID the admin UI's "Continue with Google
  // Workspace" button is issued for. Unlike the integrations above this does
  // NOT degrade to a no-op when unset: POST /auth/google answers 503 instead,
  // because a login endpoint that skips its check lets anyone in.
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Comma-separated Workspace domains allowed to sign in, matched against the
  // ID token's `hd` claim (e.g. "adx.co"). Blank means any Google account may
  // attempt it — the account must still already exist in ADX either way.
  GOOGLE_ALLOWED_DOMAINS: z.string().default(''),
  // Razorpay — payments
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Lot C (Q110): the payments gateway (modules/payments). Razorpay uses one
  // host for both modes and the key prefix says which; the flag is kept for
  // the console's own record. Cashfree and CCAvenue target their sandbox
  // hosts while test mode is on — the default, so an adapter with no
  // credentials never points at a live host. Not z.coerce.boolean(): that
  // reads the string "false" as true.
  RAZORPAY_TEST_MODE: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() !== 'false'),
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_WEBHOOK_SECRET: z.string().optional(),
  CASHFREE_TEST_MODE: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() !== 'false'),
  CCAVENUE_MERCHANT_ID: z.string().optional(),
  CCAVENUE_ACCESS_CODE: z.string().optional(),
  CCAVENUE_WORKING_KEY: z.string().optional(),
  CCAVENUE_TEST_MODE: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() !== 'false'),
  // Payout rails (Lot B). Either one set makes that rail `configured` in
  // modules/payouts/rail.ts, which prefers a configured vendor and falls back
  // to manual NEFT; unset, finance pays by hand and records the UTR.
  RAZORPAY_X_KEY: z.string().optional(),
  CASHFREE_PAYOUT_KEY: z.string().optional(),
  // Stripe — payments
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // AI — one provider serves both listing-description drafting and the
  // marketplace's read-path translation. Every field is overridable from the
  // admin panel; these are the fallback, and an unset key means the feature is
  // simply off rather than broken.
  AI_PROVIDER: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  // Required by the self-hosted and Azure providers, ignored by the rest.
  AI_BASE_URL: z.string().optional(),
  // Resend — transactional email, alternative to generic SMTP
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // Redis — shared rate-limit counters, integration-config cache, and the
  // publisher-timer job lock, so all three stay correct across instances.
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Cloudflare Turnstile — verifies login/registration/password-reset
  // requests aren't scripted. Optional: unset means captcha checks no-op,
  // same graceful-degrade pattern as the other integration credentials below.
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Where a 5xx goes after it is logged (shared/errors/error-sink.ts).
  // 'none' on every developer machine; 'webhook' POSTs a compact JSON summary
  // to ERROR_WEBHOOK_URL; 'sentry' sends a minimal envelope over HTTP to the
  // DSN's envelope endpoint without the SDK. Never in front of the request:
  // fire-and-forget, 3s ceiling, never throws.
  ERROR_SINK: z.enum(['none', 'webhook', 'sentry']).default('none'),
  ERROR_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  SENTRY_DSN: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * Lot G (Q130): the region this API process runs in, as the status page
   * and `GET /settings/system-health/regions` name it. One region until
   * there is a second deployment; the default is where ADX is hosted.
   */
  APP_REGION: z.string().trim().min(1).default('ap-southeast-1 (Singapore)'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(`Invalid environment configuration: ${parsedEnv.error.message}`);
}

export const env = parsedEnv.data;
