import { prisma } from '../../shared/database';
import type { Prisma, WalletEntryType } from '../../shared/database';
import { subnetOf } from './signals/shared-ip-subnet.signal';
import type {
  FraudSignalIndex,
  FraudSubject,
  LinkedParty,
  LinkedPartyType,
  ListingPhotoRef,
  OnboardedPublisher,
  PayoutHandle,
  ProofPhoto,
  ResolvedSubject,
} from './signals/types';

/**
 * The read-only index the fraud signals evaluate over — Lot G (Q118/138).
 *
 * This file reads across the parties' tables the way `admin-overview` reads
 * across the platform for its tiles: KYC rows for the PAN, payout methods
 * for the bank handles, refresh tokens for the sign-in addresses, device
 * tokens, listing and order photos, wallets and withdrawals. It writes
 * nothing. Every "other parties" read excludes the subject itself and
 * answers `{ type, id, name }` so a signal can say who the link is.
 */

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** A PAN as recorded, or null when none was, or when the purge left only its last four. */
const cleanPan = (value: string | null | undefined): string | null => {
  const pan = (value ?? '').trim().toUpperCase();
  return PAN.test(pan) ? pan : null;
};

/** Credits to a wallet — what "withdraw within the hour of a credit" is measured from. */
const CREDIT_TYPES: WalletEntryType[] = ['EARNING', 'BONUS', 'REFERRAL', 'GOODWILL_CREDIT', 'TOPUP', 'REFUND', 'ADJUSTMENT'];

const sameParty = (a: { type: LinkedPartyType; id: string }, b: { type: LinkedPartyType; id: string }) => a.type === b.type && a.id === b.id;

/** The parties behind a set of logins, minus the subject. */
async function partiesForUsers(userIds: string[], exclude: ResolvedSubject): Promise<LinkedParty[]> {
  const ids = [...new Set(userIds.filter((id) => id && id !== exclude.userId))];
  if (ids.length === 0) return [];
  const [publishers, advertisers, agents] = await Promise.all([
    prisma.publisher.findMany({ where: { userId: { in: ids } }, select: { id: true, name: true } }),
    prisma.advertiser.findMany({ where: { userId: { in: ids } }, select: { id: true, name: true } }),
    prisma.agentProfile.findMany({ where: { userId: { in: ids } }, select: { id: true, user: { select: { name: true } } } }),
  ]);
  const parties: LinkedParty[] = [
    ...publishers.map((p) => ({ type: 'PUBLISHER' as const, id: p.id, name: p.name })),
    ...advertisers.map((a) => ({ type: 'ADVERTISER' as const, id: a.id, name: a.name })),
    ...agents.map((a) => ({ type: 'AGENT' as const, id: a.id, name: a.user.name })),
  ];
  return parties.filter((p) => !sameParty(p, exclude));
}

/** `CampaignRefund` carries a campaign id without a relation, so the campaigns are read first. */
async function campaignRefundsFor(campaigns: Promise<{ campaignId: string }[]>, since: Date): Promise<number> {
  const ids = [...new Set((await campaigns).map((c) => c.campaignId))];
  if (ids.length === 0) return 0;
  return prisma.campaignRefund.count({ where: { campaignId: { in: ids }, createdAt: { gte: since } } });
}

/** The address prefixes a /24 (or /64) covers, as the token table stores them. */
function prefixesOf(subnet: string): string[] {
  if (subnet.endsWith('/24')) {
    const base = subnet.slice(0, -'0/24'.length); // '103.21.58.'
    return [base, `::ffff:${base}`];
  }
  return [subnet.replace(/::\/64$/, ':')];
}

