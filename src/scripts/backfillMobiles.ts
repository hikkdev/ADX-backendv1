/**
 * Stored mobiles, brought to the one form — `+91` and ten digits.
 *
 *   npm run backfill:mobiles -- --check   # report only; writes nothing
 *   npm run backfill:mobiles -- --write   # fix the rows that can be fixed
 *
 * The OTP door and every party door since QR-13 store `+91XXXXXXXXXX`; rows
 * written before then may hold the number as typed (`9507842149`), and every
 * lookup by number is an exact match — the publisher and advertiser doors,
 * the imports, the fraud and lead checks all ask for `+91…` and walk past
 * such a row. Four columns: `Publisher.mobile` and `Advertiser.mobile`
 * (unique), `PrintPartner.mobile` (not unique) and `User.mobile` (unique —
 * an agent's number lives there).
 *
 * The decisions are `lib/mobile-backfill.ts`: a row is fixed only when the
 * canonical form is free; a clash on a unique column, or a number that
 * cannot be read, is reported and left for a person. `--write` re-checks
 * each unique column just before the update and moves a row only while it
 * still holds the number that was read. Idempotent: a second run finds
 * nothing to fix.
 *
 * Reports parties by name and display id, never by number.
 */
import '../config/load-env';
import { closeDatabase, prisma } from '../shared/database';
import { canonicalForm, partyLabel, planMobileFixes, type MobileRow } from './lib/mobile-backfill';

/** A row off the canonical form, as the report names it. */
type OffFormRow = MobileRow & { label: string; note: string };
type Holder = MobileRow & { label: string };

type Table = {
  label: string;
  column: string;
  unique: boolean;
  /** Rows whose mobile is not `+91` and ten digits, oldest first. */
  offForm(): Promise<OffFormRow[]>;
  /** Whoever already holds any of these numbers (unique columns only). */
  holders(values: string[]): Promise<Holder[]>;
  /** Moves one row, only while it still holds the number read. */
  apply(id: string, from: string, to: string): Promise<boolean>;
};

type RawParty = { id: string; mobile: string; name: string | null; displayId: string | null; linked: boolean };

const accountNote = (linked: boolean) => (linked ? '[linked to an account]' : '[no account yet]');

const TABLES: Table[] = [
  {
    label: 'Publishers',
    column: 'Publisher.mobile',
    unique: true,
    offForm: async () =>
      (await prisma.$queryRaw<RawParty[]>`
        SELECT "id", "mobile", "name", "displayId", ("userId" IS NOT NULL) AS "linked"
        FROM "Publisher" WHERE "mobile" !~ '^[+]91[0-9]{10}$' ORDER BY "createdAt"
      `).map((row) => ({ id: row.id, mobile: row.mobile, label: partyLabel(row.name, row.displayId), note: accountNote(row.linked) })),
    holders: async (values) =>
      (await prisma.publisher.findMany({ where: { mobile: { in: values } }, select: { id: true, mobile: true, name: true, displayId: true } }))
        .map((row) => ({ id: row.id, mobile: row.mobile, label: `publisher ${partyLabel(row.name, row.displayId)}` })),
    apply: async (id, from, to) => (await prisma.publisher.updateMany({ where: { id, mobile: from }, data: { mobile: to } })).count === 1,
  },
  {
    label: 'Advertisers',
    column: 'Advertiser.mobile',
    unique: true,
    offForm: async () =>
      (await prisma.$queryRaw<RawParty[]>`
        SELECT "id", "mobile", "name", "displayId", ("userId" IS NOT NULL) AS "linked"
        FROM "Advertiser" WHERE "mobile" !~ '^[+]91[0-9]{10}$' ORDER BY "createdAt"
      `).map((row) => ({ id: row.id, mobile: row.mobile, label: partyLabel(row.name, row.displayId), note: accountNote(row.linked) })),
    holders: async (values) =>
      (await prisma.advertiser.findMany({ where: { mobile: { in: values } }, select: { id: true, mobile: true, name: true, displayId: true } }))
        .map((row) => ({ id: row.id, mobile: row.mobile, label: `advertiser ${partyLabel(row.name, row.displayId)}` })),
    apply: async (id, from, to) => (await prisma.advertiser.updateMany({ where: { id, mobile: from }, data: { mobile: to } })).count === 1,
  },
  {
    label: 'Print partners',
    column: 'PrintPartner.mobile',
    // Not unique: two shops may share a number, so nothing here can clash.
    unique: false,
    offForm: async () =>
      (await prisma.$queryRaw<RawParty[]>`
        SELECT "id", "mobile", "name", "displayId", TRUE AS "linked"
        FROM "PrintPartner" WHERE "mobile" !~ '^[+]91[0-9]{10}$' ORDER BY "createdAt"
      `).map((row) => ({ id: row.id, mobile: row.mobile, label: partyLabel(row.name, row.displayId), note: '' })),
    holders: async () => [],
    apply: async (id, from, to) => (await prisma.printPartner.updateMany({ where: { id, mobile: from }, data: { mobile: to } })).count === 1,
  },
  {
    label: 'People (accounts; an agent\'s number lives here)',
    column: 'User.mobile',
    unique: true,
    offForm: async () =>
      (await prisma.$queryRaw<(RawParty & { agentDisplayId: string | null })[]>`
        SELECT u."id", u."mobile", u."name", u."displayId", TRUE AS "linked", a."displayId" AS "agentDisplayId"
        FROM "User" u LEFT JOIN "AgentProfile" a ON a."userId" = u."id"
        WHERE u."mobile" !~ '^[+]91[0-9]{10}$' ORDER BY u."createdAt"
      `).map((row) => ({ id: row.id, mobile: row.mobile, label: partyLabel(row.name, row.displayId), note: row.agentDisplayId ? `[agent ${row.agentDisplayId}]` : '' })),
    // K-B1: a number is taken when it is any account's sign-in number or any contact row's.
    holders: async (values) => {
      const [users, contacts] = await Promise.all([
        prisma.user.findMany({ where: { mobile: { in: values } }, select: { id: true, mobile: true, name: true, displayId: true } }),
        prisma.userContact.findMany({ where: { kind: 'PHONE', value: { in: values } }, select: { id: true, value: true, user: { select: { name: true, displayId: true } } } }),
      ]);
      return [
        ...users.map((row) => ({ id: row.id, mobile: row.mobile, label: `account ${partyLabel(row.name, row.displayId)}` })),
        ...contacts.map((row) => ({ id: `contact:${row.id}`, mobile: row.value, label: `a contact number on ${partyLabel(row.user.name, row.user.displayId)}` })),
      ];
    },
    apply: async (id, from, to) => (await prisma.user.updateMany({ where: { id, mobile: from }, data: { mobile: to } })).count === 1,
  },
];

