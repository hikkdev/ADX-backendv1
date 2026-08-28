import { z } from 'zod';

export const purposeSchema = z.enum([
  'KYC',
  'LISTING_PHOTO',
  'VERIFICATION',
  'AVATAR',
  'OTHER',
]);

export type UploadPurpose = z.infer<typeof purposeSchema>;

/** Destination folder per purpose. Unknown purposes fall back to 'misc'. */
export const PURPOSE_FOLDER: Record<string, string> = {
  KYC: 'kyc',
  LISTING_PHOTO: 'listings',
  VERIFICATION: 'verification',
  AVATAR: 'avatars',
  OTHER: 'misc',
};

export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/svg+xml',
  'application/pdf',
];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
