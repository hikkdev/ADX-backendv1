/**
 * Restore a sealed dump into a scratch database — Lot E (decision 95).
 *
 *   npm run restore -- <scratch-database-name> [dump-name]
 *
 * Downloads the named dump (the newest when none is given) from private
 * storage, unseals it with BACKUP_KEY, creates the scratch database on the
 * same server as DIRECT_URL / DATABASE_URL if it is not there, and
 * pg_restores into it. The scratch database is named on the command line so
 * the person running it has typed a name that is not production's; a name
 * that IS production's is refused before anything is downloaded.
 *
 * Prints names and sizes only — never a URL, never the key. To make the
 * restored copy the live database, follow the runbook: this script never
 * touches the production name. See docs/runbooks/backup-restore.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { env } from '../src/config/env';
import { closeDatabase } from '../src/shared/database';
import { redis } from '../src/shared/cache';
import {
  BACKUP_FOLDER,
  databaseNameOf,
  decryptToPlain,
  ensureDatabase,
  gunzipFile,
  isDumpName,
  newestFirst,
  parseBackupKey,
  pgRestore,
  queryDatabase,
  withDatabase,
} from '../src/shared/backup';
import { downloadPrivateFile, listPrivateFiles } from '../src/shared/storage';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main(): Promise<void> {
  const [target, requested] = process.argv.slice(2);
  if (!target) throw new Error('Usage: npm run restore -- <scratch-database-name> [dump-name]');
  if (requested && !isDumpName(requested)) throw new Error(`"${requested}" is not a dump name (expected <instant>.dump.enc)`);

  const adminUrl = env.DIRECT_URL ?? env.DATABASE_URL;
  const production = databaseNameOf(adminUrl);
  if (!production) throw new Error('The database URL names no database');
  // Both URLs are checked: DIRECT_URL and DATABASE_URL should name the same
  // database, and the day they do not, neither name is a scratch name.
  const liveNames = new Set([production, databaseNameOf(env.DATABASE_URL), env.DIRECT_URL ? databaseNameOf(env.DIRECT_URL) : null].filter(Boolean));
  if (liveNames.has(target)) {
    throw new Error(`"${target}" is the production database name. A restore only ever goes into a scratch database; see the runbook for a failover.`);
  }
  const key = parseBackupKey(env.BACKUP_KEY);

  const dumps = newestFirst(await listPrivateFiles(BACKUP_FOLDER));
  const chosen = requested ? dumps.find((file) => file.name === requested) : dumps[0];
  if (!chosen) throw new Error(requested ? `No dump named ${requested} in ${BACKUP_FOLDER}/` : `No dump in ${BACKUP_FOLDER}/`);
  console.log(`Restoring ${chosen.name} (${mb(chosen.size)}) into "${target}"…`);

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'adx-restore-'));
  const sealed = path.join(workDir, chosen.name);
  const gz = path.join(workDir, 'dump.gz');
  const plain = path.join(workDir, 'restore.dump');

  try {
    await downloadPrivateFile(chosen.storageKey, sealed);
    await decryptToPlain(sealed, gz, key);
    await gunzipFile(gz, plain);
    console.log(`  unsealed  ${mb((await fs.promises.stat(plain)).size)}`);

    const created = await ensureDatabase(adminUrl, target);
    console.log(`  database  "${target}" ${created}`);

    const scratchUrl = withDatabase(adminUrl, target);
    const { warnings } = await pgRestore(scratchUrl, plain);
    if (warnings) console.log(`  warnings  ${warnings.split('\n')[0]}`);

    const [row] = await queryDatabase<{ users: string; legs: string }>(
      scratchUrl,
      'SELECT (SELECT COUNT(*) FROM "User") AS users, (SELECT COUNT(*) FROM "LedgerLeg") AS legs',
    );
    console.log(`  restored  ${row?.users ?? '?'} users, ${row?.legs ?? '?'} ledger legs`);
    console.log(`Done. Run the ledger verify against "${target}" before trusting it (the runbook has the two queries).`);
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
    console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    await closeDatabase().catch(() => undefined);
    redis.disconnect();
    process.exit(1);
  });
