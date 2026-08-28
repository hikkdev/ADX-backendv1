import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../../shared/errors';
import { ALLOWED_MIME, MAX_FILE_BYTES } from './uploads.schema';

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
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images and PDFs are allowed'));
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
    next();
  });
}
