import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { pageQueryFrom } from '../../shared/pagination';
import type {
  ComplianceCaseStatus,
  ListingAttemptOrigin,
  ListingAttemptStatus,
  ListingClaimStatus,
} from '../../shared/database';
import {
  acceptListingAgreement,
  acceptPlatformAgreement,
  addListingsToAttempt,
  claimListing,
  createAttempt,
  decideClaim,
  getAttempt,
  getDocuments,
  getFunnel,
  getPublisherFunnelRows,
  getVerificationQueue,
  getVerifications,
  listAttempts,
  listClaims,
  listComplianceCases,
  logContactAttempt,
  requestAttemptAcceptance,
  resolveComplianceCase,
  reviewDocument,
  reviewVerification,
  runEnforcementSweep,
  setRights,
  getRightsQueue,
  runRightsSweep,
  submitDocument,
  submitVerification,
} from './supply.service';
import {
  acceptListingSchema,
  acceptPlatformSchema,
  addListingsSchema,
  contactAttemptSchema,
  createAttemptSchema,
  createClaimSchema,
  decideClaimSchema,
  reviewDocumentSchema,
  reviewVerificationSchema,
  submitDocumentSchema,
  rightsSchema,
  submitVerificationSchema,
} from './supply.schema';

/** Every handler validates the same way: parse, or 400 with the flattened error. */
function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error?.flatten());
  }
  return result.data as T;
}

const actor = (req: Request): string => {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return sub;
};

/* Funnel ----------------------------------------------------------- */

export async function funnelHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getFunnel() });
}

export async function funnelPublishersHandler(req: Request, res: Response): Promise<void> {
  const limit = Number(req.query['limit'] ?? 50);
  const offset = Number(req.query['offset'] ?? 0);
  res.json({
    success: true,
    data: await getPublisherFunnelRows(
      Number.isFinite(limit) ? limit : 50,
      Number.isFinite(offset) ? offset : 0,
    ),
  });
}

/* Agreements ------------------------------------------------------- */

export async function acceptPlatformHandler(req: Request, res: Response): Promise<void> {
  const body = parse(acceptPlatformSchema, req.body);
  const acceptance = await acceptPlatformAgreement({
    publisherId: body.publisherId,
    acceptedByUserId: actor(req),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.status(201).json({ success: true, data: acceptance });
}

export async function acceptListingHandler(req: Request, res: Response): Promise<void> {
  const body = parse(acceptListingSchema, req.body);
  const acceptance = await acceptListingAgreement({
    attemptId: body.attemptId,
    acceptedByUserId: actor(req),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.status(201).json({ success: true, data: acceptance });
}

/* Attempts --------------------------------------------------------- */

export async function createAttemptHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createAttemptSchema, req.body);
  const attempt = await createAttempt({ ...body, createdByUserId: actor(req) });
  res.status(201).json({ success: true, data: attempt });
}

export async function listAttemptsHandler(req: Request, res: Response): Promise<void> {
  const data = await listAttempts(
    {
      status: req.query['status'] as ListingAttemptStatus | undefined,
      publisherId: req.query['publisherId'] as string | undefined,
      origin: req.query['origin'] as ListingAttemptOrigin | undefined,
    },
    pageQueryFrom(req.query),
  );
  res.json({ success: true, data });
}

export async function getAttemptHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAttempt(req.params['attemptId'] as string) });
}

export async function addListingsHandler(req: Request, res: Response): Promise<void> {
  const body = parse(addListingsSchema, req.body);
  const result = await addListingsToAttempt(req.params['attemptId'] as string, body.listings);
  res.status(201).json({ success: true, data: result });
}

export async function requestAcceptanceHandler(req: Request, res: Response): Promise<void> {
  const attempt = await requestAttemptAcceptance(req.params['attemptId'] as string);
  res.json({ success: true, data: attempt });
}

/* Documents -------------------------------------------------------- */

