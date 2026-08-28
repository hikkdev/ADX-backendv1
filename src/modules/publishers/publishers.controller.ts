import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import { getListingsForPublisher } from '../listings';
import type { KycStatus, PublisherType } from '../../shared/database';
import {
  createPublisherSchema,
  reviewKycSchema,
  submitKycSchema,
  updatePublisherSchema,
} from './publishers.schema';
import {
  createPublisher,
  getOnboardingStatus,
  getOwnedPublisher,
  getPublishersForAgent,
  reviewKyc,
  submitKyc,
  updatePublisher,
} from './publishers.service';

export async function createPublisherHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const agent = await requireAgentProfile(req.user!.sub);
  const publisher = await createPublisher({
    ...parsed.data,
    agentId: agent.id,
    type: parsed.data.type as PublisherType,
  });
  res.status(201).json({ success: true, data: publisher });
}

export async function getPublishersHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const publishers = await getPublishersForAgent(agent.id, req.query['category'] as string);
  res.json({ success: true, data: publishers });
}

export async function getPublisherHandler(req: Request, res: Response): Promise<void> {
  const publisher = await getOwnedPublisher(req.params['publisherId'] as string, req.user!.sub);
  res.json({ success: true, data: publisher });
}

export async function updatePublisherHandler(req: Request, res: Response): Promise<void> {
  const parsed = updatePublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const publisher = await updatePublisher(
    req.params['publisherId'] as string,
    req.user!.sub,
    parsed.data as { type?: PublisherType },
  );
  res.json({ success: true, data: publisher });
}

export async function submitKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = submitKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await submitKyc(req.params['publisherId'] as string, req.user!.sub, parsed.data);
  res.json({ success: true, data: kyc });
}

export async function reviewKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await reviewKyc(
    req.params['publisherId'] as string,
    parsed.data.status as KycStatus,
    parsed.data.rejectionReason,
  );
  res.json({ success: true, data: kyc });
}

export async function getOnboardingStatusHandler(req: Request, res: Response): Promise<void> {
  const status = await getOnboardingStatus(req.params['publisherId'] as string, req.user!.sub);
  res.json({ success: true, data: status });
}

/**
 * GET /publishers/:publisherId/listings
 *
 * Lives on the publisher router because access is scoped by publisher
 * ownership; the listing query itself belongs to the listings module.
 */
export async function getPublisherListingsHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  await getOwnedPublisher(publisherId, req.user!.sub);
  res.json({ success: true, data: await getListingsForPublisher(publisherId) });
}
