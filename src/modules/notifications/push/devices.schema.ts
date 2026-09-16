import { z } from 'zod';

/** The two apps and the two platforms a token can come from — the Prisma enums, as the wire spells them. */
export const DEVICE_APPS = ['USER', 'AGENT'] as const;
export const DEVICE_PLATFORMS = ['ANDROID', 'IOS'] as const;

/** An FCM registration token: opaque, long, printable. */
const tokenSchema = z.string().trim().min(20).max(4096).regex(/^[A-Za-z0-9_\-:.]+$/, 'Not a device token');

/** PUT /users/me/devices */
export const registerDeviceSchema = z
  .object({
    token: tokenSchema,
    app: z.enum(DEVICE_APPS),
    platform: z.enum(DEVICE_PLATFORMS),
    appVersion: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export type RegisterDeviceBody = z.infer<typeof registerDeviceSchema>;

/** DELETE /users/me/devices/:token */
export const deviceTokenParamSchema = z.object({ token: tokenSchema });
