import { Prisma, prisma } from '../../shared/database';
import type {
  Brand,
  Gender,
  RefundDestination,
  RefundReason,
  RefundRequestStatus,
  Wallet,
  WalletEntry,
  WalletHold,
  WalletRefundRequest,
} from '../../shared/database';
import {
  countsFrom,
  listArgs,
  pageArgs,
  toListPage,
  toPage,
  type ListQuery,
  type PageQuery,
} from '../../shared/pagination';
import {
  REFUND_REQUEST_STATUSES,
  TOP_UP_DESK_STATUSES,
  type TopUpDeskQuery,
  type AccountInput,
  type AdvertiserFunnel,
  type AdvertiserFunnelRow,
  type AdvertiserRosterQuery,
  type AdvertisersRepository,
  type CreateAcceptanceInput,
  type CreateAdvertiserInput,
  type DormantWallet,
  type Money,
  type NewTopUp,
  type RefundRequestDeskRow,
  type RefundRequestPatch,
  type UpdateAdvertiserInput,
  type WalletSnapshot,
} from './advertisers.repository';

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Two decimal places, always — `"1200"` and `"1200.5"` are the same money. */
const money = (value: Prisma.Decimal | number | string): Money =>
  new D(value).toFixed(2);

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Links the person who has now signed in to the profile — and, N3-B, to the
 * KYC record the desk may already have made against the profile alone (an
 * advertiser ops created on the console has no app account; its record
 * carries `advertiserProfileId` only). The link is skipped, never forced,
 * when the user already owns a legacy user-keyed record: `advertiserId` is
 * unique on the table, and the desk's record stays reachable by the profile.
 */
async function attachUser(advertiserId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const advertiser = await tx.advertiser.update({ where: { id: advertiserId }, data: { userId } });
    const legacy = await tx.advertiserKyc.findUnique({ where: { advertiserId: userId }, select: { id: true } });
    if (!legacy) {
      await tx.advertiserKyc.updateMany({ where: { advertiserProfileId: advertiserId, advertiserId: null }, data: { advertiserId: userId } });
    }
    return advertiser;
  });
}

/** N3-B: the record's six summary columns — by the profile first, then (a legacy row) by the user. */
async function findKycSummary(advertiserId: string, userId: string | null) {
  const select = { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } as const;
  const byProfile = await prisma.advertiserKyc.findUnique({ where: { advertiserProfileId: advertiserId }, select });
  if (byProfile || !userId) return byProfile;
  return prisma.advertiserKyc.findUnique({ where: { advertiserId: userId }, select });
}

async function attachAgent(advertiserId: string, agentId: string) {
  await prisma.advertiser.updateMany({ where: { id: advertiserId, agentId: null }, data: { agentId } });
}

async function findUserSummary(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, select: { name: true, avatarUrl: true } });
}

async function findUserClosure(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, select: { closedAt: true, closeReason: true } });
}

/** QR-15: the person behind the account — the console's Edit details drawer prefills from these. */
async function findUserPerson(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { displayId: true, firstName: true, lastName: true, dateOfBirth: true, gender: true, avatarUrl: true, consentAcceptedAt: true },
  });
}