const USAGE = [
  'Usage:',
  '  npm run backfill:mobiles -- --check   # report the numbers not stored as +91 and ten digits; writes nothing',
  '  npm run backfill:mobiles -- --write   # fix the ones that can be fixed; clashes and unreadable numbers are left for a person',
].join('\n');

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002';

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const write = process.argv.includes('--write');
  if (check === write) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  console.log(check ? 'Mobile numbers — check only, nothing written. The stored form is +91 and ten digits.' : 'Mobile numbers — fixing.');
  const total = { fixed: 0, clash: 0, unparseable: 0, skipped: 0 };

  for (const table of TABLES) {
    const rows = await table.offForm();
    const targets = [...new Set(rows.map((row) => canonicalForm(row.mobile)).filter((to): to is string => to !== null))];
    const held = table.unique && targets.length > 0 ? await table.holders(targets) : [];
    const { decisions, counts } = planMobileFixes(rows, { unique: table.unique, existing: held });
    const labels = new Map<string, string>([...held.map((holder) => [holder.id, holder.label] as const), ...rows.map((row) => [row.id, row.label] as const)]);

    console.log('');
    console.log(
      `${table.label} — ${table.column}${table.unique ? ' (unique)' : ''}: ${rows.length} not in +91 form` +
        (rows.length > 0 ? ` → ${counts.fix} ${check ? 'would be fixed' : 'to fix'}, ${counts.clash} clash, ${counts.unparseable} unparseable` : ''),
    );

    for (const decision of decisions) {
      const { row } = decision;
      const tail = row.note ? ` ${row.note}` : '';
      if (decision.kind === 'clash') {
        total.clash += 1;
        console.log(`  clash        ${row.label}${tail} — its +91 form is already ${decision.heldBy.map((id) => labels.get(id) ?? id).join('; ')}; left alone`);
        continue;
      }
      if (decision.kind === 'unparseable') {
        total.unparseable += 1;
        console.log(`  unparseable  ${row.label}${tail} — not a ten-digit Indian number; left alone`);
        continue;
      }
      if (decision.kind !== 'fix') continue;
      if (check) {
        total.fixed += 1;
        console.log(`  would fix    ${row.label}${tail}`);
        continue;
      }
      // Re-checked at the moment of writing: a sign-in may have taken the number since the read.
      const taken = table.unique ? (await table.holders([decision.to])).filter((holder) => holder.id !== row.id) : [];
      if (taken.length > 0) {
        total.clash += 1;
        console.log(`  clash        ${row.label}${tail} — its +91 form is now ${taken.map((holder) => holder.label).join('; ')}; left alone`);
        continue;
      }
      try {
        if (await table.apply(row.id, row.mobile, decision.to)) {
          total.fixed += 1;
          console.log(`  fixed        ${row.label}${tail}`);
        } else {
          total.skipped += 1;
          console.log(`  skipped      ${row.label}${tail} — its number changed since it was read`);
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        total.clash += 1;
        console.log(`  clash        ${row.label}${tail} — its +91 form was taken while this ran; left alone`);
      }
    }
  }

  console.log('');
  console.log(
    check
      ? `Total: ${total.fixed} would be fixed; ${total.clash} clash(es) and ${total.unparseable} unparseable need a person.${total.fixed > 0 ? ' Re-run with --write to apply.' : ''}`
      : `Total: ${total.fixed} fixed; ${total.clash} clash(es) and ${total.unparseable} unparseable need a person${total.skipped ? `; ${total.skipped} skipped (changed while this ran — run again)` : ''}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // Only the database is opened here — nothing on this path loads the shared Redis client.
  .finally(() => closeDatabase());
