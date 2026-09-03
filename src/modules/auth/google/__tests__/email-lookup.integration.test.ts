import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaAuthRepository } from '../../prisma-auth.repository';
import { prisma } from '../../../../shared/database';

/**
 * Regression guard for the account lookup behind Google sign-in.
 *
 * This is the one assertion in the auth suite that genuinely needs Postgres:
 * the bug it pins was invisible at every layer above the driver. The first
 * implementation used Prisma's `mode: 'insensitive'`, which compiles to a
 * Postgres `ILIKE` — so `_` and `%` inside the *supplied value* became pattern
 * wildcards. The value is a Google address, and Workspace allows `_`, so a user
 * holding `ad_in@adx.co` matched the row `admin@adx.co`, came back as exactly
 * one row (leaving the ambiguity guard silent) and was handed that account's
 * session.
 *
 * Unit tests could not catch it: the controller suite stubs the repository, so
 * the real predicate never ran. Hence a real row and a real query.
 *
 * Skips itself rather than failing when no database is reachable, so the rest
 * of the suite keeps its "runs anywhere" property.
 */

const MARKER = 'adx-google-lookup-regression';
const EMAIL = `${MARKER}@example.invalid`;
// Same length, with every `-` swapped for the single-character LIKE wildcard.
// Under ILIKE this matches EMAIL; under a true equality it matches nothing.
const WILDCARD_PROBE = `${MARKER.replace(/-/g, '_')}@example.invalid`;
const MOBILE = '+99912345678';

let databaseAvailable = false;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    return;
  }

  // Clear anything a previous crashed run left behind, then seed one row.
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.deleteMany({ where: { mobile: MOBILE } });
  await prisma.user.create({
    data: { email: EMAIL, mobile: MOBILE, name: 'Lookup Regression', isActive: true },
  });
});

afterAll(async () => {
  if (!databaseAvailable) return;
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.deleteMany({ where: { mobile: MOBILE } });
});

describe('findLoginUsersByEmailInsensitive', () => {
  it.runIf(process.env['SKIP_DB_TESTS'] !== 'true')(
    'matches the address regardless of case',
    async () => {
      if (!databaseAvailable) return;

      for (const probe of [EMAIL, EMAIL.toUpperCase(), 'Adx-Google-Lookup-Regression@Example.Invalid']) {
        const rows = await prismaAuthRepository.findLoginUsersByEmailInsensitive(probe);
        expect(rows, `expected ${probe} to match`).toHaveLength(1);
        expect(rows[0]!.email).toBe(EMAIL);
      }
    },
  );

  it('treats `_` as a literal, not a single-character wildcard', async () => {
    if (!databaseAvailable) return;

    const rows = await prismaAuthRepository.findLoginUsersByEmailInsensitive(WILDCARD_PROBE);

    // The takeover case: one wrong row here would be a silent account swap.
    expect(rows).toHaveLength(0);
  });

  it('treats `%` as a literal, not a multi-character wildcard', async () => {
    if (!databaseAvailable) return;

    for (const probe of ['%@example.invalid', `${MARKER.slice(0, 3)}%@example.invalid`, '%@%']) {
      const rows = await prismaAuthRepository.findLoginUsersByEmailInsensitive(probe);
      expect(rows, `expected ${probe} to match nothing`).toHaveLength(0);
    }
  });

  it('returns nothing for an address that simply does not exist', async () => {
    if (!databaseAvailable) return;

    const rows = await prismaAuthRepository.findLoginUsersByEmailInsensitive(
      'definitely-nobody@example.invalid',
    );

    expect(rows).toHaveLength(0);
  });
});