/** QR-14/15: the names behind `onboardedById`, one query for a page of rows. */
async function userLabels(userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map<string, string | null>();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * QR-15: the account behind a desk-onboarded advertiser — opened with the
 * number and the ADVERTISER role, or the number's existing account adopted.
 * Only what is empty is filled: a person who already is somebody keeps
 * their own details.
 */
async function ensureAccount(input: AccountInput) {
  const { mobile, displayId, name, email, ...person } = input;
  const existing = await prisma.user.findUnique({ where: { mobile }, include: { roles: { select: { role: true } } } });
  if (existing) {
    const fill: Record<string, unknown> = {};
    if (existing.firstName === null && person.firstName !== undefined) fill['firstName'] = person.firstName;
    if (existing.lastName === null && person.lastName !== undefined) fill['lastName'] = person.lastName;
    if (existing.dateOfBirth === null && person.dateOfBirth !== undefined) fill['dateOfBirth'] = person.dateOfBirth;
    if (existing.gender === null && person.gender !== undefined) fill['gender'] = person.gender;
    if (existing.name === null) fill['name'] = name;
    if (existing.email === null && email) fill['email'] = email;
    if (!existing.roles.some((r) => r.role === 'ADVERTISER')) fill['roles'] = { create: { role: 'ADVERTISER' } };
    if (Object.keys(fill).length > 0) await prisma.user.update({ where: { id: existing.id }, data: fill });
    return { id: existing.id, created: false };
  }
  const created = await prisma.user.create({
    data: {
      mobile,
      displayId,
      name,
      ...(email ? { email } : {}),
      ...(person.firstName !== undefined ? { firstName: person.firstName } : {}),
      ...(person.lastName !== undefined ? { lastName: person.lastName } : {}),
      ...(person.dateOfBirth !== undefined ? { dateOfBirth: person.dateOfBirth } : {}),
      ...(person.gender !== undefined ? { gender: person.gender } : {}),
      roles: { create: { role: 'ADVERTISER' } },
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

async function updateAccount(userId: string, patch: { firstName?: string; lastName?: string; name?: string; email?: string; dateOfBirth?: Date; gender?: Gender }) {
  await prisma.user.update({ where: { id: userId }, data: patch });
}

async function createAdvertiser(input: CreateAdvertiserInput) {
  return prisma.advertiser.create({
    data: {
      name: input.name,
      mobile: input.mobile,
      email: input.email ?? null,
      type: input.type ?? 'INDIVIDUAL',
      companyName: input.companyName ?? null,
      gstin: input.gstin ?? null,
      billingAddress: input.billingAddress ?? null,
      city: input.city ?? null,
      cityId: input.cityId ?? null,
      state: input.state ?? null,
      industry: input.industry ?? null,
      userId: input.userId ?? null,
      agentId: input.agentId ?? null,
      displayId: input.displayId,
      // QR-14: the door.
      onboardedVia: input.onboardedVia ?? null,
      onboardedById: input.onboardedById ?? null,
      onboardedByRole: input.onboardedByRole ?? null,
      onboardedAt: input.onboardedAt ?? null,
    },
  });
}

/** QR-14: the name behind `onboardedById`. */
const findUserLabel = async (userId: string): Promise<string | null> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ?? null;
};

const findAdvertiserById = (id: string) => prisma.advertiser.findUnique({ where: { id } });
const findAdvertiserByMobile = (mobile: string) =>
  prisma.advertiser.findUnique({ where: { mobile } });
const findAdvertiserByUserId = (userId: string) =>
  prisma.advertiser.findUnique({ where: { userId } });

const findAdvertiserLabelsByUserIds = async (userIds: string[]) => {
  if (userIds.length === 0) return [];
  const rows = await prisma.advertiser.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true, displayId: true, name: true, kycStatus: true },
  });
  return rows.flatMap((row) => (row.userId ? [{ ...row, userId: row.userId }] : []));
};

const updateAdvertiser = (id: string, patch: UpdateAdvertiserInput) =>
  prisma.advertiser.update({ where: { id }, data: patch });

async function listAdvertisers(query: AdvertiserRosterQuery) {
  const rows = await prisma.advertiser.findMany({
    where: {
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { companyName: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { mobile: { contains: query.q } },
              { displayId: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      // QR-15: the roster's cuts — who onboarded, and how.
      ...(query.onboardedVia ? { onboardedVia: query.onboardedVia } : {}),
      ...(query.onboardedById ? { onboardedById: query.onboardedById } : {}),
    },
    orderBy: { createdAt: 'desc' },
    ...pageArgs(query),
  });
  return toPage(rows, query);
}

/**
 * The accounts one agent holds.
 *
 * Not paged: an agent's book is tens of accounts, and the screen that reads this
 * is a picker. If a book ever runs to hundreds, this takes a page query like
 * everything else.
 */
const findAdvertisersForAgent = (agentId: string) =>
  prisma.advertiser.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 200 });

/* ------------------------------------------------------------------ */
/* Funnel                                                              */
/* ------------------------------------------------------------------ */

/**
 * Gate 2 as a where clause. The mirror of `isProfileComplete` in the service —
 * if one changes, change the other.
 */
const PROFILE_COMPLETE = {
  billingAddress: { not: null },
  city: { not: null },
  OR: [{ type: 'INDIVIDUAL' as const }, { companyName: { not: null } }],
};

/**
 * Six counts in one round trip.
 *
 * Every figure is a `count` with a where clause rather than a row fetch — the
 * console renders totals, and at ten million advertisers the difference between
 * counting and loading is the difference between a dashboard and an outage.
 */
async function funnel(): Promise<AdvertiserFunnel> {
  const agreementFilter = {
    agreementAcceptances: { some: { templateKind: 'ADVERTISER_PLATFORM' as const } },
  };

  const [
    accountsCreated,
    profileComplete,
    kycVerified,
    platformAgreementAccepted,
    funded,
    pendingKycReview,
    awaitingProfile,
    awaitingKycSubmission,
  ] = await Promise.all([
    prisma.advertiser.count(),
    prisma.advertiser.count({ where: PROFILE_COMPLETE }),
    prisma.advertiser.count({ where: { kycStatus: 'VERIFIED' } }),
    prisma.advertiser.count({ where: agreementFilter }),
    prisma.advertiser.count({ where: { wallet: { balance: { gt: 0 } } } }),
    prisma.advertiserKyc.count({ where: { status: 'PENDING', submittedAt: { not: null } } }),
    prisma.advertiser.count({ where: { NOT: PROFILE_COMPLETE } }),
    prisma.advertiser.count({
      // N3-B: the record is keyed by the profile.
      where: { ...PROFILE_COMPLETE, kycStatus: 'PENDING', kyc: null },
    }),
  ]);

  // Verified but not yet signed, and signed but not yet funded: the two places
  // an otherwise willing advertiser sits without anyone chasing them.
  const [awaitingAgreement, awaitingFunds] = await Promise.all([
    prisma.advertiser.count({
      where: { kycStatus: 'VERIFIED', agreementAcceptances: { none: { templateKind: 'ADVERTISER_PLATFORM' } } },
    }),
    prisma.advertiser.count({
      where: { ...agreementFilter, OR: [{ wallet: null }, { wallet: { balance: { lte: 0 } } }] },
    }),
  ]);

  return {
    accountsCreated,
    profileComplete,
    kycVerified,
    platformAgreementAccepted,
    funded,
    stuckOnAdvertiser: { awaitingProfile, awaitingKycSubmission, awaitingAgreement, awaitingFunds },
    stuckOnAdx: { pendingKycReview },
  };
}

async function funnelRows(query: PageQuery) {
  const rows = await prisma.advertiser.findMany({
    orderBy: { createdAt: 'desc' },
    ...pageArgs(query),
    select: {
      id: true,
      displayId: true,
      name: true,
      companyName: true,
      type: true,
      city: true,
      industry: true,
      kycStatus: true,
      activatedAt: true,
      createdAt: true,
      wallet: { select: { balance: true } },
      _count: { select: { brands: true } },
      agreementAcceptances: {
        where: { templateKind: 'ADVERTISER_PLATFORM' },
        select: { acceptedAt: true },
        take: 1,
      },
    },
  });

  const mapped: AdvertiserFunnelRow[] = rows.map((row) => ({
    id: row.id,
    displayId: row.displayId,
    name: row.name,
    companyName: row.companyName,
    type: row.type,
    city: row.city,
    industry: row.industry,
    kycStatus: row.kycStatus,
    platformAgreementAcceptedAt: row.agreementAcceptances[0]?.acceptedAt ?? null,
    activatedAt: row.activatedAt,
    brandCount: row._count.brands,
    walletBalance: money(row.wallet?.balance ?? ZERO),
    createdAt: row.createdAt,
  }));

  return toPage(mapped, query);
}

async function findUserMobile(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mobile: true } });
  return user?.mobile ?? null;
}

