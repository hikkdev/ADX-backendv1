import '../../config/load-env';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Listing, type Order, type Prisma, type User } from '../../generated/prisma';
import type { ITXClientDenyList } from '../../generated/prisma/runtime/client';

/**
 * Columns no read returns unless it asks for them by name (2 Oct 2026).
 *
 * Every one of these is a credential or the means to check one: a password
 * hash, the encrypted authenticator secret, an OTP / recovery-code / token
 * hash, an order's completion code. Before this a broad `include: { user:
 * true }` anywhere put the whole User row — hash and TOTP secret with it —
 * into whatever JSON the handler answered, and `GET /orders/:id` answered it to
 * the other parties of the order. With the omit, a read that genuinely needs
 * one of these opts back in with `omit: { field: false }` (or a `select`), so
 * the exceptions are the few lines in auth that check a credential, and they
 * are visible in review.
 */
export const GLOBAL_OMIT = {
  user: { passwordHash: true, totpSecretEnc: true },
  otp: { codeHash: true },
  recoveryCode: { codeHash: true },
  emailSignup: { codeHash: true },
  refreshToken: { tokenHash: true },
  passwordResetToken: { tokenHash: true },
  adminInvite: { tokenHash: true },
  order: {
    completionOtp: true,
    completionOtpPlain: true,
    // Order fraud screening (2 Oct 2026): not credentials, but ADX's alone —
    // the score, its signals, the review and the hold are never on a party's
    // screen (the party sees `reviewNotice`, a neutral line). Same mechanism:
    // the console's reads opt back in with `omit: ORDER_RISK_COLUMNS`.
    riskScore: true,
    riskSignals: true,
    riskBand: true,
    riskScoredAt: true,
    riskReviewStatus: true,
    riskReviewedById: true,
    riskReviewedAt: true,
    riskReviewNote: true,
    riskClearedSignalKeys: true,
    heldAt: true,
    heldById: true,
    holdReason: true,
    fraudCaseId: true,
  },
  // A listing's two private columns (3 Oct 2026). `qrToken` is what the site
  // sticker encodes — an installer's check-in is proved by scanning it, so a
  // party that is sent it can check in without standing at the spot.
  // `vehicleRcPayload` is the RC lookup's answer, which carries the vehicle
  // owner's name and address. Both rode along on every `include: { listing:
  // true }` — the advertiser's order list and the order detail among them.
  // The reads that compare a scan, or show the desk the RC, opt back in with
  // `omit: LISTING_PRIVATE_COLUMNS`.
  listing: { qrToken: true, vehicleRcPayload: true },
} as const satisfies Prisma.GlobalOmitConfig;

/**
 * The opt-back-in for a listing's private columns: the check-in comparisons
 * against the site QR and the console's review case. Spread as
 * `omit: LISTING_PRIVATE_COLUMNS`; what such a read returns leaves through a
 * mapper that names its fields, never as the raw row.
 */
export const LISTING_PRIVATE_COLUMNS = { qrToken: false, vehicleRcPayload: false } as const;

/**
 * Order fraud screening: the opt-back-in for the risk and hold columns, for
 * the console's reads (the order board, the admin detail, the review queue)
 * and the gates that ask whether an order is held. Spread as
 * `omit: ORDER_RISK_COLUMNS`. A party read never names it.
 */
export const ORDER_RISK_COLUMNS = {
  riskScore: false,
  riskSignals: false,
  riskBand: false,
  riskScoredAt: false,
  riskReviewStatus: false,
  riskReviewedById: false,
  riskReviewedAt: false,
  riskReviewNote: false,
  riskClearedSignalKeys: false,
  heldAt: false,
  heldById: false,
  holdReason: false,
  fraudCaseId: false,
} as const;

/** The names of those columns — what a redaction strips and a contract test looks for. */
export const ORDER_RISK_KEYS = Object.keys(ORDER_RISK_COLUMNS) as (keyof typeof ORDER_RISK_COLUMNS)[];

/**
 * The opt-back-in for the two User credential columns, for the reads that
 * check a password or an authenticator code, or report whether one is set
 * (`hasPassword`, the second-factor summary). Spread as `omit: USER_CREDENTIALS`.
 * Whatever such a read returns must still leave through a mapper that names
 * its fields — never as the raw row.
 */
export const USER_CREDENTIALS = { passwordHash: false, totpSecretEnc: false } as const;

/** A User as a default read returns it — without the credential columns. */
export type UserRead = Omit<User, keyof typeof GLOBAL_OMIT.user>;
/** A Listing as a default read returns it — without the site QR token and the RC answer. */
export type ListingRead = Omit<Listing, keyof typeof GLOBAL_OMIT.listing>;
/** An Order as a default read returns it — without the completion code. */
export type OrderRead = Omit<Order, keyof typeof GLOBAL_OMIT.order>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient; pool?: Pool };

/** The client this codebase runs on: the generated one, with `GLOBAL_OMIT` applied to its result types. */
export type AppPrismaClient = PrismaClient<{ adapter: PrismaPg; omit: typeof GLOBAL_OMIT }>;

/** What an interactive `prisma.$transaction(async (tx) => …)` hands its callback — the same omit applies inside. */
export type AppTransactionClient = Omit<AppPrismaClient, ITXClientDenyList>;

function createPrismaClient(): AppPrismaClient {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // node-postgres defaults this to 0, which means "wait forever" — an
    // exhausted pool then presents as a request that simply never returns
    // rather than an error anyone can act on. Fail in 10s instead.
    connectionTimeoutMillis: 10_000,
    // A query that has stopped making progress should not pin a connection
    // for the life of the process and starve every other request behind it.
    statement_timeout: 30_000,
    // Keeps the TCP connection alive through NAT/proxy idle timeouts. Without
    // it, an idle-but-pooled socket to a managed provider can be silently
    // dropped, and the next query pays a full reconnect (~800ms here) or
    // stalls until the OS notices.
    keepAlive: true,
    // Hold a floor of warm connections. Without `min`, pg-pool reaps every idle
    // connection once idleTimeoutMillis passes (`_isAboveMin` gates removal on
    // it), and opening a fresh one against a database in another region costs
    // 500-900ms. On an admin console that meant any click more than a few
    // seconds after the last one paid a cold connect — which is exactly what
    // "the sidebar is slow" was: not the query, the connection.
    min: 4,
    // Long enough that normal read/think/click pauses never drain the floor.
    idleTimeoutMillis: 5 * 60_000,
    // Neon's pooler endpoint multiplexes server-side, so a large client-side
    // pool buys nothing and just holds sockets open.
    max: 10,
  });
  globalForPrisma.pool = pool;
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter, omit: GLOBAL_OMIT });
}

/**
 * Shuts the database down so a one-shot process can exit.
 *
 * `$disconnect()` releases Prisma's side; the pool underneath it is ours, and
 * `min: 4` means pg-pool deliberately never reaps those four sockets. A seed
 * script that only disconnected therefore finished its work and then sat there
 * with a live event loop until somebody killed it — the work was done, the
 * process just never said so, which is indistinguishable from a hang.
 *
 * The server does not call this: it wants the pool for as long as it runs.
 */
export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
  await globalForPrisma.pool?.end();
  globalForPrisma.pool = undefined;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
