/**
 * How a dump is named in storage — Lot E (decision 95).
 *
 * `backups/<instant>.dump.enc`, the instant in UTC with the colons swapped
 * for hyphens so the name is legal on every filesystem and object store, and
 * lexicographic order is chronological order. The rotation reads the date
 * off the name rather than trusting storage metadata, which a copy between
 * buckets would reset.
 */

/** The private-storage folder the dumps live under: `private/backups/…` in R2, `private-uploads/private/backups/…` locally. */
export const BACKUP_FOLDER = 'backups';
/** Decision 95: five weeks of nightlies. */
export const ROTATION_DAYS = 35;

const NAME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.dump\.enc$/;

export function dumpName(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/:/g, '-')}Z.dump.enc`;
}

export const isDumpName = (name: string): boolean => NAME.test(name);

export function dumpDate(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/** True for a dump older than `days` at `now`; false for anything that is not a dump. */
export function olderThan(name: string, days: number, now: Date): boolean {
  const at = dumpDate(name);
  if (!at) return false;
  return now.getTime() - at.getTime() > days * 24 * 60 * 60 * 1000;
}

/** Newest first. Names that are not dumps are dropped. */
export function newestFirst<T extends { name: string }>(items: T[]): T[] {
  return items.filter((item) => isDumpName(item.name)).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}
