import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../../shared/errors';
import { ALLOWED_MIME, CSV_MIME, MAX_CSV_BYTES, MAX_FILE_BYTES, MAX_VIDEO_BYTES, isVideo } from './uploads.schema';

// Multer stores to a temp dir first; the storage adapter then moves the file to
// its final destination (local disk or R2).
const TEMP_DIR = path.join(process.cwd(), 'uploads', 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
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
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
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

    // The second half of the two-ceiling rule: anything that is not video is
    // held to the smaller limit.
    const file = req.file;
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