export async function submitDocumentHandler(req: Request, res: Response): Promise<void> {
  const body = parse(submitDocumentSchema, req.body);
  const document = await submitDocument({ listingId: req.params['listingId'] as string, ...body });
  res.status(201).json({ success: true, data: document });
}

export async function listDocumentsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getDocuments(req.params['listingId'] as string) });
}

export async function reviewDocumentHandler(req: Request, res: Response): Promise<void> {
  const body = parse(reviewDocumentSchema, req.body);
  const document = await reviewDocument({
    documentId: req.params['documentId'] as string,
    approve: body.approve,
    rejectionReason: body.rejectionReason ?? null,
    reviewedByUserId: actor(req),
  });
  res.json({ success: true, data: document });
}

/* Verification ----------------------------------------------------- */

export async function submitVerificationHandler(req: Request, res: Response): Promise<void> {
  const body = parse(submitVerificationSchema, req.body);
  const result = await submitVerification({
    listingId: req.params['listingId'] as string,
    ...body,
    submittedByUserId: actor(req),
    orderId: body.orderId ?? null,
  });
  res.status(201).json({ success: true, data: result });
}

export async function listVerificationsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getVerifications(req.params['listingId'] as string) });
}

export async function reviewVerificationHandler(req: Request, res: Response): Promise<void> {
  const body = parse(reviewVerificationSchema, req.body);
  const verification = await reviewVerification({
    verificationId: req.params['verificationId'] as string,
    approve: body.approve,
    rejectionReason: body.rejectionReason ?? null,
    reviewedByUserId: actor(req),
  });
  res.json({ success: true, data: verification });
}

export async function verificationQueueHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getVerificationQueue() });
}

export async function enforcementSweepHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await runEnforcementSweep() });
}

/* Rights — QR-24 ---------------------------------------------------- */

export async function setRightsHandler(req: Request, res: Response): Promise<void> {
  const body = parse(rightsSchema, req.body);
  const listing = await setRights(req.params['listingId'] as string, body, { userId: actor(req), roles: req.user?.roles ?? [] });
  res.json({ success: true, data: listing });
}

export async function rightsQueueHandler(req: Request, res: Response): Promise<void> {
  const horizon = Number(req.query['horizonDays']);
  res.json({ success: true, data: await getRightsQueue(new Date(), Number.isFinite(horizon) && horizon > 0 ? Math.min(horizon, 365) : 60) });
}

export async function rightsSweepHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await runRightsSweep() });
}

/* Claims ----------------------------------------------------------- */

export async function createClaimHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createClaimSchema, req.body);
  res.status(201).json({ success: true, data: await claimListing(body) });
}

export async function listClaimsHandler(req: Request, res: Response): Promise<void> {
  const status = req.query['status'] as ListingClaimStatus | undefined;
  res.json({ success: true, data: await listClaims(status, pageQueryFrom(req.query)) });
}

export async function decideClaimHandler(req: Request, res: Response): Promise<void> {
  const body = parse(decideClaimSchema, req.body);
  const claim = await decideClaim({
    claimId: req.params['claimId'] as string,
    approve: body.approve,
    decisionNote: body.decisionNote ?? null,
    decidedByUserId: actor(req),
  });
  res.json({ success: true, data: claim });
}

/* Compliance ------------------------------------------------------- */

export async function listCasesHandler(req: Request, res: Response): Promise<void> {
  const status = req.query['status'] as ComplianceCaseStatus | undefined;
  res.json({
    success: true,
    data: await listComplianceCases(status, pageQueryFrom(req.query)),
  });
}

export async function contactAttemptHandler(req: Request, res: Response): Promise<void> {
  const body = parse(contactAttemptSchema, req.body);
  const attempt = await logContactAttempt({
    caseId: req.params['caseId'] as string,
    ...body,
    attemptedByUserId: actor(req),
  });
  res.status(201).json({ success: true, data: attempt });
}

export async function resolveCaseHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await resolveComplianceCase(req.params['caseId'] as string) });
}
