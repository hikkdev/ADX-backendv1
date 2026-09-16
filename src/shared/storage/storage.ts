import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger';
import { getEffectiveStorageConfig, type StorageConfig } from '../integrations/integration-config';
import { presignGet } from './presign';

export type StorageProvider = 'local' | 'r2';

function getActiveProvider(cfg: StorageConfig): StorageProvider {
  if (cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucketName) {
    return 'r2';
  }
  return 'local';
}

/**
 * Where a private object lives — Lot D (Q61).
 *
 * A private file is never given a public URL: it is stored under a prefix
 * the bucket's public host does not serve (R2) or outside the static
 * `/uploads` mount (local), and the record keeps a `storageKey` —
 * `<provider>:<key>` — so a read knows where to look even after the
 * provider behind uploads has changed.
 */
export type FileVisibility = 'PUBLIC' | 'PRIVATE';
export const PRIVATE_PREFIX = 'private';
export const PRIVATE_LOCAL_DIR = 'private-uploads';
/** How long a presigned R2 read stays valid. */
export const PRIVATE_READ_SECONDS = 5 * 60;

async function r2Client(cfg: StorageConfig) {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey! },
  });
}

async function uploadToR2(filePath: string, filename: string, mimeType: string, cfg: StorageConfig): Promise<string> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const fileBuffer = fs.readFileSync(filePath);
  const client = await r2Client(cfg);

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

function localPrivatePath(key: string): string {
  return path.join(process.cwd(), PRIVATE_LOCAL_DIR, ...key.split('/'));
}

async function uploadPrivate(filePath: string, key: string, mimeType: string, cfg: StorageConfig, provider: StorageProvider): Promise<string> {
  if (provider === 'r2') {
    await uploadToR2(filePath, key, mimeType, cfg);
    return `r2:${key}`;
  }
  const target = localPrivatePath(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(filePath, target);
  return `local:${key}`;
}

export async function uploadFile(opts: {
  filePath: string;
  filename: string;
  mimeType: string;
  folder: string;
  baseUrl: string;
  visibility?: FileVisibility;
}): Promise<{ url: string | null; provider: StorageProvider; storageKey: string }> {
  const cfg = await getEffectiveStorageConfig();
  const provider = getActiveProvider(cfg);
  const visibility = opts.visibility ?? 'PUBLIC';
  logger.info('Uploading file', { provider, folder: opts.folder, filename: opts.filename, visibility });

  if (visibility === 'PRIVATE') {
    const key = `${PRIVATE_PREFIX}/${opts.folder}/${opts.filename}`;
    const storageKey = await uploadPrivate(opts.filePath, key, opts.mimeType, cfg, provider);
    return { url: null, provider, storageKey };
  }

  const key = `${opts.folder}/${opts.filename}`;
  const url = provider === 'r2'
    ? await uploadToR2(opts.filePath, key, opts.mimeType, cfg)
    : await uploadToLocal(opts.filePath, opts.filename, opts.baseUrl);

  return { url, provider, storageKey: `${provider}:${key}` };
}

function splitKey(storageKey: string): { provider: StorageProvider; key: string } {
  const index = storageKey.indexOf(':');
  const provider = storageKey.slice(0, index);
  return { provider: provider === 'r2' ? 'r2' : 'local', key: storageKey.slice(index + 1) };
}

/**
 * How a private object is read: a five-minute presigned GET on R2, or the
 * local path to stream. The record's `storageKey` says which.
 */
export async function openPrivateFile(
  storageKey: string,
  opts: { filename?: string; mimeType?: string } = {},
): Promise<{ kind: 'redirect'; url: string } | { kind: 'stream'; path: string }> {
  const { provider, key } = splitKey(storageKey);
  if (provider === 'local') return { kind: 'stream', path: localPrivatePath(key) };

  const cfg = await getEffectiveStorageConfig();
  if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucketName) {
    throw new Error('R2 is not configured; a private object stored there cannot be read');
  }
  const url = presignGet({
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucketName}/${key}`,
    region: 'auto',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresInSeconds: PRIVATE_READ_SECONDS,
    query: {
      ...(opts.mimeType ? { 'response-content-type': opts.mimeType } : {}),
      ...(opts.filename ? { 'response-content-disposition': `inline; filename="${opts.filename.replace(/"/g, '')}"` } : {}),
    },
  });
  return { kind: 'redirect', url };
}