async function findAgentProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.agentProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Brands                                                              */
/* ------------------------------------------------------------------ */

const createBrand = (input: {
  advertiserId: string;
  name: string;
  sector?: Brand['sector'];
  logoUrl?: string | null;
  website?: string | null;
}) =>
  prisma.brand.create({
    data: {
      advertiserId: input.advertiserId,
      name: input.name,
      sector: input.sector ?? 'GENERAL',
      logoUrl: input.logoUrl ?? null,
      website: input.website ?? null,
    },
  });

const findBrandById = (id: string) => prisma.brand.findUnique({ where: { id } });
const listBrands = (advertiserId: string) =>
  prisma.brand.findMany({ where: { advertiserId }, orderBy: { name: 'asc' } });
const updateBrand = (id: string, patch: Parameters<AdvertisersRepository['updateBrand']>[1]) =>
  prisma.brand.update({ where: { id }, data: patch });

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

const activeTemplate = (kind: CreateAcceptanceInput['templateKind']) =>
  prisma.agreementTemplate.findFirst({
    where: { kind, isActive: true },
    orderBy: { version: 'desc' },
  });

const findAcceptance = (advertiserId: string, kind: CreateAcceptanceInput['templateKind']) =>
  // Lot D (Q55): the newest platform-scope click — several versions may have
  // been accepted over time, and the re-acceptance gate reads the highest.
  prisma.agreementAcceptance.findFirst({
    where: { advertiserId, templateKind: kind, attemptId: null, campaignId: null, packageSaleId: null, orderId: null },
    orderBy: [{ templateVersion: 'desc' }, { acceptedAt: 'desc' }],
  });

