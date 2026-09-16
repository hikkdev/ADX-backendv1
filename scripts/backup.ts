/**
 * The nightly dump — Lot E (decision 95: RPO 1 h / RTO 4 h).
 *
 *   npm run backup
 *
 * pg_dump (custom format) through the direct URL, gzipped, sealed with
 * AES-256-GCM under BACKUP_KEY and uploaded to private storage as
 * `backups/<instant>.dump.enc`; then every dump older than 35 days is
 * removed. Prints names and sizes only — never a URL, never the key.
 *
 * Neon's own PITR is the first line (that is the RPO); this is the copy that
 * survives Neon, and the monthly drill (jobs/restore-drill.job.ts) is what
 * proves it can be opened. See docs/runbooks/backup-restore.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { env } from '../src/config/env';
import { closeDatabase } from '../src/shared/database';
import { redis } from '../src/shared/cache';
import {
  BACKUP_FOLDER,
  ROTATION_DAYS,
  dumpName,
  encryptPlain,
  gzipFile,
  olderThan,
  parseBackupKey,
  pgDump,
} from '../src/shared/backup';
import { deleteStoredFile, listPrivateFiles, uploadFile } from '../src/shared/storage';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main(): Promise<void> {
  const now = new Date();
  const key = parseBackupKey(env.BACKUP_KEY);
  const url = env.DIRECT_URL ?? env.DATABASE_URL;
  const name = dumpName(now);
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'adx-backup-'));
  const raw = path.join(workDir, 'raw.dump');
  const gz = path.join(workDir, 'raw.dump.gz');
  const sealed = path.join(workDir, name);

  try {
    console.log(`Dumping the database (direct endpoint${env.DIRECT_URL ? '' : ' not set; using DATABASE_URL'})…`);
    await pgDump(url, raw);
    const rawSize = (await fs.promises.stat(raw)).size;
    console.log(`  dump      ${mb(rawSize)}`);

    await gzipFile(raw, gz);
    await encryptPlain(gz, sealed, key);
    const sealedSize = (await fs.promises.stat(sealed)).size;
    console.log(`  sealed    ${mb(sealedSize)}  ${name}`);

    const uploaded = await uploadFile({
      filePath: sealed,
      filename: name,
      mimeType: 'application/octet-stream',
      folder: BACKUP_FOLDER,
      baseUrl: '',
      visibility: 'PRIVATE',
    });
    console.log(`  stored    ${uploaded.provider}  ${BACKUP_FOLDER}/${name}`);

    const all = await listPrivateFiles(BACKUP_FOLDER);
    const expired = all.filter((file) => olderThan(file.name, ROTATION_DAYS, now));
    for (const file of expired) {
      await deleteStoredFile(file.storageKey);
      console.log(`  rotated   ${file.name}  (${mb(file.size)})`);
    }
    console.log(`Done: ${all.length - expired.length} dump(s) kept, ${expired.length} removed (rotation ${ROTATION_DAYS} days).`);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main()
  .then(async () => {
    await closeDatabase();
    redis.disconnect();
  })
  .catch(async (err: unknown) => {
    console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    await closeDatabase().catch(() => undefined);
    redis.disconnect();
    process.exit(1);
  });
