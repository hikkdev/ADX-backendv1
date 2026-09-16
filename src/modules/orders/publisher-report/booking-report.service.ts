import type { Request } from 'express';
import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { Decimal, money } from '../../../shared/money';
import { liveGrantFor } from '../../access-grants';
import { findAgentProfile } from '../../agents';
import { isFeatureEnabled } from '../../feature-flags';
import { storeGeneratedFile } from '../../uploads';
import { prismaBookingReportRepository as repository } from './prisma-booking-report.repository';
import type { BookingRecord } from './booking-report.repository';
import { renderBookingReportPdf, type BookingReportData } from './booking-report.pdf';
import { photoBytes } from './photo-bytes';

/**
 * The publisher's booking report and spot insights — G6 (Q110).
 *
 * Both hang off `/publishers/me/bookings/:orderId` and both answer the same
 * question first: is this the caller's booking? The listing's publisher is
 * the owner; an AGENT_PUBLISHER reaches it only under a live grant on that
 * publisher (PROFILE or LISTINGS — either says "help me with my account").
 * Attribution alone — the agent who onboarded them — does not: the report
 * carries the publisher's money, and money is authority, not history.
 *
 * The report is rendered on request, stored PRIVATE and owned by the
 * publisher (so the app can re-open it through `/files/:id`), audited, and
 * streamed. The insights read is behind the `publisher-spot-insights` flag
 * evaluated for the publisher: off, it is 403 FEATURE_OFF, never an empty
 * object — the screen draws the gate, not a zero.
 */

export type BookingActor = { userId: string; roles: readonly string[] };

export const PUBLISHER_SPOT_INSIGHTS_FLAG = 'publisher-spot-insights';
/** How many photos the report carries — the evidence set is small, and a PDF with sixty thumbnails is a PDF nobody opens. */
export const REPORT_PHOTO_CAP = 12;

type Loaded = {
  record: BookingRecord;
  publisher: NonNullable<BookingRecord['publisher']>;
  via: 'OWNER' | 'GRANT';
  grantId: string | null;
};

async function loadBookingFor(orderId: string, actor: BookingActor): Promise<Loaded> {
  const record = await repository.findBooking(orderId);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  const publisher = record.publisher;
  if (!publisher) throw new ApiError(403, 'FORBIDDEN', 'This booking has no publisher on file');
  if (publisher.userId && publisher.userId === actor.userId) return { record, publisher, via: 'OWNER', grantId: null };

  const agent = await findAgentProfile(actor.userId);
  if (agent) {
    const grant =
      (await liveGrantFor(agent.id, { publisherId: publisher.id }, 'PROFILE')) ??
      (await liveGrantFor(agent.id, { publisherId: publisher.id }, 'LISTINGS'));
    if (grant) return { record, publisher, via: 'GRANT', grantId: grant.id };
  }
  throw new ApiError(403, 'FORBIDDEN', 'This is not your booking. Ask the publisher to scan you in.');
}

