import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../../shared/errors';
import { ALLOWED_MIME, CSV_MIME, XLSX_MIME, MAX_CSV_BYTES, MAX_FILE_BYTES, MAX_VIDEO_BYTES, PURPOSE_ONLY_MIME, isVideo, mimeAllowedFor } from './uploads.schema';

// Multer stores to a temp dir first; the storage adapter then moves the file to
// its final destination (local disk or R2).
const TEMP_DIR = path.join(process.cwd(), 'uploads', 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * ST-1 (28 Sep 2026): the extension a stored object is named with follows
 * its declared type, not the name the client sent. The disk provider's
 * static mount types a file by its extension, so `evil.svg` sent as
 * `image/png` would have been served back as an SVG — script and all —
 * without ever passing the SVG gate. A name that already agrees with the
 * type (`.jpeg` for a JPEG) is kept.
 */
export const EXTENSIONS_FOR_MIME: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/heic': ['.heic', '.heif'],
  'image/svg+xml': ['.svg'],
  'application/pdf': ['.pdf'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov', '.qt'],
  'video/webm': ['.webm'],
};

export function storedExtension(originalname: string, mimetype: string): string {
  const sent = path.extname(originalname).toLowerCase();
  const known = EXTENSIONS_FOR_MIME[mimetype.toLowerCase()];
  if (!known) return sent;
  return known.includes(sent) ? sent : known[0]!;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = storedExtension(file.originalname, file.mimetype);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

export const uploadMiddleware = multer({
  storage,
  // Multer only knows one ceiling, so it enforces the larger one and the
  // handler below rejects an oversized non-video. Doing it the other way round
  // would refuse every video before anything could inspect its type.
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    // A purpose-only type (WebM) passes here and is checked against the
    // purpose below, once the whole form has been read.
    if (ALLOWED_MIME.includes(file.mimetype) || file.mimetype in PURPOSE_ONLY_MIME) return cb(null, true);
    cb(new Error('Only images, PDFs and MP4 video are allowed'));
  },
}).single('file');

/**
 * Translates multer's own errors into the API error envelope. Without this a
 * rejected upload surfaces as a bare 500 instead of a 400.
 */
export function handleUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  uploadMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(new ApiError(400, 'BAD_REQUEST', err.message));
    }
    if (err) return next(new ApiError(400, 'BAD_REQUEST', err.message));

    const file = req.file;
    // 26 Sep 2026: a purpose-only type (WebM for the liveness video) outside its purpose.
    if (file && !mimeAllowedFor(file.mimetype, typeof req.body?.['purpose'] === 'string' ? req.body['purpose'] : undefined)) {
      fs.promises.unlink(file.path).catch(() => undefined);
      return next(new ApiError(400, 'BAD_REQUEST', 'Only images, PDFs and MP4 video are allowed'));
    }

    // The second half of the two-ceiling rule: anything that is not video is
    // held to the smaller limit.
    if (file && !isVideo(file.mimetype) && file.size > MAX_FILE_BYTES) {
      return next(
        new ApiError(
          400,
          'BAD_REQUEST',
          `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Images and documents are capped at ${MAX_FILE_BYTES / 1024 / 1024} MB.`
        )
      );
    }

    next();
  });
}

/**
 * Lot B (Q85): a CSV in memory, for the reconciliation import. The general
 * middleware refuses text on purpose — a listing photo is never a .csv — so
 * the statement import has its own narrow filter: a .csv extension or a CSV
 * type, five megabytes, one file under `file`. Memory rather than disk: the
 * parser reads it once and the raw file is then stored like any upload.
 */
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES },
  fileFilter: (_req, file, cb) => {
    const named = path.extname(file.originalname).toLowerCase() === '.csv';
    if (named || CSV_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only a .csv statement export is accepted'));
  },
}).single('file');

export function csvUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  csvUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, 'BAD_REQUEST', err.message));
    if (err) return next(new ApiError(400, 'BAD_REQUEST', err.message));
    next();
  });
}

/**
 * 26 Sep 2026: the bulk listing upload takes a CSV **or** an .xlsx (the
 * apps and the website promise both). The CSV door's narrow filter, plus
 * the .xlsx extension or the OOXML spreadsheet type; the same five
 * megabytes, in memory, one file under `file`. The importer tells the two
 * apart by the file's first bytes, not its name.
 */
const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.csv' || ext === '.xlsx' || CSV_MIME.includes(file.mimetype) || file.mimetype === XLSX_MIME) return cb(null, true);
    cb(new Error('Only a .csv or .xlsx file is accepted'));
  },
}).single('file');

export function spreadsheetUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  spreadsheetUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, 'BAD_REQUEST', err.message));
    if (err) return next(new ApiError(400, 'BAD_REQUEST', err.message));
    next();
  });
}
