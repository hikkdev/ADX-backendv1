import { prisma } from '../../shared/database';
import type { AuthRepository } from './auth.repository';

// The full join every non-publisher login response is built from.
const loginInclude = {
  roles: true,
  agentProfile: true,
  publisherProfile: { include: { kyc: true } },
  advertiserProfile: true,
} as const;

// Prisma's default strategy issues one query per relation — five here, run
// sequentially. Against a database in another region that was ~85ms each, so
// the login lookup alone cost ~430ms of pure round trip. `join` collapses them
// into a single LATERAL JOIN: measured 5 queries/765ms -> 1 query/124ms.
// Applied only to the login reads, which are the hot path and return one row.
const JOIN = { relationLoadStrategy: 'join' } as const;

export const prismaAuthRepository: AuthRepository = {
  findLoginUserById(userId: string) {
    return prisma.user.findUnique({ ...JOIN, where: { id: userId }, include: loginInclude }) as never;
  },

  findLoginUserByEmail(email: string) {
    return prisma.user.findUnique({ ...JOIN, where: { email }, include: loginInclude }) as never;
  },

  async findLoginUsersByEmailInsensitive(email: string) {
    // Deliberately NOT Prisma's `mode: 'insensitive'`. That compiles to a
    // Postgres ILIKE, which treats `_` and `%` inside the *value* as pattern
    // wildcards — and here the value is an attacker-choosable Google address.
    // A Workspace user holding `ad_in@adx.co` would match the row
    // `admin@adx.co`, return exactly one row (so the ambiguity guard stays
    // silent), and be handed that account's session.
    //
    // `lower() = lower()` is a true equality with no pattern semantics. The id
    // list is fetched first so the typed `loginInclude` join still comes from
    // the query builder rather than hand-written SQL.
    //
    // `LIMIT 2` is all the caller needs: one row is a match, two is ambiguous
    // and gets refused. See the interface for why two can exist at all.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE lower("email") = lower(${email}) LIMIT 2
    `;
    if (rows.length === 0) return [];

    return prisma.user.findMany({
      ...JOIN,
      where: { id: { in: rows.map((row) => row.id) } },
      include: loginInclude,
    }) as never;
  },

  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  findUserWithRoles(userId: string) {
    // Refresh only needs the roles to re-sign an access token, so it
    // deliberately skips the profile joins.
    return prisma.user.findUnique({ where: { id: userId }, include: { roles: true } }) as never;
  },

  findPublisherLoginUserById(userId: string) {
    // No agentProfile and no KYC join — the publisher app does not render them.
    return prisma.user.findUnique({
      ...JOIN,
      where: { id: userId },
      include: { roles: true, publisherProfile: true },
    }) as never;
  },

  findByMobileWithRoles(mobile: string) {
    return prisma.user.findUnique({ where: { mobile }, include: { roles: true } }) as never;
  },

  findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  recordLogin(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  },

  setPasswordHash(userId: string, passwordHash: string) {
    return prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  },

  setName(userId: string, name: string) {
    return prisma.user.update({ where: { id: userId }, data: { name } });
  },
};
