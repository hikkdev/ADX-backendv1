import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { env } from '../../config/env';
import { purposeSchema } from './uploads.schema';
import { deleteFile, openFile, storeUpload } from './uploads.service';
import { parseAvatarCrop } from './avatar';

/** `BASE_URL`, or outside production the request's Host header (it keeps the port; `req.hostname` drops it). */
export function baseUrlFor(req: Request): string {
  const hostHeader = req.headers['host'] ?? `localhost:${env.PORT}`;
  return env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `http://${hostHeader}` : '');
}

export async function uploadFileHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new ApiError(400, 'BAD_REQUEST', 'No file provided');

  // An unrecognised purpose falls back to OTHER rather than failing the upload.
  const purposeResult = purposeSchema.safeParse(req.body['purpose'] ?? 'OTHER');
  const purpose = purposeResult.success ? purposeResult.data : 'OTHER';

  // Lot D: an agent or an admin uploading a party's document names them, so
  // the file belongs to the party and not to the hand that carried it.
  const ownerField = req.body['ownerUserId'];
  const ownerUserId = typeof ownerField === 'string' && ownerField.trim() ? ownerField.trim() : null;

  // Lot F: naming an owner is an on-behalf write — ADMIN, or the party's
  // agent under a live grant; anyone else is 403 (the service decides).
  const record = await storeUpload(req.user!.sub, req.file, purpose, baseUrlFor(req), {
    ownerUserId,
    isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
    // QR-7: the square the person chose for a profile picture, as fractions.
    crop: purpose === 'AVATAR' ? parseAvatarCrop(req.body['crop']) : null,
  });

  res.status(201).json({ success: true, data: { url: record.url, id: record.id } });
}

const viewerOf = (req: Request) => ({
  userId: req.user!.sub,
  isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
});

// GET /files/:id — Lot D (Q61): the one door to a private file.
export async function getFileHandler(req: Request, res: Response): Promise<void> {
  const opened = await openFile(req.params['id'] as string, viewerOf(req), req);
  if (opened.kind === 'redirect') {
    res.redirect(302, opened.url);
    return;
  }
  res.set('Content-Type', opened.mimeType);
  res.set('Content-Disposition', `inline; filename="${opened.filename.replace(/"/g, '')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(opened.path);
}

// DELETE /files/:id
export async function deleteFileHandler(req: Request, res: Response): Promise<void> {
  await deleteFile(req.params['id'] as string, viewerOf(req), req);
  res.json({ success: true, data: { message: 'File deleted' } });
}