const createAcceptance = (input: CreateAcceptanceInput) =>
  prisma.agreementAcceptance.create({
    data: {
      templateId: input.templateId,
      templateKind: input.templateKind,
      templateVersion: input.templateVersion,
      advertiserId: input.advertiserId,
      campaignId: input.campaignId ?? null,
      acceptedByUserId: input.acceptedByUserId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      renderedDocument: input.renderedDocument ?? null,
    },
  });

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */

const ensureWallet = (advertiserId: string): Promise<Wallet> =>
  prisma.wallet.upsert({
    where: { advertiserId },
    create: { advertiserId },
    update: {},
  });

async function walletSnapshot(advertiserId: string): Promise<WalletSnapshot | null> {
  const wallet = await prisma.wallet.findUnique({ where: { advertiserId } });
  if (!wallet) return null;

  const open = await prisma.walletHold.aggregate({
    where: { walletId: wallet.id, status: 'HELD' },
    _sum: { amount: true },
  });

  const held = open._sum.amount ?? ZERO;
  const spendable = new D(wallet.balance).add(wallet.goodwill).sub(held);

  return {
    balance: money(wallet.balance),
    goodwill: money(wallet.goodwill),
    held: money(held),
    // A hold can only ever be placed against available funds, so this cannot go
    // negative — clamped anyway, because a negative spendable balance rendered
    // to an advertiser would be alarming and meaningless.
    spendable: money(spendable.lessThan(ZERO) ? ZERO : spendable),
    currency: wallet.currency,
    frozenAt: wallet.frozenAt ?? null,
  };
}

async function listWalletEntries(advertiserId: string, query: PageQuery) {
  const wallet = await prisma.wallet.findUnique({ where: { advertiserId }, select: { id: true } });
  if (!wallet) return { rows: [] as WalletEntry[], nextCursor: null };

  const rows = await prisma.walletEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    ...pageArgs(query),
  });
  return toPage(rows, query);
}

const findHoldById = (id: string) => prisma.walletHold.findUnique({ where: { id } });

/* Lot B (Q41/Q118): the record behind a top-up. The money itself moves
   through `wallets.move`; this is what reconciliation matches a bank line to. */
const createTopUp = (input: NewTopUp) =>
  prisma.walletTopUp.create({
    data: {
      walletId: input.walletId,
      amount: new D(input.amount),
      method: input.method,
      utr: input.utr ?? null,
      receivedAt: input.receivedAt,
      bankAccountId: input.bankAccountId ?? null,
      proofFileId: input.proofFileId ?? null,
      paymentId: input.paymentId ?? null,
      note: input.note ?? null,
      recordedByUserId: input.recordedByUserId,
      walletEntryId: input.walletEntryId ?? null,
      ledgerTransactionId: input.ledgerTransactionId ?? null,
      reconciledAt: input.reconciledAt ?? null,
    },
  });

const findTopUpByPayment = (paymentId: string) =>
  prisma.walletTopUp.findFirst({ where: { paymentId }, orderBy: { createdAt: 'asc' } });

const findTopUp = (id: string) => prisma.walletTopUp.findUnique({ where: { id } });

const findTopUpByUtr = (utr: string) =>
  prisma.walletTopUp.findFirst({ where: { utr }, orderBy: { createdAt: 'asc' } });

const markTopUpReconciled = (id: string, at: Date | null) =>
  prisma.walletTopUp.update({ where: { id }, data: { reconciledAt: at } });

