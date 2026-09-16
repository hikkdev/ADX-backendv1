import { prisma } from '../../../shared/database';
import type { AssembledExport, DataExportRepository } from './data-export.repository';

/** A row with its Decimal / Date values as strings, and the named keys dropped. */
function plain(row: Record<string, unknown> | null | undefined, drop: readonly string[] = []): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (drop.includes(key)) continue;
    if (value === undefined) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else if (value !== null && typeof value === 'object' && 'toFixed' in (value as object) && typeof (value as { toFixed: unknown }).toFixed === 'function') out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

const rows = (list: Record<string, unknown>[], drop: readonly string[] = []) => list.map((row) => plain(row, drop)!);

/** Every document column on a KYC record ends in `Url` or holds a payload; none of them travels. */
const kycDrop = (row: Record<string, unknown>) => Object.keys(row).filter((key) => /Url$/.test(key) || key === 'bankStatement' || key === 'digioPayload' || key === 'fileId' || key === 'selfVideoUrl');

const USER_DROP = ['passwordHash', 'emailOtpFallbackCount', 'emailOtpFallbackResetAt', 'closedById', 'twoFactorRequiredAt'] as const;
const SESSION_DROP = ['tokenHash'] as const;

export const prismaDataExportRepository: DataExportRepository = {
  create(userId, now) {
    return prisma.dataExportRequest.create({ data: { userId, status: 'PENDING', requestedAt: now } });
  },

  findById(id) {
    return prisma.dataExportRequest.findUnique({ where: { id } });
  },

  findLatest(userId) {
    return prisma.dataExportRequest.findFirst({ where: { userId }, orderBy: { requestedAt: 'desc' } });
  },

  findOpen(userId, now) {
    return prisma.dataExportRequest.findFirst({
      where: { userId, OR: [{ status: 'PENDING' }, { status: 'READY', expiresAt: { gt: now } }] },
      orderBy: { requestedAt: 'desc' },
    });
  },

  findPending(limit) {
    return prisma.dataExportRequest.findMany({ where: { status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, take: limit });
  },

  markReady(id, patch) {
    return prisma.dataExportRequest.update({ where: { id }, data: { status: 'READY', fileId: patch.fileId, readyAt: patch.readyAt, expiresAt: patch.expiresAt, error: null } });
  },

  markFailed(id, error) {
    return prisma.dataExportRequest.update({ where: { id }, data: { status: 'FAILED', error: error.slice(0, 500) } });
  },

  findExpired(now) {
    return prisma.dataExportRequest.findMany({ where: { status: 'READY', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' } });
  },

  markExpired(id) {
    return prisma.dataExportRequest.update({ where: { id }, data: { status: 'EXPIRED', fileId: null } });
  },

  async deleteFinishedBefore(before) {
    const result = await prisma.dataExportRequest.deleteMany({
      where: { status: { in: ['EXPIRED', 'FAILED'] }, requestedAt: { lt: before } },
    });
    return result.count;
  },

  async assemble(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: { select: { role: true } },
        publisherProfile: { include: { kyc: true } },
        advertiserProfile: true,
        agentProfile: { include: { kyc: true } },
        advertiserKyc: true,
        userKyc: true,
      },
    });
    if (!user) return null;

    const { roles, publisherProfile, advertiserProfile, agentProfile, advertiserKyc, userKyc, ...profile } = user;
    const publisherId = publisherProfile?.id ?? null;
    const advertiserId = advertiserProfile?.id ?? null;
    const agentId = agentProfile?.id ?? null;
    const { kyc: publisherKyc, ...publisher } = publisherProfile ?? { kyc: null };
    const { kyc: agentKyc, ...agent } = agentProfile ?? { kyc: null };

    const [listings, ordersAsAdvertiser, ordersOnListings, campaigns, wallets, notifications, sessions, activity, notificationPreferences, accountPreferences, documentDecisions] =
      await Promise.all([
        publisherId
          ? prisma.listing.findMany({
              where: { publisherId },
              select: { id: true, displayId: true, title: true, category: true, address: true, city: true, ratePerDay: true, status: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            })
          : [],
        prisma.order.findMany({
          where: { advertiserId: userId },
          select: { id: true, listingId: true, status: true, campaignName: true, startDate: true, endDate: true, installBy: true, createdAt: true, cancelledAt: true, cancellationReason: true },
          orderBy: { createdAt: 'asc' },
        }),
        publisherId
          ? prisma.order.findMany({
              where: { listing: { publisherId } },
              select: { id: true, listingId: true, status: true, campaignName: true, startDate: true, endDate: true, installBy: true, publisherAcceptedAt: true, publisherRejectedAt: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            })
          : [],
        advertiserId
          ? prisma.campaign.findMany({
              where: { advertiserId },
              select: { id: true, reference: true, name: true, status: true, budget: true, total: true, startDate: true, endDate: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            })
          : [],
        prisma.wallet.findMany({
          where: {
            OR: [
              ...(advertiserId ? [{ advertiserId }] : []),
              ...(publisherId ? [{ publisherId }] : []),
              ...(agentId ? [{ agentId }] : []),
            ],
          },
          include: {
            entries: { orderBy: { createdAt: 'asc' } },
            withdrawals: { orderBy: { requestedAt: 'asc' } },
          },
        }),
        prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.activityLog.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.notificationPreference.findMany({ where: { userId }, select: { type: true, channel: true, enabled: true } }),
        prisma.userPreference.findMany({ where: { userId }, select: { key: true, value: true, updatedAt: true } }),
        prisma.kycDocumentReview.findMany({
          where: {
            OR: [
              ...(publisherKyc ? [{ partyType: 'PUBLISHER' as const, kycId: publisherKyc.id }] : []),
              ...(advertiserKyc ? [{ partyType: 'ADVERTISER' as const, kycId: advertiserKyc.id }] : []),
            ],
          },
          select: { partyType: true, field: true, decision: true, note: true, reviewedAt: true },
          orderBy: { reviewedAt: 'asc' },
        }),
      ]);

    const invoices = advertiserId
      ? await prisma.invoice.findMany({
          where: { advertiserId },
          select: { id: true, number: true, kind: true, status: true, campaignId: true, packageSaleId: true, issuedAt: true, dueAt: true, taxableValue: true, cgst: true, sgst: true, igst: true, total: true, currency: true },
          orderBy: { issuedAt: 'asc' },
        })
      : [];

    const orders = [
      ...ordersAsAdvertiser.map((row) => ({ side: 'ADVERTISER', ...row })),
      ...ordersOnListings.map((row) => ({ side: 'PUBLISHER', ...row })),
    ];

    return {
      profile: plain(profile, USER_DROP),
      roles: roles.map((row) => row.role),
      parties: {
        publisher: publisherId ? plain(publisher as Record<string, unknown>) : null,
        advertiser: plain(advertiserProfile as Record<string, unknown> | null),
        agent: agentId ? plain(agent as Record<string, unknown>) : null,
      },
      kyc: {
        publisher: publisherKyc ? plain(publisherKyc as Record<string, unknown>, kycDrop(publisherKyc as Record<string, unknown>)) : null,
        advertiser: advertiserKyc ? plain(advertiserKyc as Record<string, unknown>, kycDrop(advertiserKyc as Record<string, unknown>)) : null,
        agent: agentKyc ? plain(agentKyc as Record<string, unknown>, kycDrop(agentKyc as Record<string, unknown>)) : null,
        user: userKyc ? plain(userKyc as Record<string, unknown>, kycDrop(userKyc as Record<string, unknown>)) : null,
        documentDecisions: rows(documentDecisions as Record<string, unknown>[]),
      },
      listings: rows(listings as Record<string, unknown>[]),
      orders: rows(orders as Record<string, unknown>[]),
      campaigns: rows(campaigns as Record<string, unknown>[]),
      wallets: wallets.map(({ entries, withdrawals: _withdrawals, ...wallet }) => ({
        wallet: plain(wallet as Record<string, unknown>, ['frozenById'])!,
        entries: rows(entries as Record<string, unknown>[]),
      })),
      withdrawals: rows(wallets.flatMap((wallet) => wallet.withdrawals) as Record<string, unknown>[], ['decidedByUserId']),
      invoices: rows(invoices as Record<string, unknown>[]),
      notifications: rows(notifications as Record<string, unknown>[]),
      sessions: rows(sessions as Record<string, unknown>[], SESSION_DROP),
      activity: rows(activity as Record<string, unknown>[]),
      preferences: {
        notifications: rows(notificationPreferences as Record<string, unknown>[]),
        account: accountPreferences.length ? Object.fromEntries(accountPreferences.map((row) => [row.key, row.value])) : null,
      },
    } satisfies AssembledExport;
  },
};
