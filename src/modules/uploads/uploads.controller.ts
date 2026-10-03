import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { DOCUMENT_KINDS, getDocumentReading, getDocumentReadingAt, readDocument, readDocumentAt, readDocumentByUrlSchema, readDocumentSchema } from './document-reading';
import { env } from '../../config/env';
import { purposeSchema } from './uploads.schema';
import { deleteFile, openFile, storeUpload } from './uploads.service';
import { parseAvatarCrop } from './avatar';
import { parseGeoStamp } from './geo-stamp';

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
    // GC-1: the phone's fix at the shutter, when the person had the GPS stamp on.
    geo: parseGeoStamp(req.body['geo']),
  });

  res.status(201).json({ success: true, data: { url: record.url, id: record.id, geoStamped: record.geoStamped } });
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

/** DR-1: `GET /files/:id/reading` — what the model read off this document, or null when nobody has asked. */
export async function getDocumentReadingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getDocumentReading(req.params['id'] as string) });
}

/** DR-1: `GET /files/reading?url=` — the reading kept on a file known by its public URL, or null. */
export async function getDocumentReadingAtHandler(req: Request, res: Response): Promise<void> {
  const url = typeof req.query['url'] === 'string' ? req.query['url'] : '';
  if (!url) throw new ApiError(400, 'BAD_REQUEST', 'Say which file: ?url=');
  res.json({ success: true, data: await getDocumentReadingAt(url) });
}

/** DR-1: `POST /files/read { url, kind }` — the same read for a file known by its public URL. */
export async function readDocumentAtHandler(req: Request, res: Response): Promise<void> {
  const parsed = readDocumentByUrlSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', `Send the file's URL and the kind of document — one of ${DOCUMENT_KINDS.join(', ')}.`);
  res.json({ success: true, data: await readDocumentAt(parsed.data.url, parsed.data.kind, { userId: req.user!.sub, req }) });
}

/** DR-1: `POST /files/:id/read { kind }` — the desk asks what is written on a document. Read once, kept on the row. */
export async function readDocumentHandler(req: Request, res: Response): Promise<void> {
  const parsed = readDocumentSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', `Name the kind of document — one of ${DOCUMENT_KINDS.join(', ')}.`);
  res.json({ success: true, data: await readDocument(req.params['id'] as string, parsed.data.kind, { userId: req.user!.sub, req }) });
}
