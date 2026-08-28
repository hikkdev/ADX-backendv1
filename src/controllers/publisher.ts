import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { upperEnum } from '../shared/validation';
import { prisma } from '../shared/database';
import {
  createPublisher, getPublishersForAgent, getPublisherById, updatePublisher,
  submitKyc, reviewKyc,
  createListing, getListingsForPublisher, updateListing, publishListing,
} from '../services/publisher.service';
import { generateQr } from '../services/qr.service';
import type { PublisherType, KycStatus, ListingCategory } from '../shared/database';

const ONBOARDING_CLAIM_TTL_HOURS = 48;

// ─── Publishers ───────────────────────────────────────────────────────────────

const createPublisherSchema = z.object({
  name: z.string().min(1),
  mobile: z.string().min(10),
  email: z.string().email().optional(),
  type: upperEnum(['INDIVIDUAL', 'BUSINESS', 'NGO', 'POLITICAL'] as const).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export async function createPublisherHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const publisher = await createPublisher({ ...parsed.data, agentId: agent.id, type: parsed.data.type as PublisherType });
  res.status(201).json({ success: true, data: publisher });
}

export async function getPublishersHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const publishers = await getPublishersForAgent(agent.id, req.query['category'] as string);
  res.json({ success: true, data: publishers });
}

export async function getPublisherHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;
  const publisher = await getPublisherById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent || publisher.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');
  res.json({ success: true, data: publisher });
}

