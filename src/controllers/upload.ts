import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { uploadFile } from '../services/storage.service';

// Multer stores to a temp dir first; storage service then moves to final destination
const TEMP_DIR = path.join(process.cwd(), 'uploads', 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/svg+xml', 'application/pdf'];

const PURPOSE_FOLDER: Record<string, string> = {
  KYC: 'kyc',
  LISTING_PHOTO: 'listings',
  VERIFICATION: 'verification',
  AVATAR: 'avatars',
  OTHER: 'misc',
};

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images and PDFs are allowed'));
  },
}).single('file');

export function handleUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  uploadMiddleware(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(new ApiError(400, 'BAD_REQUEST', err.message));
    }
    if (err) return next(new ApiError(400, 'BAD_REQUEST', err.message));
    next();
  });
}

const purposeSchema = z.enum(['KYC', 'LISTING_PHOTO', 'VERIFICATION', 'AVATAR', 'OTHER']);

export async function uploadFileHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new ApiError(400, 'BAD_REQUEST', 'No file provided');

  const purposeResult = purposeSchema.safeParse(req.body['purpose'] ?? 'OTHER');
  const purpose = purposeResult.success ? purposeResult.data : 'OTHER';
  const userId = req.user!.sub;

  // req.hostname strips the port — use the Host header to preserve it in dev
  const hostHeader = req.headers['host'] ?? `localhost:${env.PORT}`;
  const baseUrl = env.BASE_URL
    ?? (env.NODE_ENV !== 'production'
      ? `http://${hostHeader}`
      : '');

  let url: string;
  try {
    const result = await uploadFile({
      filePath: req.file.path,
      filename: req.file.filename,
      mimeType: req.file.mimetype,
      folder: PURPOSE_FOLDER[purpose] ?? 'misc',
      baseUrl,
    });
    url = result.url;
  } finally {
    // Always clean up temp file — fire-and-forget is fine here, failure is non-fatal
    fs.promises.unlink(req.file.path).catch(() => {});
  }

  const record = await prisma.uploadedFile.create({
    data: {
      userId,
      url,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      purpose,
    },
  });

  res.status(201).json({ success: true, data: { url: record.url, id: record.id } });
}
