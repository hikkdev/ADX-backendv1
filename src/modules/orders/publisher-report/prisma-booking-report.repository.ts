import { prisma } from '../../../shared/database';
import type { BookingRecord, BookingReportRepository } from './booking-report.repository';

export const prismaBookingReportRepository: BookingReportRepository = {
  async findBooking(orderId: string): Promise<BookingRecord | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        campaignName: true,
        startDate: true,
        endDate: true,
        installBy: true,
        publisherAcceptedAt: true,
        slotTime: true,
        adminApprovedAt: true,
        cancelledAt: true,
        createdAt: true,
        selfInstallCollectPhotoUrl: true,
        selfInstallConditionPhotoUrls: true,
        selfInstallInstallPhotoUrl: true,
        listing: {
          select: {
            id: true,
            displayId: true,
            title: true,
            address: true,
            city: true,
            estimatedDailyFootfall: true,
            publisher: { select: { id: true, userId: true, agentId: true, name: true, displayId: true } },
          },
        },
        agent: { select: { user: { select: { name: true } } } },
        campaignSpot: {
          select: {
            id: true,
            ratePerDay: true,
            days: true,
            quantity: true,
            startDate: true,
            endDate: true,
            campaign: { select: { id: true, reference: true, name: true, startDate: true, endDate: true, status: true } },
            codes: { select: { id: true, scans: true, clicks: true } },
            earningAccruals: {
              select: { forDate: true, gross: true, commission: true, taxWithheld: true, net: true, clearsAt: true, walletEntryId: true },
              orderBy: { forDate: 'asc' },
            },
          },
        },
        photos: { select: { id: true, kind: true, label: true, url: true, capturedAt: true }, orderBy: { capturedAt: 'asc' } },
        milestones: {
          select: {
            id: true,
            order: true,
            status: true,
            startedAt: true,
            completedAt: true,
            scheduledStart: true,
            dueDate: true,
            template: { select: { title: true } },
            evidence: { select: { id: true, kind: true, label: true, value: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
          orderBy: { order: 'asc' },
        },
        verification: { select: { verifiedAt: true, qrScanned: true, checklistPassed: true } },
        checkIn: { select: { checkedInAt: true, distanceM: true } },
      },
    });
    if (!order) return null;

    const { listing, agent, campaignSpot, photos, milestones, verification, checkIn, ...rest } = order;
    const { publisher, ...listingRest } = listing;
    return {
      order: rest,
      listing: listingRest,
      publisher: publisher ?? null,
      agentName: agent?.user.name ?? null,
      spot: campaignSpot
        ? {
            id: campaignSpot.id,
            ratePerDay: campaignSpot.ratePerDay,
            days: campaignSpot.days,
            quantity: campaignSpot.quantity,
            startDate: campaignSpot.startDate,
            endDate: campaignSpot.endDate,
            campaign: campaignSpot.campaign,
            codes: campaignSpot.codes,
            accruals: campaignSpot.earningAccruals,
          }
        : null,
      photos,
      milestones: milestones.map((milestone) => ({
        id: milestone.id,
        order: milestone.order,
        title: milestone.template.title,
        status: milestone.status,
        startedAt: milestone.startedAt,
        completedAt: milestone.completedAt,
        scheduledStart: milestone.scheduledStart,
        dueDate: milestone.dueDate,
        photos: milestone.evidence
          .filter((item) => item.kind === 'photo' && item.value)
          .map((item) => ({ id: item.id, label: item.label, url: item.value, createdAt: item.createdAt })),
      })),
      verification,
      checkIn,
    };
  },

  async countInteractions(codeIds) {
    if (codeIds.length === 0) return 0;
    return prisma.trackingEvent.count({ where: { codeId: { in: [...codeIds] }, type: { not: 'SCAN' } } });
  },
};
