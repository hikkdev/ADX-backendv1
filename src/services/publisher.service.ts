import { prisma } from '../lib/prisma';
import type { PublisherType, KycStatus, ListingCategory, ListingStatus } from '../generated/prisma';

// ─── Publishers ───────────────────────────────────────────────────────────────

export async function createPublisher(data: {
  agentId: string;
  name: string;
  mobile: string;
  email?: string;
  type?: PublisherType;
  city?: string;
  state?: string;
}) {
  const { type, email, city, state, ...required } = data;
  const publisher = await prisma.publisher.create({
    data: {
      ...required,
      ...(type !== undefined ? { type } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(city !== undefined ? { city } : {}),
      ...(state !== undefined ? { state } : {}),
      kyc: { create: {} },
    },
    include: { kyc: true, listings: true },
  });
  return publisher;
}

export async function getPublishersForAgent(agentId: string, category?: string) {
  return prisma.publisher.findMany({
    where: {
      agentId,
      ...(category === 'KYC' ? { kycStatus: 'VERIFIED' as const } : {}),
    },
    include: {
      kyc: true,
      listings: { include: { photos: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPublisherById(publisherId: string) {
  return prisma.publisher.findUnique({
    where: { id: publisherId },
    include: {
      kyc: true,
      listings: { include: { photos: true } },
    },
  });
}

export async function updatePublisher(
  publisherId: string,
  data: Partial<{ name: string; email: string; type: PublisherType; city: string; state: string }>,
) {
  return prisma.publisher.update({
    where: { id: publisherId },
    data,
    include: { kyc: true, listings: true },
  });
}

// ─── KYC ─────────────────────────────────────────────────────────────────────

export async function submitKyc(
  publisherId: string,
  docs: {
    aadhaarFrontUrl?: string;
    aadhaarBackUrl?: string;
    panFrontUrl?: string;
    panBackUrl?: string;
    gstUrl?: string;
    addressProofUrl?: string;
    bankStatement?: string;
    businessRegCertUrl?: string;
    directorIdUrl?: string;
    businessAddressProofUrl?: string;
    adAuthLetterUrl?: string;
    ngoRegCertUrl?: string;
    ngoAddressProofUrl?: string;
    ngoTaxExemptionCertUrl?: string;
    ngoOperationalOverviewUrl?: string;
  },
) {
  return prisma.$transaction([
    prisma.publisherKyc.upsert({
      where: { publisherId },
      update: { ...docs, status: 'PENDING', submittedAt: new Date() },
      create: { publisherId, ...docs, status: 'PENDING', submittedAt: new Date() },
    }),
    prisma.publisher.update({
      where: { id: publisherId },
      data: { kycStatus: 'PENDING' },
    }),
  ]);
}

export async function reviewKyc(
  publisherId: string,
  status: KycStatus,
  rejectionReason?: string,
) {
  return prisma.$transaction([
    prisma.publisherKyc.update({
      where: { publisherId },
      data: { status, rejectionReason, reviewedAt: new Date() },
    }),
    prisma.publisher.update({
      where: { id: publisherId },
      data: { kycStatus: status },
    }),
  ]);
}

// ─── Listings ─────────────────────────────────────────────────────────────────

export async function createListing(data: {
  publisherId: string;
  agentId: string;
  title: string;
  category: ListingCategory;
  subType?: string;
  description?: string;
  address: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  size?: string;
  monthlyPrice: number;
  pricingModel?: string;
  availableNow?: boolean;
  photos?: { url: string; type: string }[];
  planId?: string;
}) {
  const { photos, ...rest } = data;
  return prisma.listing.create({
    data: {
      ...rest,
      photos: photos?.length ? { create: photos } : undefined,
    },
    include: { photos: true },
  });
}

export async function getListingsForPublisher(publisherId: string) {
  return prisma.listing.findMany({
    where: { publisherId },
    include: { photos: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateListing(
  listingId: string,
  data: Partial<{
    title: string;
    description: string;
    monthlyPrice: number;
    availableNow: boolean;
    status: ListingStatus;
  }>,
) {
  return prisma.listing.update({
    where: { id: listingId },
    data,
    include: { photos: true },
  });
}

export async function publishListing(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  if (listing.status !== 'DRAFT' && listing.status !== 'PENDING_REVIEW') {
    throw new Error('LISTING_NOT_PUBLISHABLE');
  }
  return prisma.listing.update({
    where: { id: listingId },
    data: { status: 'ACTIVE', publishedAt: new Date() },
    include: { photos: true },
  });
}
