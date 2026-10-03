/**
 * ST-1 (28 Sep 2026) — hidden photo data stripped from the public images
 * stored before the intake did it.
 *
 *   npm run storage:strip-existing -- --check   # reads every public image, writes nothing
 *   npm run storage:strip-existing              # rewrites the ones that carry metadata
 *
 * The owner asked how media is kept ("security, data collection, ease of
 * storage") and said "Sure, go ahead, build it" to ST-1: every PUBLIC image
 * loses its EXIF, XMP, IPTC and PNG text at the door (`uploads/image-clean.ts`).
 * This walks the files that came in before — every PUBLIC JPEG, PNG, WebP and
 * HEIC row, in pages — and re-encodes each one that still carries metadata
 * the same way (oriented, same format, same size, JPEG/WebP at quality 90),
 * written back over the same object: R2 at the same key, the disk at the
 * same file. Every URL that names it keeps working. Geo-stamped photos
 * (GC-1) are skipped — their GPS is deliberate. A file it cannot read or
 * decode is reported and left alone. Idempotent: a second run finds nothing.
 *
 * An R2 public URL may sit behind a CDN cache; the old bytes can be served
 * from the edge until it expires.
 */
import '../config/load-env';
import { closeDatabase } from '../shared/database';
import { redis } from '../shared/cache';
import { stripExistingPublicImages } from '../modules/uploads';

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const started = Date.now();
  const report = await stripExistingPublicImages({ check });
  const lines = [
    check ? 'storage:strip-existing --check — nothing was written.' : 'storage:strip-existing',
    `Public images looked at   ${report.scanned}`,
    `Geo-stamped (kept as is)  ${report.geoStamped}`,
    `Already clean             ${report.clean}`,
    `Carrying metadata         ${report.carriedMetadata}${check ? '  (would be rewritten)' : ''}`,
    ...(check ? [] : [`Rewritten                 ${report.stripped}`]),
    `Skipped                   ${report.skipped.length}`,
    ...report.skipped.map((row) => `  ${row.id}  ${row.reason}`),
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
  ];
  console.log(lines.join('\n'));
  await closeDatabase();
  // The shared ioredis client opened at import keeps the event loop alive otherwise.
  redis.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
