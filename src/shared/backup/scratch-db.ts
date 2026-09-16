import { Client } from 'pg';
import { databaseNameOf, withDatabase } from './database-url';

/**
 * A one-shot connection to a database that is not the app's — the scratch
 * database a dump is restored into — Lot E (decision 95).
 *
 * Deliberately not the shared Prisma client: that one is bound to
 * DATABASE_URL, and the whole point of a drill is that it never touches it.
 */

/** Runs one query on `url` and closes the connection. */
export async function queryDatabase<T extends Record<string, unknown>>(url: string, sql: string): Promise<T[]> {
  const client = new Client({ connectionString: url, statement_timeout: 10 * 60 * 1000 });
  await client.connect();
  try {
    const result = await client.query<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Creates `database` on the server `adminUrl` points at, if it is not there.
 * Connects to the admin URL's own database to do so (CREATE DATABASE cannot
 * run inside the database being created, and needs no transaction).
 */
export async function ensureDatabase(adminUrl: string, database: string): Promise<'created' | 'exists'> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('A scratch database name may only contain letters, digits and underscores');
  }
  const existing = await queryDatabase<{ one: number }>(
    adminUrl,
    `SELECT 1 AS one FROM pg_database WHERE datname = '${database}'`,
  );
  if (existing.length > 0) return 'exists';
  await queryDatabase(adminUrl, `CREATE DATABASE "${database}"`);
  return 'created';
}

/**
 * Whether `candidate` names the production database. On the name alone,
 * deliberately: a scratch database called "adx" on some other host is a
 * mistake waiting to be made the day the host is the same, so the rule is
 * that the scratch database is never called what production is called. A
 * drill or a restore into it is refused before a single byte moves.
 *
 * E7-2 (Lot E verifier): fails closed. A URL that does not parse, or names
 * no database, answers `true` — "refuse" — rather than `false`; the guard
 * cannot tell such a target apart from production, and a restore is the
 * one operation where not knowing must mean not doing.
 */
export function isProductionDatabase(candidate: string, production: string): boolean {
  const target = databaseNameOf(candidate);
  const live = databaseNameOf(production);
  if (!target || !live) return true;
  return target === live;
}

export { withDatabase };
