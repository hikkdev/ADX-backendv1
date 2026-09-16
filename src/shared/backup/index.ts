/**
 * Backup primitives — Lot E (decision 95). Used by scripts/backup.ts,
 * scripts/restore.ts and the restore drill in `modules/ops`; nothing here
 * knows a business table.
 */
export { parseBackupKey, encryptPlain, decryptToPlain } from './crypto';
export { gzipFile, gunzipFile } from './compress';
export { BACKUP_FOLDER, ROTATION_DAYS, dumpName, dumpDate, isDumpName, olderThan, newestFirst } from './dump-names';
export { databaseNameOf, withDatabase, redactUrl } from './database-url';
export { pgDump, pgRestore } from './pg-tools';
export { queryDatabase, ensureDatabase, isProductionDatabase } from './scratch-db';
