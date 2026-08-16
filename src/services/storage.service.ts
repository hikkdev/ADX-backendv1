import fs from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { getEffectiveStorageConfig, type StorageConfig } from './integrationConfig.service';

export type StorageProvider = 'local' | 'r2';

function getActiveProvider(cfg: StorageConfig): StorageProvider {
  if (cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucketName) {
    return 'r2';
  }
  return 'local';
}

async function uploadToR2(filePath: string, filename: string, mimeType: string, cfg: StorageConfig): Promise<string> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const fileBuffer = fs.readFileSync(filePath);

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId!,
      secretAccessKey: cfg.secretAccessKey!,
    },
  });

  await client.send(new PutObjectCommand({
    Bucket: cfg.bucketName!,
    Key: filename,
    Body: fileBuffer,
    ContentType: mimeType,
  }));

  const publicUrl = cfg.publicUrl ?? `https://${cfg.bucketName}.${cfg.accountId}.r2.dev`;
  return `${publicUrl}/${filename}`;
}

async function uploadToLocal(filePath: string, filename: string, baseUrl: string): Promise<string> {
  const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.copyFileSync(filePath, path.join(UPLOADS_DIR, filename));
  return `${baseUrl}/uploads/${filename}`;
}

export async function uploadFile(opts: {
  filePath: string;
  filename: string;
  mimeType: string;
  folder: string;
  baseUrl: string;
}): Promise<{ url: string; provider: StorageProvider }> {
  const cfg = await getEffectiveStorageConfig();
  const provider = getActiveProvider(cfg);
  logger.info('Uploading file', { provider, folder: opts.folder, filename: opts.filename });

  const key = `${opts.folder}/${opts.filename}`;
  const url = provider === 'r2'
    ? await uploadToR2(opts.filePath, key, opts.mimeType, cfg)
    : await uploadToLocal(opts.filePath, opts.filename, opts.baseUrl);

  return { url, provider };
}