/**
 * Removes the object behind a key. Best-effort: a missing object is not an
 * error, and a provider that cannot be reached is logged, because the row is
 * what the platform answers from and it is removed either way.
 */
export async function deleteStoredFile(storageKey: string): Promise<void> {
  const { provider, key } = splitKey(storageKey);
  try {
    if (provider === 'local') {
      const isPrivate = key.startsWith(`${PRIVATE_PREFIX}/`);
      const target = isPrivate ? localPrivatePath(key) : path.join(process.cwd(), 'uploads', path.basename(key));
      await fs.promises.unlink(target).catch(() => undefined);
      return;
    }
    const cfg = await getEffectiveStorageConfig();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await r2Client(cfg);
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucketName!, Key: key }));
  } catch (err) {
    logger.warn('Could not remove a stored object', { storageKey, err: err instanceof Error ? err.message : String(err) });
  }
}

/* ── Private folders as a whole (Lot E, decision 95: the backups) ────── */

export type StoredObject = {
  /** `<provider>:<key>`, what `downloadPrivateFile` and `deleteStoredFile` take. */
  storageKey: string;
  /** The last path segment. */
  name: string;
  size: number;
  lastModified: Date | null;
};

/**
 * Every object under `private/<folder>/`, for a caller that owns the folder
 * rather than a row per file — the nightly dumps, which no `UploadedFile`
 * records. Newest-first is the caller's business; this is the listing.
 */
export async function listPrivateFiles(folder: string): Promise<StoredObject[]> {
  const cfg = await getEffectiveStorageConfig();
  const provider = getActiveProvider(cfg);
  const prefix = `${PRIVATE_PREFIX}/${folder}/`;

  if (provider === 'local') {
    const dir = localPrivatePath(prefix);
    if (!fs.existsSync(dir)) return [];
    const names = await fs.promises.readdir(dir);
    const rows = await Promise.all(
      names.map(async (name): Promise<StoredObject | null> => {
        const stat = await fs.promises.stat(path.join(dir, name));
        if (!stat.isFile()) return null;
        return { storageKey: `local:${prefix}${name}`, name, size: stat.size, lastModified: stat.mtime };
      }),
    );
    return rows.filter((row): row is StoredObject => row !== null);
  }

  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = await r2Client(cfg);
  const out: StoredObject[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: cfg.bucketName!, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;
      out.push({
        storageKey: `r2:${obj.Key}`,
        name: obj.Key.slice(obj.Key.lastIndexOf('/') + 1),
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? null,
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Copies the object behind a private `storageKey` to a local path. */
export async function downloadPrivateFile(storageKey: string, toPath: string): Promise<void> {
  const { provider, key } = splitKey(storageKey);
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  if (provider === 'local') {
    await fs.promises.copyFile(localPrivatePath(key), toPath);
    return;
  }
  const cfg = await getEffectiveStorageConfig();
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await r2Client(cfg);
  const object = await client.send(new GetObjectCommand({ Bucket: cfg.bucketName!, Key: key }));
  if (!object.Body) throw new Error('The object has no body');
  const { pipeline } = await import('stream/promises');
  await pipeline(object.Body as NodeJS.ReadableStream, fs.createWriteStream(toPath));
}

/* ── The bucket's pulse (Lot G, Q130: the STORAGE health sample) ────── */

export type StorageProbe = { ok: true; provider: StorageProvider; latencyMs: number } | { ok: false; provider: StorageProvider; latencyMs: number; error: string };

/**
 * One HEAD on the bucket (R2), or one access check on the private folder
 * (local) — bounded, never throwing. What comes back carries no key, no
 * account id and no URL: the health sample is written to a table every
 * admin reads.
 */
export async function probeStorage(timeoutMs = 5_000): Promise<StorageProbe> {
  const startedAt = Date.now();
  let provider: StorageProvider = 'local';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`storage probe exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const cfg = await getEffectiveStorageConfig();
    provider = getActiveProvider(cfg);
    const probe = (async () => {
      if (provider === 'local') {
        const dir = localPrivatePath(`${PRIVATE_PREFIX}/`);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.access(dir, fs.constants.R_OK | fs.constants.W_OK);
        return;
      }
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const client = await r2Client(cfg);
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucketName! }));
    })();
    await Promise.race([probe, timeout]);
    return { ok: true, provider, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A provider's message can quote the endpoint; the sample keeps the class of failure only.
    const error = message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 200);
    return { ok: false, provider, latencyMs: Date.now() - startedAt, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
