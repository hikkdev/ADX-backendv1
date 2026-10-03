/**
 * ST-2 (28 Sep 2026) — the papers filed on listings before ST-2, made private.
 *
 *   npm run storage:privatise-listing-documents -- --check   # reports, writes nothing
 *   npm run storage:privatise-listing-documents              # moves and rewrites
 *
 * The owner said "Sure, go ahead, build it" to a listing's venue papers and
 * audience reports becoming private files. From ST-2 on, `supply` adopts the
 * file a document names at the moment it is filed; this does the same for
 * the documents already there. It selects files by being named from
 * `ListingDocument.url` — not by purpose, since papers were uploaded as
 * VERIFICATION, OTHER or LISTING_PHOTO — and for each PUBLIC one:
 *
 *   - copies the object to `private/listing-documents/<name>` (R2 or disk),
 *   - re-files the row as LISTING_DOCUMENT, PRIVATE, with the new
 *     `storageKey` and `url = <base>/api/v1/files/:id`,
 *   - deletes the public object (copy first, delete after), and
 *   - rewrites every `ListingDocument.url` that named it to the new URL.
 *
 * An outside link is left alone; a file that is already private only has
 * stale document URLs pointed at it. Idempotent: a second run moves and
 * rewrites nothing.
 *
 * `<base>` is BASE_URL; without it (development), the host the file's own
 * `/uploads/…` URL was recorded under, which is the API that served it.
 */
import '../config/load-env';
import { env } from '../config/env';
import { closeDatabase, prisma, type UploadedFile } from '../shared/database';
import { redis } from '../shared/cache';
import { privatiseListingDocuments } from '../modules/uploads';

function baseUrlFor(file: UploadedFile): string {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '');
  const local = /^(https?:\/\/[^/]+)\/uploads\//i.exec(file.url);
  return local ? local[1]! : `http://localhost:${env.PORT}`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const started = Date.now();
  const documents = await prisma.listingDocument.findMany({ select: { id: true, url: true }, orderBy: { submittedAt: 'asc' } });
  const report = await privatiseListingDocuments({
    documents,
    check,
    baseUrlFor,
    rewrite: async (documentIds, url) => {
      await prisma.listingDocument.updateMany({ where: { id: { in: documentIds } }, data: { url } });
    },
  });
  const lines = [
    check ? 'storage:privatise-listing-documents --check — nothing was written.' : 'storage:privatise-listing-documents',
    `BASE_URL                     ${env.BASE_URL ? 'set' : `not set — the host each file was recorded under (fallback http://localhost:${env.PORT})`}`,
    `Listing documents            ${report.documents}`,
    `Outside links (left alone)   ${report.outsideLinks}`,
    `Files already private        ${report.alreadyPrivate}`,
    `Files ${check ? 'to move private  ' : 'moved private    '}      ${report.adopted}`,
    `Document URLs ${check ? 'to rewrite' : 'rewritten '}     ${report.rewritten}`,
    `Skipped                      ${report.skipped.length}`,
    ...report.skipped.map((row) => `  ${row.fileId ?? '-'}  ${row.reason}  (${row.url})`),
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