async function listTopUps(advertiserId: string, query: PageQuery) {
  const wallet = await prisma.wallet.findUnique({ where: { advertiserId }, select: { id: true } });
  if (!wallet) return { rows: [], nextCursor: null };
  const rows = await prisma.walletTopUp.findMany({
    where: { walletId: wallet.id },
    orderBy: { receivedAt: 'desc' },
    ...pageArgs(query),
  });
  return toPage(rows, query);
}

/** E6: the finance desk's register — every top-up, the advertiser named. */
async function listTopUpsPage(query: TopUpDeskQuery) {
  const q = query.q?.trim();
  const base: Prisma.WalletTopUpWhereInput = {
    ...(q ? { utr: { contains: q, mode: 'insensitive' } } : {}),
    ...(query.from || query.to
      ? { receivedAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
      : {}),
  };
  const wanted = new Set(query.status ?? []);
  const where: Prisma.WalletTopUpWhereInput =
    wanted.size === 1
      ? { ...base, reconciledAt: wanted.has('RECONCILED') ? { not: null } : null }
      : base;
  const [rows, total, reconciled, all] = await Promise.all([
    prisma.walletTopUp.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      include: { wallet: { select: { advertiser: { select: { id: true, displayId: true, name: true } } } } },
      ...listArgs(query),
    }),
    prisma.walletTopUp.count({ where }),
    // Counted with the status facet removed, so the chips stay a way out.
    prisma.walletTopUp.count({ where: { ...base, reconciledAt: { not: null } } }),
    prisma.walletTopUp.count({ where: base }),
  ]);
  const items = rows.map(({ wallet, ...row }) => ({ ...row, advertiser: wallet.advertiser }));
  const counts = countsFrom(
    [
      { status: 'RECONCILED', _count: { _all: reconciled } },
      { status: 'UNRECONCILED', _count: { _all: all - reconciled } },
    ],
    TOP_UP_DESK_STATUSES,
  );
  return toListPage(items, total, counts, query);
}

/**
 * Placing a hold reads the balance and writes the hold in one transaction.
 *
 * Read-then-write across two calls is exactly how a wallet is double-spent: two
 * concurrent bookings both see the same funds and both succeed.
 */
async function placeHold(input: {
  advertiserId: string;
  campaignId: string;
  amount: Money;
}): Promise<WalletHold | null> {
  const amount = new D(input.amount);

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { advertiserId: input.advertiserId } });
    if (!wallet) return null;

    const open = await tx.walletHold.aggregate({
      where: { walletId: wallet.id, status: 'HELD' },
      _sum: { amount: true },
    });

    const spendable = new D(wallet.balance).add(wallet.goodwill).sub(open._sum.amount ?? ZERO);
    if (spendable.lessThan(amount)) return null;

    return tx.walletHold.create({
      data: { walletId: wallet.id, campaignId: input.campaignId, amount },
    });
  });
}

async function releaseHold(holdId: string): Promise<WalletHold | null> {
  const hold = await prisma.walletHold.findUnique({ where: { id: holdId } });
  if (!hold || hold.status !== 'HELD') return null;

  return prisma.walletHold.update({
    where: { id: holdId },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

/**
 * Settled balance less open holds, capped at what was actually paid in.
 *
 * Two ceilings, and both matter. The balance ceiling stops a refund of money
 * already committed to a campaign; the paid-in ceiling stops goodwill or an
 * adjustment being turned into cash by refunding more than ever arrived.
 */
async function refundableAmount(advertiserId: string): Promise<Money> {
  const wallet = await prisma.wallet.findUnique({ where: { advertiserId } });
  if (!wallet) return money(ZERO);

  const [open, paidIn] = await Promise.all([
    prisma.walletHold.aggregate({
      where: { walletId: wallet.id, status: 'HELD' },
      _sum: { amount: true },
    }),
    // REFUND entries are negative, so this nets off refunds already given.
    prisma.walletEntry.aggregate({
      where: { walletId: wallet.id, type: { in: ['TOPUP', 'REFUND'] } },
      _sum: { amount: true },
    }),
  ]);

  const available = new D(wallet.balance).sub(open._sum.amount ?? ZERO);
  const netPaidIn = new D(paidIn._sum.amount ?? ZERO);
  const cap = D.min(available, netPaidIn);
  return money(cap.lessThan(ZERO) ? ZERO : cap);
}

async function findOpenRefundRequest(advertiserId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { advertiserId },
    select: { id: true },
  });
  if (!wallet) return null;
  return prisma.walletRefundRequest.findFirst({
    where: { walletId: wallet.id, status: 'PENDING' },
  });
}

/**
 * E6: the advertiser beside a refund request — the desk's row. T-B: the one
 * read and the one write the desk's mark-paid and fail go through carry it
 * too, so those answers are the row the desk lists.
 */
const refundDeskInclude = {
  wallet: { select: { advertiser: { select: { id: true, displayId: true, name: true } } } },
} satisfies Prisma.WalletRefundRequestInclude;

const toRefundDeskRow = <T extends { wallet: { advertiser: RefundRequestDeskRow['advertiser'] } }>({ wallet, ...row }: T) => ({
  ...row,
  advertiser: wallet.advertiser,
});

const findRefundRequest = async (id: string): Promise<RefundRequestDeskRow | null> => {
  const row = await prisma.walletRefundRequest.findUnique({ where: { id }, include: refundDeskInclude });
  return row ? toRefundDeskRow(row) : null;
};

async function listRefundRequests(query: PageQuery, status?: RefundRequestStatus) {
  const rows = await prisma.walletRefundRequest.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    ...pageArgs(query),
  });
  return toPage(rows, query);
}