/* ── the report ──────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

export function earningsOf(record: BookingRecord, now: Date): BookingReportData['earnings'] {
  const accruals = record.spot?.accruals ?? [];
  const posted = accruals.filter((row) => row.walletEntryId !== null);
  const cleared = posted.filter((row) => row.clearsAt.getTime() <= now.getTime());
  const net = sum(accruals.map((row) => row.net));
  const clearedNet = sum(cleared.map((row) => row.net));
  const daysTotal = record.spot?.days ?? null;
  return {
    daysAccrued: accruals.length,
    daysTotal,
    gross: money(sum(accruals.map((row) => row.gross))),
    commission: money(sum(accruals.map((row) => row.commission))),
    taxWithheld: money(sum(accruals.map((row) => row.taxWithheld))),
    net: money(net),
    cleared: money(clearedNet),
    held: money(net.minus(clearedNet)),
    status: accruals.length === 0 ? 'NOT_ACCRUED' : daysTotal !== null && accruals.length < daysTotal ? 'ACCRUING' : 'ACCRUED',
    ledger: posted.length === 0 ? 'NOT_POSTED' : posted.length < accruals.length ? 'PARTLY_POSTED' : 'POSTED',
  };
}

const PHOTO_LABELS: Record<string, string> = {
  PICKUP: 'Material collected',
  CONDITION: 'Site before installation',
  INSTALLATION: 'Installed',
  REJECTION: 'Site refused',
};

/** Every photo the booking holds, in the order the work happened, capped. */
export function photosOf(record: BookingRecord): { label: string; capturedAt: Date | null; url: string }[] {
  const out: { label: string; capturedAt: Date | null; url: string }[] = [];
  for (const photo of record.photos) {
    out.push({ label: photo.label ?? PHOTO_LABELS[photo.kind] ?? photo.kind, capturedAt: photo.capturedAt, url: photo.url });
  }
  if (record.order.selfInstallCollectPhotoUrl) out.push({ label: 'Material collected (self-install)', capturedAt: null, url: record.order.selfInstallCollectPhotoUrl });
  for (const url of record.order.selfInstallConditionPhotoUrls) out.push({ label: 'Site before installation (self-install)', capturedAt: null, url });
  if (record.order.selfInstallInstallPhotoUrl) out.push({ label: 'Installed (self-install)', capturedAt: null, url: record.order.selfInstallInstallPhotoUrl });
  for (const milestone of record.milestones) {
    for (const photo of milestone.photos) {
      out.push({ label: photo.label ?? milestone.title, capturedAt: photo.createdAt, url: photo.url });
    }
  }
  const seen = new Set<string>();
  return out.filter((photo) => (seen.has(photo.url) ? false : (seen.add(photo.url), true))).slice(0, REPORT_PHOTO_CAP);
}

/** The booking's own steps first — placed, accepted, slot, check-in, verified, approved — then the milestone plan's rows. */
export function milestonesOf(record: BookingRecord): BookingReportData['milestones'] {
  const { order, checkIn, verification } = record;
  const steps: BookingReportData['milestones'] = [{ title: 'Booking placed', status: 'COMPLETED', at: order.createdAt, note: null }];
  if (order.publisherAcceptedAt) steps.push({ title: 'Accepted by publisher', status: 'COMPLETED', at: order.publisherAcceptedAt, note: null });
  if (order.slotTime) steps.push({ title: 'Installation slot', status: order.slotTime.getTime() <= Date.now() ? 'COMPLETED' : 'PENDING', at: order.slotTime, note: null });
  if (checkIn) steps.push({ title: 'Agent checked in on site', status: 'COMPLETED', at: checkIn.checkedInAt, note: `${Math.round(checkIn.distanceM)} m from the spot` });
  if (verification?.verifiedAt) {
    steps.push({ title: 'Site verified', status: 'COMPLETED', at: verification.verifiedAt, note: [verification.qrScanned ? 'QR scanned' : null, verification.checklistPassed ? 'checklist passed' : null].filter(Boolean).join(' · ') || null });
  }
  if (order.adminApprovedAt) steps.push({ title: 'Approved by ADX', status: 'COMPLETED', at: order.adminApprovedAt, note: null });
  if (order.cancelledAt) steps.push({ title: 'Cancelled', status: 'COMPLETED', at: order.cancelledAt, note: null });
  for (const milestone of record.milestones) {
    steps.push({
      title: milestone.title,
      status: milestone.status,
      at: milestone.completedAt ?? milestone.startedAt ?? milestone.scheduledStart ?? milestone.dueDate,
      note: null,
    });
  }
  return steps;
}

