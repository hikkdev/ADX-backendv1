import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { env } from '../../config/env';
import { purposeSchema } from './uploads.schema';
import { storeUpload } from './uploads.service';

export async function uploadFileHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new ApiError(400, 'BAD_REQUEST', 'No file provided');

  // An unrecognised purpose falls back to OTHER rather than failing the upload.
  const purposeResult = purposeSchema.safeParse(req.body['purpose'] ?? 'OTHER');
  const purpose = purposeResult.success ? purposeResult.data : 'OTHER';

  // req.hostname strips the port — use the Host header to preserve it in dev.
  const hostHeader = req.headers['host'] ?? `localhost:${env.PORT}`;
  const baseUrl = env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `http://${hostHeader}` : '');

  const record = await storeUpload(req.user!.sub, req.file, purpose, baseUrl);

  res.status(201).json({ success: true, data: { url: record.url, id: record.id } });
}
