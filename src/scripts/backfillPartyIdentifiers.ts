/**
 * Party display ids, backfilled — every publisher, advertiser, print partner,
 * agent and person still without one (the console's "No identifier yet").
 *
 *   npm run backfill:party-ids -- --check   # counts only; issues nothing
 *   npm run backfill:party-ids -- --write   # issue them
 *
 * A write issues each row the identifier it would have received the day it
 * was made — oldest first, dated to the row's own `createdAt`, so
 * PUB-1909-2601 still means "joined 19 Sep 2026, first that day". `--check`
 * never reaches the allocator, which consumes a counter the moment it is
 * asked. Idempotent: a second write finds nothing to do.
 *
 * Prints counts and dates only — never a name or a number.
 */
import '../config/load-env';
import { closeDatabase } from '../shared/database';
import { redis } from '../shared/cache';
import { backfillPartyIdentifiers, IDENTIFIED_PARTIES, type IdentifiedParty } from '../modules/identifiers';

const LABEL: Record<IdentifiedParty, string> = {
  PUBLISHER: 'Publishers',
  ADVERTISER: 'Advertisers',
  PARTNER: 'Print partners',
  AGENT: 'Agents',
  USER: 'People (accounts)',
};

const USAGE = [
  'Usage:',
  '  npm run backfill:party-ids -- --check   # count the rows without a display id; issues nothing',
  '  npm run backfill:party-ids -- --write   # issue them, oldest first, dated to each row\'s createdAt',
].join('\n');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Sep 2026", in IST — the day an identifier names. */
function day(at: Date): string {
  const [year, month, date] = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  return `${date} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

function span(oldest: Date | null, newest: Date | null): string {
  if (!oldest || !newest) return '';
  const [from, to] = [day(oldest), day(newest)];
  return `   made ${from === to ? from : `${from} – ${to}`}`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const write = process.argv.includes('--write');
  if (check === write) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  console.log(check ? 'Party display ids — check only, nothing issued.' : 'Party display ids — issuing.');
  let missing = 0;
  let assigned = 0;
  let remaining = 0;
  for (const party of IDENTIFIED_PARTIES) {
    const report = await backfillPartyIdentifiers(party, { check });
    missing += report.missing;
    assigned += report.assigned;
    remaining += report.remaining;
    const outcome = check ? '' : `   issued ${String(report.assigned).padStart(5)}   still without ${String(report.remaining).padStart(5)}`;
    console.log(`${LABEL[party].padEnd(18)} ${String(report.missing).padStart(5)} without a display id${outcome}${span(report.oldest, report.newest)}`);
  }
  console.log(
    check
      ? `Total: ${missing} would be issued. Re-run with --write to issue them.`
      : `Total: ${assigned} issued; ${remaining} still without one.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
    // The modules imported above open the shared ioredis client at load, and
    // its socket keeps the event loop alive after the work is done.
    redis.disconnect();
  });