export async function buildBookingReportData(record: BookingRecord, now: Date): Promise<BookingReportData> {
  const publisher = record.publisher!;
  const start = record.spot?.startDate ?? record.order.startDate;
  const end = record.spot?.endDate ?? record.order.endDate;
  const photos = await Promise.all(photosOf(record).map(async (photo) => ({ label: photo.label, capturedAt: photo.capturedAt, bytes: await photoBytes(photo.url) })));
  return {
    generatedAt: now,
    orderId: record.order.id,
    publisher: { name: publisher.name, displayId: publisher.displayId },
    spot: { title: record.listing.title, displayId: record.listing.displayId, address: record.listing.address, city: record.listing.city },
    campaign: record.spot ? { name: record.spot.campaign.name, reference: record.spot.campaign.reference, status: record.spot.campaign.status } : record.order.campaignName ? { name: record.order.campaignName, reference: '—', status: record.order.status } : null,
    flight: { start, end, days: record.spot?.days ?? null, quantity: record.spot?.quantity ?? 1 },
    order: { status: record.order.status, installBy: record.order.installBy, agentName: record.agentName },
    milestones: milestonesOf(record),
    photos,
    earnings: earningsOf(record, now),
  };
}

/** GET /publishers/me/bookings/:orderId/report.pdf */
export async function bookingReportPdf(orderId: string, actor: BookingActor, req?: Request, now = new Date()): Promise<{ buffer: Buffer; filename: string; fileId: string | null }> {
  const { record, publisher, via, grantId } = await loadBookingFor(orderId, actor);
  const data = await buildBookingReportData(record, now);
  const buffer = await renderBookingReportPdf(data);
  const filename = `booking-report-${orderId}.pdf`;

  let fileId: string | null = null;
  try {
    const stored = await storeGeneratedFile(publisher.userId ?? actor.userId, {
      content: buffer,
      filename,
      mimeType: 'application/pdf',
      purpose: 'BOOKING_REPORT',
      ownerUserId: publisher.userId,
    });
    fileId = stored.id;
  } catch (err) {
    logger.warn('Could not store the booking report; served unstored', { orderId, reason: err instanceof Error ? err.message : String(err) });
  }

  await logActivity(actor.userId, 'BOOKING_REPORT_GENERATED', {
    req,
    targetType: 'Order',
    targetId: orderId,
    module: 'orders',
    metadata: { publisherId: publisher.id, via, grantId, fileId, photos: data.photos.length, net: data.earnings.net },
  });
  return { buffer, filename, fileId };
}

/* ── spot insights ───────────────────────────────────────────────── */

export type SpotInsights = {
  scans: number;
  /** Publisher-stated daily footfall × days run × faces; null when the spot states no footfall. */
  estimatedReach: number | null;
  /** Landing-page and redirect events on the spot's codes — every event but the scan itself. */
  interactions: number;
};

/** Days the spot has run so far, from its start to the earlier of its end and now; 0 before it starts. */
export function daysElapsed(start: Date | null, end: Date | null, now: Date): number {
  if (!start || start.getTime() > now.getTime()) return 0;
  const until = end && end.getTime() < now.getTime() ? end : now;
  return Math.floor((until.getTime() - start.getTime()) / DAY_MS) + 1;
}

/** GET /publishers/me/bookings/:orderId/insights — 403 FEATURE_OFF unless the flag is on for this publisher. */
export async function spotInsights(orderId: string, actor: BookingActor, now = new Date()): Promise<SpotInsights> {
  const { record, publisher } = await loadBookingFor(orderId, actor);
  if (!(await isFeatureEnabled(PUBLISHER_SPOT_INSIGHTS_FLAG, publisher.id))) {
    throw new ApiError(403, 'FEATURE_OFF', 'Spot insights are not switched on for this account yet', { flag: PUBLISHER_SPOT_INSIGHTS_FLAG });
  }
  const codes = record.spot?.codes ?? [];
  const scans = codes.reduce((total, code) => total + code.scans, 0);
  const interactions = await repository.countInteractions(codes.map((code) => code.id));
  const start = record.spot?.startDate ?? record.order.startDate;
  const end = record.spot?.endDate ?? record.order.endDate;
  const footfall = record.listing.estimatedDailyFootfall;
  const estimatedReach = footfall ? footfall * daysElapsed(start, end, now) * (record.spot?.quantity ?? 1) : null;
  return { scans, estimatedReach, interactions };
}
