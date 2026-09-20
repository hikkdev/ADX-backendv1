import type { Request, Response } from 'express';
import { actorLabelFor } from '../access-control';
import { doorProvenance } from '../../shared/onboarding';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { agentExists, requireAgentProfile } from '../agents';
import { getListingsForPublisher } from '../listings';
import type { KycStatus, PublisherType } from '../../shared/database';
import { translateListings } from '../ai';
import { assignCaseSchema, bulkAssignSchema, documentDecisionSchema, kycEscalateSchema, kycRequestSchema, reuploadRequestSchema } from '../kyc';
import { assignKycCase, assignKycCases, escalateKycCase, recordKycAtDesk, requestKycFromDesk, requestKycReupload, reviewKycDocument } from './kyc/kyc-desk.service';
import { stampBelowFloor } from './my-listings.service';
import {
  createPublisherSchema,
  reviewKycSchema,
  submitKycSchema,
  updatePublisherSchema,
  kycQueueQuerySchema,
  publisherBareQuerySchema,
  publisherRosterQuerySchema,
} from './publishers.schema';
import {
  createPublisher,
  getOnboardingStatus,
  getOwnedPublisher,
  getAllPublishers,
  getPublisherRoster,
  getPublishersForAgent,
  reviewKyc,
  submitKyc,
  updatePublisher,
  updatePublisherAtDesk,
  listKycQueue,
  getKycCase,
  restartDigioKyc,
} from './publishers.service';

/**
 * Q29: two callers, one route.
 *
 * An agent's publisher is attributed to the agent behind the session — byte
 * for byte what it always was, and a body field can never move it. An admin's
 * is attributed to nobody unless they name an agent in `attributeToAgentId`,
 * and that agent has to exist: a book credited to an id nobody holds is worse
 * than no attribution at all. The admin path is audited under its own action
 * so the two are distinguishable in the trail for ever.
 */
export async function createPublisherHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { attributeToAgentId, ...input } = parsed.data;
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');

  let agentId: string | null;
  if (isAdmin) {
    if (attributeToAgentId && !(await agentExists(attributeToAgentId))) {
      throw new ApiError(404, 'NOT_FOUND', 'No such agent to attribute this publisher to');
    }
    agentId = attributeToAgentId ?? null;
  } else {
    agentId = (await requireAgentProfile(req.user!.sub)).id;
  }

  // QR-14: the door and the person — an admin at the desk, or an agent at the door.
  const publisher = await createPublisher({
    ...input,
    agentId,
    type: input.type as PublisherType,
    ...doorProvenance(isAdmin ? 'DESK' : 'AGENT', req.user!.sub, await actorLabelFor(req.user!.sub, req.user?.roles ?? [])),
  });

  if (isAdmin) {
    await logActivity(req.user!.sub, 'PUBLISHER_CREATED_BY_ADMIN', {
      req,
      targetType: 'Publisher',
      targetId: publisher.id,
      module: 'publishers',
      metadata: { attributedToAgentId: agentId, mobile: publisher.mobile },
    });
  }

  res.status(201).json({ success: true, data: publisher });
}

