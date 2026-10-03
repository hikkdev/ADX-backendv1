import { z } from 'zod';
import { MAX_KEY_LENGTH, MAX_TARGET_LENGTH, PAGE_KEY } from './paths';
import { PAGE_TEMPLATES } from './templates';

/**
 * PB-1: the request shapes. Addresses are typed loosely here and checked by
 * `paths.ts` in the service, so the desk gets the one sentence that names
 * what is wrong rather than a regex's "invalid".
 */

export const PAGE_CHANNELS = ['WEBSITE', 'APPS'] as const;

const channelsSchema = z
  .array(z.enum(PAGE_CHANNELS))
  .min(1, 'A page is shown somewhere — the website, the apps, or both')
  .max(2)
  .transform((channels) => [...new Set(channels)]);

export const createPageSchema = z.object({
  key: z.string().trim().max(MAX_KEY_LENGTH).regex(PAGE_KEY, 'A key is lowercase letters, digits and single hyphens — "diwali-2026"'),
  title: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(200),
  channels: channelsSchema.optional(),
  template: z.enum(PAGE_TEMPLATES).default('blank'),
});

export const patchPageSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    channels: channelsSchema.optional(),
    path: z.string().trim().min(1).max(200).optional(),
  })
  .refine((patch) => patch.title !== undefined || patch.channels !== undefined || patch.path !== undefined, 'Nothing to change');

export const createRedirectSchema = z.object({
  fromPath: z.string().trim().min(1).max(200),
  toPath: z.string().trim().min(1).max(MAX_TARGET_LENGTH),
  permanent: z.boolean().default(true),
});

/** `:key` on every page route — refused as a 404 rather than a 400, since a bad key names no page. */
export const pageKeySchema = z.string().trim().max(MAX_KEY_LENGTH).regex(PAGE_KEY);
