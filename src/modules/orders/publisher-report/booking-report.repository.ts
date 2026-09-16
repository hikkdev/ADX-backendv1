import type { Prisma } from '../../../shared/database';

/**
 * The publisher's booking report — G6 (Q110).
 *
 * One read: the order with the spot, the campaign it belongs to, the
 * milestones and their photo evidence, the agent's own photos, the tracking
 * codes on the spot and the accruals the flight has earned. The listing's
 * publisher rides along so the policy can say whose booking it is without a
 * second query. Read-only across `orders`' own tables and the narrow slices
 * of `listings`, `order-milestones`, `campaigns` and `earnings` it joins —
 * the arrangement `publishers/book` and `admin-overview` already make.
 */

export interface BookingPublisher {
  id: string;
  userId: string | null;
  agentId: string | null;
  name: string;
  displayId: string | null;
}

export interface BookingPhoto {
  id: string;
  kind: string;
  label: string | null;
  url: string;
  capturedAt: Date;
}

export interface BookingMilestone {
  id: string;
  order: number;
  title: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  scheduledStart: Date | null;
  dueDate: Date | null;
  /** The photo evidence only — `kind === 'photo'`, value is the URL. */
  photos: { id: string; label: string | null; url: string; createdAt: Date }[];
}

export interface BookingAccrual {
  forDate: Date;
  gross: Prisma.Decimal;
  commission: Prisma.Decimal;
  taxWithheld: Prisma.Decimal;
  net: Prisma.Decimal;
  clearsAt: Date;
  walletEntryId: string | null;
}

export interface BookingRecord {
  order: {
    id: string;
    status: string;
    campaignName: string | null;
    startDate: Date | null;
    endDate: Date | null;
    installBy: string | null;
    publisherAcceptedAt: Date | null;
    slotTime: Date | null;
    adminApprovedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    selfInstallCollectPhotoUrl: string | null;
    selfInstallConditionPhotoUrls: string[];
    selfInstallInstallPhotoUrl: string | null;
  };
  listing: {
    id: string;
    displayId: string | null;
    title: string;
    address: string;
    city: string | null;
    estimatedDailyFootfall: number | null;
  };
  publisher: BookingPublisher | null;
  agentName: string | null;
  spot: {
    id: string;
    ratePerDay: Prisma.Decimal;
    days: number;
    quantity: number;
    startDate: Date | null;
    endDate: Date | null;
    campaign: { id: string; reference: string; name: string; startDate: Date | null; endDate: Date | null; status: string };
    codes: { id: string; scans: number; clicks: number }[];
    accruals: BookingAccrual[];
  } | null;
  photos: BookingPhoto[];
  milestones: BookingMilestone[];
  verification: { verifiedAt: Date | null; qrScanned: boolean; checklistPassed: boolean } | null;
  checkIn: { checkedInAt: Date; distanceM: number } | null;
}

export interface BookingReportRepository {
  findBooking(orderId: string): Promise<BookingRecord | null>;
  /** Landing-page and redirect interactions on these codes — every event type but SCAN. */
  countInteractions(codeIds: readonly string[]): Promise<number>;
}