export const prismaFraudSignalsIndex: FraudSignalIndex & {
  /** The parties the nightly scan walks — each type bounded, most recently active first. */
  scanCandidates(limitPerType: number): Promise<FraudSubject[]>;
} = {
  async resolveSubject(subject) {
    if (subject.type === 'LISTING') {
      const listing = await prisma.listing.findUnique({ where: { id: subject.id }, select: { publisherId: true } });
      if (!listing?.publisherId) return null;
      const resolved = await this.resolveSubject({ type: 'PUBLISHER', id: listing.publisherId });
      return resolved ? { ...resolved, listingId: subject.id } : null;
    }
    if (subject.type === 'PUBLISHER') {
      const row = await prisma.publisher.findUnique({
        where: { id: subject.id },
        select: { id: true, userId: true, name: true, mobile: true, agentId: true, kycStatus: true, kyc: { select: { panNumber: true } } },
      });
      if (!row) return null;
      return { type: 'PUBLISHER', id: row.id, userId: row.userId, name: row.name, mobile: row.mobile, pan: cleanPan(row.kyc?.panNumber), kycStatus: row.kycStatus, agentId: row.agentId, listingId: null };
    }
    if (subject.type === 'ADVERTISER') {
      // N3-B: the KYC record hangs off the profile; a legacy row is still keyed by the profile's user.
      const row = await prisma.advertiser.findUnique({
        where: { id: subject.id },
        select: { id: true, userId: true, name: true, companyName: true, mobile: true, kycStatus: true, kyc: { select: { panNumber: true } } },
      });
      if (!row) return null;
      const kyc = row.kyc ?? (row.userId ? await prisma.advertiserKyc.findUnique({ where: { advertiserId: row.userId }, select: { panNumber: true } }) : null);
      return { type: 'ADVERTISER', id: row.id, userId: row.userId, name: row.companyName ?? row.name, mobile: row.mobile, pan: cleanPan(kyc?.panNumber), kycStatus: row.kycStatus, agentId: null, listingId: null };
    }
    const row = await prisma.agentProfile.findUnique({
      where: { id: subject.id },
      select: { id: true, userId: true, user: { select: { name: true, mobile: true } }, kyc: { select: { panNumber: true, status: true } } },
    });
    if (!row) return null;
    return { type: 'AGENT', id: row.id, userId: row.userId, name: row.user.name, mobile: row.user.mobile, pan: cleanPan(row.kyc?.panNumber), kycStatus: row.kyc?.status ?? null, agentId: null, listingId: null };
  },

  async partiesWithPan(pan, exclude) {
    const [publisherKycs, advertiserKycs, agentKycs] = await Promise.all([
      prisma.publisherKyc.findMany({ where: { panNumber: { equals: pan, mode: 'insensitive' } }, select: { publisher: { select: { id: true, name: true } } } }),
      prisma.advertiserKyc.findMany({ where: { panNumber: { equals: pan, mode: 'insensitive' } }, select: { advertiserId: true, advertiserProfileId: true } }),
      prisma.agentKyc.findMany({ where: { panNumber: { equals: pan, mode: 'insensitive' } }, select: { agent: { select: { id: true, user: { select: { name: true } } } } } }),
    ]);
    // N3-B: by the profile the record names, else (a legacy row) by its user; a record naming neither links no party.
    const profileIds = advertiserKycs.flatMap((k) => (k.advertiserProfileId ? [k.advertiserProfileId] : []));
    const userIds = advertiserKycs.flatMap((k) => (!k.advertiserProfileId && k.advertiserId ? [k.advertiserId] : []));
    const advertisers =
      profileIds.length || userIds.length
        ? await prisma.advertiser.findMany({ where: { OR: [{ id: { in: profileIds } }, { userId: { in: userIds } }] }, select: { id: true, name: true } })
        : [];
    const parties: LinkedParty[] = [
      ...publisherKycs.map((k) => ({ type: 'PUBLISHER' as const, id: k.publisher.id, name: k.publisher.name })),
      ...advertisers.map((a) => ({ type: 'ADVERTISER' as const, id: a.id, name: a.name })),
      ...agentKycs.map((k) => ({ type: 'AGENT' as const, id: k.agent.id, name: k.agent.user.name })),
    ];
    return parties.filter((p) => !sameParty(p, exclude));
  },

  async payoutHandlesFor(userId): Promise<PayoutHandle[]> {
    const rows = await prisma.payoutMethod.findMany({
      where: { userId },
      select: { accountNumber: true, upiVpa: true, accountHolder: true, nameMatchPct: true },
    });
    return rows.map((r) => ({
      accountNumber: r.accountNumber,
      upiVpa: r.upiVpa,
      accountHolder: r.accountHolder,
      nameMatchPct: r.nameMatchPct === null ? null : Number(r.nameMatchPct),
    }));
  },

  async partiesWithPayoutHandle(handles, exclude) {
    const or: Prisma.PayoutMethodWhereInput[] = [];
    if (handles.accountNumbers.length) or.push({ accountNumber: { not: null } });
    if (handles.upiVpas.length) or.push({ upiVpa: { in: handles.upiVpas, mode: 'insensitive' } });
    if (or.length === 0) return [];
    const rows = await prisma.payoutMethod.findMany({
      where: { OR: or, ...(exclude.userId ? { userId: { not: exclude.userId } } : {}) },
      select: { userId: true, accountNumber: true, upiVpa: true },
    });
    const matching = rows.filter(
      (r) =>
        (r.accountNumber && handles.accountNumbers.includes(r.accountNumber.replace(/[\s-]/g, '').toUpperCase())) ||
        (r.upiVpa && handles.upiVpas.includes(r.upiVpa.trim().toLowerCase())),
    );
    return partiesForUsers(matching.map((r) => r.userId), exclude);
  },

  async signInSubnetsFor(userId, since) {
    const rows = await prisma.refreshToken.findMany({
      where: { userId, createdAt: { gte: since }, ipAddress: { not: null } },
      select: { ipAddress: true },
      take: 500,
    });
    return [...new Set(rows.map((r) => subnetOf(r.ipAddress)).filter((s): s is string => s !== null))];
  },

  async partiesOnSubnets(subnets, since, exclude) {
    if (subnets.length === 0) return [];
    const rows = await prisma.refreshToken.findMany({
      where: {
        createdAt: { gte: since },
        ...(exclude.userId ? { userId: { not: exclude.userId } } : {}),
        OR: subnets.flatMap((s) => prefixesOf(s).map((prefix) => ({ ipAddress: { startsWith: prefix } }))),
      },
      select: { userId: true, ipAddress: true },
      take: 5000,
    });
    const wanted = new Set(subnets);
    const userIds = rows.filter((r) => wanted.has(subnetOf(r.ipAddress) ?? '')).map((r) => r.userId);
    return partiesForUsers(userIds, exclude);
  },

  async partiesWithMobile(mobile, exclude) {
    const [publishers, advertisers, agents] = await Promise.all([
      prisma.publisher.findMany({ where: { mobile }, select: { id: true, name: true } }),
      prisma.advertiser.findMany({ where: { mobile }, select: { id: true, name: true } }),
      prisma.agentProfile.findMany({ where: { user: { mobile } }, select: { id: true, user: { select: { name: true } } } }),
    ]);
    const parties: LinkedParty[] = [
      ...publishers.map((p) => ({ type: 'PUBLISHER' as const, id: p.id, name: p.name })),
      ...advertisers.map((a) => ({ type: 'ADVERTISER' as const, id: a.id, name: a.name })),
      ...agents.map((a) => ({ type: 'AGENT' as const, id: a.id, name: a.user.name })),
    ];
    return parties.filter((p) => !sameParty(p, exclude));
  },

  async deviceTokensFor(userId) {
    const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
    return rows.map((r) => r.token);
  },

  async partiesWithDeviceTokens(tokens, exclude) {
    if (tokens.length === 0) return [];
    const rows = await prisma.deviceToken.findMany({
      where: { token: { in: tokens }, ...(exclude.userId ? { userId: { not: exclude.userId } } : {}) },
      select: { userId: true },
    });
    return partiesForUsers(rows.map((r) => r.userId), exclude);
  },

  async listingPhotosFor(publisherId): Promise<ListingPhotoRef[]> {
    const rows = await prisma.listingPhoto.findMany({
      where: { listing: { publisherId } },
      select: { listingId: true, url: true },
      take: 200,
    });
    return rows.map((r) => ({ listingId: r.listingId, publisherId, url: r.url }));
  },

  async listingPhotosOfOthers(publisherId, limit): Promise<ListingPhotoRef[]> {
    const rows = await prisma.listingPhoto.findMany({
      where: { listing: { publisherId: { not: publisherId } } },
      select: { listingId: true, url: true, listing: { select: { publisherId: true, publisher: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.flatMap((r) =>
      r.listing.publisherId ? [{ listingId: r.listingId, publisherId: r.listing.publisherId, publisherName: r.listing.publisher?.name ?? null, url: r.url }] : [],
    );
  },

  async proofPhotosFor(publisherId, since): Promise<ProofPhoto[]> {
    const rows = await prisma.orderPhoto.findMany({
      where: { kind: 'INSTALLATION', capturedAt: { gte: since }, order: { listing: { publisherId } } },
      select: {
        orderId: true,
        capturedAt: true,
        latitude: true,
        longitude: true,
        order: { select: { startDate: true, endDate: true, listing: { select: { latitude: true, longitude: true } } } },
      },
      take: 500,
    });
    return rows.map((r) => ({
      orderId: r.orderId,
      capturedAt: r.capturedAt,
      latitude: r.latitude,
      longitude: r.longitude,
      listingLatitude: r.order.listing.latitude,
      listingLongitude: r.order.listing.longitude,
      slotStart: r.order.startDate,
      slotEnd: r.order.endDate,
    }));
  },

  async onboardedPublishersOf(agentId): Promise<OnboardedPublisher[]> {
    const rows = await prisma.publisher.findMany({
      where: { agentId },
      select: {
        id: true,
        name: true,
        kycStatus: true,
        createdAt: true,
        listings: { select: { _count: { select: { orders: { where: { status: { not: 'DRAFT' } } } } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kycStatus: r.kycStatus,
      createdAt: r.createdAt,
      bookings: r.listings.reduce((sum, l) => sum + l._count.orders, 0),
    }));
  },

  async bookingOutcomesFor(subject, since) {
    if (subject.type === 'PUBLISHER') {
      const [bookings, refunds, disputes] = await Promise.all([
        prisma.order.count({ where: { listing: { publisherId: subject.id }, status: { not: 'DRAFT' }, createdAt: { gte: since } } }),
        campaignRefundsFor(prisma.campaignSpot.findMany({ where: { listing: { publisherId: subject.id } }, select: { campaignId: true }, distinct: ['campaignId'] }), since),
        prisma.dispute.count({
          where: {
            createdAt: { gte: since },
            OR: [
              ...(subject.userId ? [{ againstUserId: subject.userId }] : []),
              { againstParty: 'PUBLISHER', order: { listing: { publisherId: subject.id } } },
            ],
          },
        }),
      ]);
      return { bookings, refunds, disputes };
    }
    if (subject.type === 'ADVERTISER') {
      if (!subject.userId) return { bookings: 0, refunds: 0, disputes: 0 };
      const [bookings, walletRefunds, campaignRefunds, disputes] = await Promise.all([
        prisma.order.count({ where: { advertiserId: subject.userId, status: { not: 'DRAFT' }, createdAt: { gte: since } } }),
        prisma.walletRefundRequest.count({ where: { createdAt: { gte: since }, status: { notIn: ['REJECTED', 'WITHDRAWN'] }, wallet: { advertiserId: subject.id } } }),
        campaignRefundsFor(prisma.campaign.findMany({ where: { advertiserId: subject.id }, select: { id: true } }).then((rows) => rows.map((r) => ({ campaignId: r.id }))), since),
        prisma.dispute.count({
          where: { createdAt: { gte: since }, OR: [{ againstUserId: subject.userId }, { againstParty: 'ADVERTISER', order: { advertiserId: subject.userId } }] },
        }),
      ]);
      return { bookings, refunds: walletRefunds + campaignRefunds, disputes };
    }
    return { bookings: 0, refunds: 0, disputes: 0 };
  },

  async walletMovementsFor(subject, since) {
    const walletWhere: Prisma.WalletWhereInput =
      subject.type === 'PUBLISHER' ? { publisherId: subject.id } : subject.type === 'ADVERTISER' ? { advertiserId: subject.id } : { agentId: subject.id };
    const wallet = await prisma.wallet.findFirst({ where: walletWhere, select: { id: true } });
    if (!wallet) return { credits: [], withdrawals: [] };
    const [entries, withdrawals] = await Promise.all([
      prisma.walletEntry.findMany({
        where: { walletId: wallet.id, type: { in: CREDIT_TYPES }, amount: { gt: 0 }, createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1000,
      }),
      prisma.withdrawalRequest.findMany({
        where: { walletId: wallet.id, requestedAt: { gte: since } },
        select: { requestedAt: true },
        orderBy: { requestedAt: 'asc' },
        take: 1000,
      }),
    ]);
    return { credits: entries.map((e) => ({ at: e.createdAt })), withdrawals: withdrawals.map((w) => ({ requestedAt: w.requestedAt })) };
  },

  async listingCreatedAtFor(publisherId, since) {
    const rows = await prisma.listing.findMany({
      where: { publisherId, createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });
    return rows.map((r) => r.createdAt);
  },

  async scanCandidates(limitPerType) {
    const [publishers, advertisers, agents] = await Promise.all([
      prisma.publisher.findMany({ select: { id: true }, orderBy: { updatedAt: 'desc' }, take: limitPerType }),
      prisma.advertiser.findMany({ select: { id: true }, orderBy: { updatedAt: 'desc' }, take: limitPerType }),
      prisma.agentProfile.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { updatedAt: 'desc' }, take: limitPerType }),
    ]);
    return [
      ...publishers.map((p) => ({ type: 'PUBLISHER' as const, id: p.id })),
      ...advertisers.map((a) => ({ type: 'ADVERTISER' as const, id: a.id })),
      ...agents.map((a) => ({ type: 'AGENT' as const, id: a.id })),
    ];
  },
};
