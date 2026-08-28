import fs from 'fs';
import { uploadFile } from '../../shared/storage';
import { prismaUploadsRepository as repository } from './prisma-uploads.repository';
import { PURPOSE_FOLDER, type UploadPurpose } from './uploads.schema';

export type IncomingFile = {
  /** Temp path multer wrote to. Always removed, success or failure. */
  path: string;
  /** Generated name, used as the stored object key. */
  filename: string;
  /** Name the client sent, kept for display. */
  originalname: string;
  mimetype: string;
  size: number;
};

/**
 * Hands the temp file to the configured storage provider, then records it.
 *
 * The temp file is removed in a finally block: leaving it behind on a failed
 * upload would slowly fill the uploads/tmp directory. Deletion failure is
 * non-fatal and deliberately swallowed.
 */
export async function storeUpload(
  userId: string,
  file: IncomingFile,
  purpose: UploadPurpose,
  baseUrl: string,
) {
  let url: string;
  try {
    const result = await uploadFile({
      filePath: file.path,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: PURPOSE_FOLDER[purpose] ?? 'misc',
      baseUrl,
    });
    url = result.url;
  } finally {
    fs.promises.unlink(file.path).catch(() => {});
  }

  return repository.record({
    userId,
    url,
    filename: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    purpose,
  });
}