/** The refund desk (Lot B): total, page and the per-status chips. */
async function listRefundRequestsPage(query: ListQuery & { advertiserId?: string | undefined }) {
  const statuses = query.status as RefundRequestStatus[] | undefined;
  // E6: the party read narrows to one wallet; the desk sees every one.
  const scope: Prisma.WalletRefundRequestWhereInput = query.advertiserId
    ? { wallet: { advertiserId: query.advertiserId } }
    : {};
  const where: Prisma.WalletRefundRequestWhereInput = statuses?.length ? { ...scope, status: { in: statuses } } : scope;
  const [rows, total, groups] = await Promise.all([
    prisma.walletRefundRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: refundDeskInclude,
      ...listArgs(query),
    }),
    prisma.walletRefundRequest.count({ where }),
    // Counted with the status facet removed, so the chips stay a way out.
    prisma.walletRefundRequest.groupBy({ by: ['status'], _count: { _all: true }, where: scope }),
  ]);
  const items = rows.map(toRefundDeskRow);
  return toListPage(items, total, countsFrom(groups, REFUND_REQUEST_STATUSES), query);
}

/**
 * Raising a request freezes the money in the same transaction that records it.
 * Without that, an advertiser could ask for a refund and spend the same balance
 * on a booking before anyone had decided.
 */
async function createRefundRequest(input: {
  advertiserId: string;
  amount: Money;
  reason: RefundReason;
  note: string;
  ticketId?: string | null;
  raisedByUserId: string;
  destination: RefundDestination;
  consentNote?: string | null;
  payoutMethodId?: string | null;
}): Promise<WalletRefundRequest | null> {
  const amount = new D(input.amount);

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { advertiserId: input.advertiserId } });
    if (!wallet) return null;

    const open = await tx.walletHold.aggregate({
      where: { walletId: wallet.id, status: 'HELD' },
      _sum: { amount: true },
    });
    const available = new D(wallet.balance).sub(open._sum.amount ?? ZERO);
    if (available.lessThan(amount)) return null;

    const hold = await tx.walletHold.create({
      data: {
        walletId: wallet.id,
        // Holds are keyed by campaign; a refund has none, so it carries its own
        // marker rather than pointing at a campaign that does not exist.
        campaignId: `refund:${input.raisedByUserId}:${Date.now()}`,
        amount,
        note: 'Refund requested',
      },
    });

    return tx.walletRefundRequest.create({
      data: {
        walletId: wallet.id,
        amount,
        reason: input.reason,
        note: input.note,
        ticketId: input.ticketId ?? null,
        raisedByUserId: input.raisedByUserId,
        holdId: hold.id,
        destination: input.destination,
        consentNote: input.consentNote ?? null,
        payoutMethodId: input.payoutMethodId ?? null,
      },
    });
  });
}

/**
 * Closes a PENDING request. The money is never moved here: a BANK_TRANSFER
 * approval has already captured the hold as a REFUND debit through
 * `wallets.move` (hold: 'LEAVE'); a rejection or a WALLET_CREDIT approval
 * frees the frozen amount back to spendable balance (hold: 'RELEASE').
 */