export async function getPublishersHandler(req: Request, res: Response): Promise<void> {
  // An agent sees the publishers they onboarded; ADX sees the roster. Same
  // route because it answers the same question — "which publishers are mine to
  // look after" — and ADX's answer is all of them.
  if ((req.user?.roles ?? []).includes('ADMIN')) {
    // E10-1: `q` beside `category`; `page` in the query asks for the list
    // contract, its absence keeps the bare array one release.
    if (req.query['page'] !== undefined) {
      const parsed = publisherRosterQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
      res.json({ success: true, data: await getPublisherRoster(parsed.data) });
      return;
    }
    // E12-B: the bare path ignores what the old handler ignored — an empty
    // `q=`, a `pageSize` nobody asked a page for — rather than answering 400.
    const bare = publisherBareQuerySchema.safeParse(req.query);
    if (!bare.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', bare.error.flatten());
    res.json({ success: true, data: await getAllPublishers(bare.data.category, bare.data.q) });
    return;
  }
  const agent = await requireAgentProfile(req.user!.sub);
  const publishers = await getPublishersForAgent(agent.id, req.query['category'] as string);
  res.json({ success: true, data: publishers });
}

export async function getPublisherHandler(req: Request, res: Response): Promise<void> {
  const publisher = await getOwnedPublisher(req.params['publisherId'] as string, req.user!.sub, {
    isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
  });
  res.json({ success: true, data: publisher });
}

export async function updatePublisherHandler(req: Request, res: Response): Promise<void> {
  const parsed = updatePublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // QR-13: the desk edits everything the ladder collects; the agent path is unchanged.
  if ((req.user?.roles ?? []).includes('ADMIN')) {
    const publisher = await updatePublisherAtDesk(req.params['publisherId'] as string, req.user!.sub, parsed.data as { type?: PublisherType });
    res.json({ success: true, data: publisher });
    return;
  }
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
    { userId: req.user!.sub, note: parsed.data.reviewNote ?? null, req },
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
  await getOwnedPublisher(publisherId, req.user!.sub, {
    isAdmin: (req.user?.roles ?? []).includes('ADMIN'),
  });
  // E11-1: the rate-card chip on every row, as the owner's own list carries it.
  const listings = await stampBelowFloor(await getListingsForPublisher(publisherId));
  // Translated on the way out when the reader's language differs and the
  // feature is on; a no-op otherwise, including when the provider is down.
  res.json({ success: true, data: await translateListings(listings, req.user!.sub) });
}

/* ── D7: the ADMIN KYC queue ──────────────────────────────────────────────── */

export async function kycQueueHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycQueueQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await listKycQueue({ ...parsed.data, viewerUserId: req.user!.sub }) });
}

/* ── Lot D (Q42/Q119): the per-document desk ─────────────────────────────── */

// PATCH /publishers/kyc-queue/:publisherId/documents/:field
export async function reviewKycDocumentHandler(req: Request, res: Response): Promise<void> {
  const parsed = documentDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid decision', parsed.error.flatten());
  res.json({
    success: true,
    data: await reviewKycDocument(req.params['publisherId'] as string, req.params['field'] as string, parsed.data, req.user!.sub, req),
  });
}

// POST /publishers/kyc-queue/:publisherId/request-reupload
export async function requestKycReuploadHandler(req: Request, res: Response): Promise<void> {
  const parsed = reuploadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestKycReupload(req.params['publisherId'] as string, parsed.data, req.user!.sub, req) });
}

// PATCH /publishers/kyc-queue/:publisherId/assign
export async function assignKycCaseHandler(req: Request, res: Response): Promise<void> {
  const parsed = assignCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await assignKycCase(req.params['publisherId'] as string, parsed.data, req.user!.sub, req) });
}

// POST /publishers/kyc-queue/:publisherId/escalate — Lot G (Q127/142)
export async function escalateKycCaseHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycEscalateSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await escalateKycCase(req.params['publisherId'] as string, parsed.data, req.user!.sub, req) });
}

// POST /publishers/kyc-queue/assign
export async function assignKycCasesHandler(req: Request, res: Response): Promise<void> {
  const parsed = bulkAssignSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await assignKycCases(parsed.data, req.user!.sub, req) });
}

export async function kycCaseHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getKycCase(req.params['publisherId'] as string) });
}

/* ── Lot N: the desk's two new paths ─────────────────────────────────────── */

// POST /publishers/kyc-queue/:publisherId/request — the desk asks the publisher for their KYC.
export async function requestKycFromDeskHandler(req: Request, res: Response): Promise<void> {
  const parsed = kycRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await requestKycFromDesk(req.params['publisherId'] as string, parsed.data, req.user!.sub, req) });
}

// PUT /publishers/kyc-queue/:publisherId — the desk records the publisher's KYC on their behalf.
export async function recordKycAtDeskHandler(req: Request, res: Response): Promise<void> {
  const parsed = submitKycSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await recordKycAtDesk(req.params['publisherId'] as string, parsed.data, req.user!.sub, req) });
}

// POST /publishers/kyc-queue/:publisherId/digio/restart — the desk asks Digio again.
export async function restartDigioKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restartDigioKyc(req.params['publisherId'] as string, req.user!.sub, req) });
}