export async function updatePublisherHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;
  const parsed = z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    type: upperEnum(['INDIVIDUAL', 'BUSINESS', 'NGO', 'POLITICAL'] as const).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const [existing, agent] = await Promise.all([
    getPublisherById(publisherId),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || existing.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');

  const publisher = await updatePublisher(publisherId, parsed.data);
  res.json({ success: true, data: publisher });
}

// ─── KYC ─────────────────────────────────────────────────────────────────────

const submitKycSchema = z.object({
  aadhaarFrontUrl: z.string().url().optional(),
  aadhaarBackUrl: z.string().url().optional(),
  panFrontUrl: z.string().url().optional(),
  panBackUrl: z.string().url().optional(),
  gstUrl: z.string().url().optional(),
  addressProofUrl: z.string().url().optional(),
  bankStatement: z.string().url().optional(),
  // Business / NGO documents ported from legacy AdSpaceKyc — optional, only
  // relevant for COMMERCIAL / NGO publisher types
  businessRegCertUrl: z.string().url().optional(),
  directorIdUrl: z.string().url().optional(),
  businessAddressProofUrl: z.string().url().optional(),
  adAuthLetterUrl: z.string().url().optional(),
  ngoRegCertUrl: z.string().url().optional(),
  ngoAddressProofUrl: z.string().url().optional(),
  ngoTaxExemptionCertUrl: z.string().url().optional(),
  ngoOperationalOverviewUrl: z.string().url().optional(),
});

export async function submitKycHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;
  const parsed = submitKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const [existing, agent] = await Promise.all([
    getPublisherById(publisherId),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || existing.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');

  const [kyc] = await submitKyc(publisherId, parsed.data);
  res.json({ success: true, data: kyc });
}

export async function reviewKycHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const parsed = z.object({
    status: upperEnum(['VERIFIED', 'REJECTED'] as const),
    rejectionReason: z.string().optional(),
  }).refine(
    (d) => d.status !== 'REJECTED' || (d.rejectionReason && d.rejectionReason.trim().length > 0),
    { message: 'rejectionReason is required when status is REJECTED', path: ['rejectionReason'] },
  ).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const [kyc] = await reviewKyc(publisherId, parsed.data.status as KycStatus, parsed.data.rejectionReason);
  res.json({ success: true, data: kyc });
}

export async function getOnboardingStatusHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;
  const [publisher, agent] = await Promise.all([
    getPublisherById(publisherId),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || publisher.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');

  res.json({
    success: true,
    data: {
      kycStatus: publisher.kycStatus,
      listingsCount: publisher.listings.length,
      kycDocuments: publisher.kyc,
    },
  });
}

// ─── Listings ─────────────────────────────────────────────────────────────────

const createListingSchema = z.object({
  publisherId: z.string().min(1),
  title: z.string().min(1),
  category: upperEnum(['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const),
  subType: z.string().optional(),
  description: z.string().optional(),
  address: z.string().min(1),
  city: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  size: z.string().optional(),
  monthlyPrice: z.number().positive(),
  pricingModel: z.string().optional(),
  availableNow: z.boolean().optional(),
  photos: z.array(z.object({ url: z.string().url(), type: z.string() })).optional(),
  planId: z.string().optional(),
  // ADMIN-only: create on behalf of a specific agent (identified by their
  // AgentProfile id, e.g. from GET /agents) rather than the caller's own.
  agentId: z.string().optional(),
});

export async function createListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = createListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  const { agentId: requestedAgentId, ...rest } = parsed.data;

  let agentId: string;
  if (requestedAgentId) {
    if (!isAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only admins can create a listing on behalf of another agent');
    const agentExists = await prisma.agentProfile.findUnique({ where: { id: requestedAgentId } });
    if (!agentExists) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
    agentId = requestedAgentId;
  } else {
    const userId = req.user!.sub;
    const agent = await prisma.agentProfile.findUnique({ where: { userId } });
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
    agentId = agent.id;
  }

  const listing = await createListing({
    ...rest,
    agentId,
    category: rest.category as ListingCategory,
  });
  res.status(201).json({ success: true, data: listing });
}

export async function getListingsHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;
  const [existing, agent] = await Promise.all([
    getPublisherById(publisherId),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || existing.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this publisher');
  const listings = await getListingsForPublisher(publisherId);
  res.json({ success: true, data: listings });
}

export async function updateListingHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  const parsed = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    monthlyPrice: z.number().positive().optional(),
    availableNow: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const listing = await updateListing(listingId, parsed.data);
  res.json({ success: true, data: listing });
}

export async function getAllListingsHandler(req: Request, res: Response): Promise<void> {
  const listings = await prisma.listing.findMany({
    include: { publisher: true, agent: true, photos: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: listings });
}

export async function publishListingHandler(req: Request, res: Response): Promise<void> {
  const listingId = req.params['listingId'] as string;
  try {
    const listing = await publishListing(listingId);
    res.json({ success: true, data: listing });
  } catch (e: any) {
    if (e.message === 'LISTING_NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
    if (e.message === 'LISTING_NOT_PUBLISHABLE') throw new ApiError(400, 'BAD_REQUEST', 'Listing must be in DRAFT or PENDING_REVIEW state to publish');
    throw e;
  }
}

// ─── Publisher self-service (user app) ───────────────────────────────────────

// POST /publishers/register — called after OTP verified, creates publisher profile + details
export async function registerPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const userId = req.user!.sub;

  const existing = await prisma.publisher.findUnique({ where: { userId } });
  if (existing) {
    res.json({ success: true, data: existing });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  // Update user name
  await prisma.user.update({ where: { id: userId }, data: { name: parsed.data.name, email: parsed.data.email } });

  const publisher = await prisma.publisher.create({
    data: {
      userId,
      name: parsed.data.name,
      mobile: user.mobile,
      email: parsed.data.email,
      onboardingStatus: 'PENDING_ONBOARDING',
    },
  });

  res.status(201).json({ success: true, data: publisher });
}

// GET /publishers/me — get own publisher profile + onboarding status
export async function getMyPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const publisher = await prisma.publisher.findUnique({
    where: { userId },
    include: { kyc: true },
  });
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found. Complete registration first.');
  res.json({ success: true, data: publisher });
}

// GET /publishers/me/qr — generate or return existing active onboarding QR
export async function getMyOnboardingQrHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const publisher = await prisma.publisher.findUnique({ where: { userId } });
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  // Only allowed when pending onboarding (not already claimed or complete)
  if (publisher.onboardingStatus === 'IN_ONBOARDING') {
    throw new ApiError(409, 'CONFLICT', 'Your onboarding is already in progress with an agent.');
  }
  if (publisher.onboardingStatus === 'ONBOARDING_COMPLETE') {
    throw new ApiError(409, 'CONFLICT', 'Onboarding is already complete.');
  }

  // Check if there is already an active QR for this publisher
  const existingQr = await prisma.qrCode.findFirst({
    where: { type: 'PUBLISHER', refId: publisher.id, isActive: true },
  });

  if (existingQr) {
    const env = (await import('../config/env')).env;
    const base = env.BASE_URL ?? '';
    res.json({
      success: true,
      data: {
        qrId: existingQr.id,
        token: existingQr.token,
        pngUrl: `${base}/api/v1/qr/${existingQr.id}/image.png`,
      },
    });
    return;
  }

  // Generate a new QR
  const { qrId, token } = await generateQr('PUBLISHER', publisher.id, ['AGENT_PUBLISHER']);
  const env = (await import('../config/env')).env;
  const base = env.BASE_URL ?? '';

  res.status(201).json({
    success: true,
    data: {
      qrId,
      token,
      pngUrl: `${base}/api/v1/qr/${qrId}/image.png`,
    },
  });
}

// POST /publishers/me/cancel-onboarding — publisher cancels a stale IN_ONBOARDING
// Also called by agent to cancel. Agent version uses /:publisherId/cancel-onboarding.
export async function cancelMyOnboardingHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const publisher = await prisma.publisher.findUnique({ where: { userId } });
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found');

  if (publisher.onboardingStatus !== 'IN_ONBOARDING' && publisher.onboardingStatus !== 'PENDING_ONBOARDING') {
    throw new ApiError(400, 'BAD_REQUEST', 'Nothing to cancel');
  }

  await _resetOnboarding(publisher.id);
  res.json({ success: true, data: { message: 'Onboarding cancelled. You can generate a new QR.' } });
}

// POST /publishers/:publisherId/cancel-onboarding — agent or admin cancels
export async function cancelOnboardingHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const publisher = await prisma.publisher.findUnique({ where: { id: publisherId } });
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');

  await _resetOnboarding(publisherId);
  res.json({ success: true, data: { message: 'Onboarding cancelled.' } });
}

// POST /publishers/:publisherId/complete-onboarding — agent marks onboarding done
export async function completeOnboardingHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const userId = req.user!.sub;

  const [publisher, agent] = await Promise.all([
    prisma.publisher.findUnique({ where: { id: publisherId } }),
    prisma.agentProfile.findUnique({ where: { userId } }),
  ]);

  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!agent || publisher.agentId !== agent.id) {
    const isAdmin = req.user?.roles?.includes('ADMIN');
    if (!isAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only the claiming agent or admin can complete this onboarding');
  }
  if (publisher.onboardingStatus !== 'IN_ONBOARDING') {
    throw new ApiError(400, 'BAD_REQUEST', 'Onboarding is not in progress');
  }

  await prisma.publisher.update({
    where: { id: publisherId },
    data: { onboardingStatus: 'ONBOARDING_COMPLETE' },
  });

  res.json({ success: true, data: { message: 'Onboarding complete. Publisher dashboard is now unlocked.' } });
}

async function _resetOnboarding(publisherId: string): Promise<void> {
  // Expire all active QRs for this publisher
  await prisma.qrCode.updateMany({
    where: { type: 'PUBLISHER', refId: publisherId, isActive: true },
    data: { isActive: false },
  });
  // Reset publisher state
  await prisma.publisher.update({
    where: { id: publisherId },
    data: {
      onboardingStatus: 'PENDING_ONBOARDING',
      agentId: null,
      claimedAt: null,
    },
  });
}