async function decideRefundRequest(input: {
  requestId: string;
  status: 'APPROVED' | 'REJECTED';
  hold: 'RELEASE' | 'LEAVE';
  decidedByUserId: string;
  decisionNote?: string | null;
  ledgerTransactionId?: string | null;
}): Promise<WalletRefundRequest | null> {
  return prisma.$transaction(async (tx) => {
    const request = await tx.walletRefundRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.status !== 'PENDING') return null;

    const now = new Date();
    if (input.hold === 'RELEASE' && request.holdId) {
      await tx.walletHold.updateMany({
        where: { id: request.holdId, status: 'HELD' },
        data: { status: 'RELEASED', releasedAt: now },
      });
    }
    return tx.walletRefundRequest.update({
      where: { id: request.id },
      data: {
        status: input.status,
        decidedByUserId: input.decidedByUserId,
        decidedAt: now,
        decisionNote: input.decisionNote ?? null,
        ...(input.ledgerTransactionId ? { ledgerTransactionId: input.ledgerTransactionId } : {}),
      },
    });
  });
}

const updateRefundRequest = async (id: string, patch: RefundRequestPatch): Promise<RefundRequestDeskRow> =>
  toRefundDeskRow(await prisma.walletRefundRequest.update({ where: { id }, data: patch, include: refundDeskInclude }));

async function withdrawRefundRequest(requestId: string): Promise<WalletRefundRequest | null> {
  return prisma.$transaction(async (tx) => {
    const request = await tx.walletRefundRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'PENDING') return null;

    if (request.holdId) {
      await tx.walletHold.update({
        where: { id: request.holdId },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
    }
    return tx.walletRefundRequest.update({
      where: { id: requestId },
      data: { status: 'WITHDRAWN' },
    });
  });
}

/* ------------------------------------------------------------------ */
/* Dormancy                                                            */
/* ------------------------------------------------------------------ */

async function findDormantWallets(before: Date, batchSize: number): Promise<DormantWallet[]> {
  const due = await prisma.wallet.findMany({
    where: {
      advertiserId: { not: null },
      lastActivityAt: { lt: before },
      OR: [{ balance: { gt: 0 } }, { goodwill: { gt: 0 } }],
    },
    take: batchSize,
    orderBy: { lastActivityAt: 'asc' },
    select: { id: true, advertiserId: true, balance: true, goodwill: true },
  });
  return due.map((wallet) => ({
    id: wallet.id,
    advertiserId: wallet.advertiserId!,
    balance: money(wallet.balance),
    goodwill: money(wallet.goodwill),
  }));
}

const findLabelsByIds = async (ids: string[]) => {
  if (ids.length === 0) return [];
  const rows = await prisma.advertiser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, displayId: true } });
  return rows.map((row) => ({ id: row.id, label: row.name, displayId: row.displayId }));
};

export const prismaAdvertisersRepository: AdvertisersRepository = {
  findUserLabel,
  findLabelsByIds,
  createAdvertiser,
  attachUser,
  attachAgent,
  findUserSummary,
  findUserClosure,
  findUserPerson,
  userLabels,
  ensureAccount,
  updateAccount,
  findAdvertiserById,
  findKycSummary,
  findAdvertiserByMobile,
  findAdvertiserByUserId,
  findAdvertiserLabelsByUserIds,
  updateAdvertiser,
  listAdvertisers,
  findAdvertisersForAgent,
  findUserMobile,
  findAgentProfileId,
  funnel,
  funnelRows,
  createBrand,
  findBrandById,
  listBrands,
  updateBrand,
  activeTemplate,
  findAcceptance,
  createAcceptance,
  ensureWallet,
  walletSnapshot,
  listWalletEntries,
  findHoldById,
  placeHold,
  releaseHold,
  createTopUp,
  findTopUpByPayment,
  listTopUps,
  listTopUpsPage,
  findTopUp,
  findTopUpByUtr,
  markTopUpReconciled,
  refundableAmount,
  findOpenRefundRequest,
  findRefundRequest,
  listRefundRequests,
  listRefundRequestsPage,
  createRefundRequest,
  decideRefundRequest,
  updateRefundRequest,
  withdrawRefundRequest,
  findDormantWallets,
};
