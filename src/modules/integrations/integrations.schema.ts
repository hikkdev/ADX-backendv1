import { z } from 'zod';
import type { IntegrationsConfig } from '../../shared/integrations';

export const sectionSchema = z.enum(['sms', 'email', 'storage', 'kyc', 'twilio', 'resend', 'googleMaps', 'razorpay', 'stripe', 'branding']);

export const patchSchemas = {
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
