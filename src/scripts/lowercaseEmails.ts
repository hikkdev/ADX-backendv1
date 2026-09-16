/**
 * Lot K2 — folds legacy `User.email` and EMAIL `UserContact.value` rows to
 * lower case, one off.
 *
 * K-B1 lower-cases every email on the way in, and `findIdentityHolder`
 * compares case-insensitively; but the unique indexes are case-sensitive and
 * rows written before K-B1 may carry capitals. Two rows that differ only by
 * case are reported and left alone — that is an account-confusion case for a
 * person to settle (auth's Google sign-in already refuses such pairs), never
 * for a script to pick a winner.
 *
 * Usage:
 *   npx tsx src/scripts/lowercaseEmails.ts            # report only
 *   npx tsx src/scripts/lowercaseEmails.ts --write    # fold the rows
 *
 * Never run by the build; run once by hand after the K2 migration, and again
 * only if a legacy import lands capitals. Idempotent.
 */
import '../config/load-env';
import { closeDatabase, prisma } from '../shared/database';
import { redis } from '../shared/cache';

async function main(): Promise<void> {
  const write = process.argv.includes('--write');

  const users = await prisma.$queryRaw<{ id: string; email: string }[]>`
    SELECT "id", "email" FROM "User" WHERE "email" IS NOT NULL AND "email" <> lower("email")
  `;
  const contacts = await prisma.$queryRaw<{ id: string; value: string }[]>`
    SELECT "id", "value" FROM "UserContact" WHERE "kind" = 'EMAIL' AND "value" <> lower("value")
  `;

  console.log(`${users.length} user email(s) and ${contacts.length} contact email(s) carry capitals.`);

  let folded = 0;
  let clashes = 0;
  for (const row of users) {
    const lower = row.email.toLowerCase();
    const holders = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE lower("email") = ${lower} AND "id" <> ${row.id}
    `;
    const contactHolder = await prisma.userContact.findUnique({ where: { kind_value: { kind: 'EMAIL', value: lower } }, select: { id: true } });
    if (holders.length > 0 || contactHolder) {
      clashes += 1;
      console.warn(`CLASH  user ${row.id} ${row.email}: ${lower} is also ${holders.length ? `user ${holders.map((h) => h.id).join(', ')}` : `contact ${contactHolder!.id}`} — left alone`);
      continue;
    }
    if (write) await prisma.user.update({ where: { id: row.id }, data: { email: lower } });
    folded += 1;
    console.log(`${write ? 'FOLDED' : 'WOULD FOLD'} user ${row.id} ${row.email} -> ${lower}`);
  }
  for (const row of contacts) {
    const lower = row.value.toLowerCase();
    const primary = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE lower("email") = ${lower}`;
    const contact = await prisma.userContact.findUnique({ where: { kind_value: { kind: 'EMAIL', value: lower } }, select: { id: true } });
    if (primary.length > 0 || (contact && contact.id !== row.id)) {
      clashes += 1;
      console.warn(`CLASH  contact ${row.id} ${row.value}: ${lower} is also ${primary.length ? `user ${primary.map((h) => h.id).join(', ')}` : `contact ${contact!.id}`} — left alone`);
      continue;
    }
    if (write) await prisma.userContact.update({ where: { id: row.id }, data: { value: lower } });
    folded += 1;
    console.log(`${write ? 'FOLDED' : 'WOULD FOLD'} contact ${row.id} ${row.value} -> ${lower}`);
  }

  console.log(`${write ? 'Folded' : 'Would fold'} ${folded}; ${clashes} clash(es) need a person.${write ? '' : ' Re-run with --write to apply.'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
    redis.disconnect();
  });
