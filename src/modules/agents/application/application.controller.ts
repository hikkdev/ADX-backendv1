import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { reissueAccessToken } from '../../auth';
import { getRoutingSettings, saveRoutingSettings } from '../agents.service';
import { routingSettingsSchema } from './application.schema';
import { createFleetPartner, fleetInvitesSchema, fleetPartnerPatchSchema, fleetPartnerSchema, getFleetPartner, inviteFleet, listFleetPartners, updateFleetPartner } from './fleet.service';
import {
  acceptAgreementAtDesk,
  acceptMyAgreement,
  apply,
  decideApplication,
  exitAgent,
  fileDocumentAtDesk,
  fileMyDocument,
  getApplication,
  getMyApplication,
  listApplications,
  recordInterviewOutcome,
  removeMyDocument,
  reviewDocument,
  runDocumentExpirySweep,
  scheduleInterview,
  screenAtDesk,
  setGrade,
  verifyVehicleRcAtDesk,
  submitAtDesk,
  submitMyApplication,
  updateMyApplicationProfile,
  updateProfileAtDesk,
  withdrawMyApplication,
} from './application.service';
import {
  applicationProfileSchema,
  applicationsQuerySchema,
  applySchema,
  decisionSchema,
  deskProfileSchema,
  documentKindParamSchema,
  exitSchema,
  fileDocumentSchema,
  gradeSchema,
  interviewOutcomeSchema,
  interviewSchema,
  reviewDocumentSchema,
  screenSchema,
  withdrawSchema,
} from './application.schema';

function parse<T>(result: { success: true; data: T } | { success: false; error: { flatten(): unknown } }): T {
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error.flatten());
  return result.data;
}

const kindOf = (req: Request) => parse(documentKindParamSchema.safeParse(String(req.params['kind'] ?? '').toUpperCase()));
const ctxOf = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

/* ── The applicant ───────────────────────────────────────────────────────── */

/**
 * `POST /agents/apply` — the role this grants rides in the access token
 * (QR-2), so the same session's token is re-signed and handed back: the app
 * swaps it and its next `/agents/me` is an applicant's, not a 404.
 */
export async function applyHandler(req: Request, res: Response) {
  const input = parse(applySchema.safeParse(req.body ?? {}));
  const application = await apply(req.user!.sub, input, req);
  const accessToken = req.user?.sid ? await reissueAccessToken(req.user.sub, req.user.sid) : undefined;
  res.status(201).json({ success: true, data: { ...application, ...(accessToken ? { accessToken } : {}) } });
}

export async function getMyApplicationHandler(req: Request, res: Response) {
  res.json({ success: true, data: await getMyApplication(req.user!.sub) });
}

export async function updateMyApplicationProfileHandler(req: Request, res: Response) {
  const input = parse(applicationProfileSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await updateMyApplicationProfile(req.user!.sub, input) });
}

export async function fileMyDocumentHandler(req: Request, res: Response) {
  const kind = kindOf(req);
  const input = parse(fileDocumentSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await fileMyDocument(req.user!.sub, kind, input, req) });
}

export async function removeMyDocumentHandler(req: Request, res: Response) {
  res.json({ success: true, data: await removeMyDocument(req.user!.sub, kindOf(req)) });
}

export async function acceptMyAgreementHandler(req: Request, res: Response) {
  res.json({ success: true, data: await acceptMyAgreement(req.user!.sub, ctxOf(req)) });
}

export async function submitMyApplicationHandler(req: Request, res: Response) {
  res.json({ success: true, data: await submitMyApplication(req.user!.sub, req) });
}

export async function withdrawMyApplicationHandler(req: Request, res: Response) {
  const input = parse(withdrawSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await withdrawMyApplication(req.user!.sub, input.reason, req) });
}

/* ── The desk ────────────────────────────────────────────────────────────── */

export async function listApplicationsHandler(req: Request, res: Response) {
  const query = parse(applicationsQuerySchema.safeParse(req.query));
  const { items, meta } = await listApplications(query);
  res.json({ success: true, data: items, meta });
}

export async function getApplicationHandler(req: Request, res: Response) {
  res.json({ success: true, data: await getApplication(String(req.params['id'])) });
}

export async function updateProfileAtDeskHandler(req: Request, res: Response) {
  const input = parse(deskProfileSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await updateProfileAtDesk(String(req.params['id']), input, req.user!.sub, req) });
}

export async function acceptAgreementAtDeskHandler(req: Request, res: Response) {
  res.json({ success: true, data: await acceptAgreementAtDesk(String(req.params['id']), req.user!.sub, ctxOf(req), req) });
}

export async function submitAtDeskHandler(req: Request, res: Response) {
  res.json({ success: true, data: await submitAtDesk(String(req.params['id']), req.user!.sub, req) });
}

export async function fileDocumentAtDeskHandler(req: Request, res: Response) {
  const kind = kindOf(req);
  const input = parse(fileDocumentSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await fileDocumentAtDesk(String(req.params['id']), kind, input, req.user!.sub, req) });
}

export async function reviewDocumentHandler(req: Request, res: Response) {
  const kind = kindOf(req);
  const input = parse(reviewDocumentSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await reviewDocument(String(req.params['id']), kind, input, req.user!.sub, req) });
}

export async function decideApplicationHandler(req: Request, res: Response) {
  const input = parse(decisionSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await decideApplication(String(req.params['id']), input, req.user!.sub, req) });
}

export async function setGradeHandler(req: Request, res: Response) {
  const input = parse(gradeSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await setGrade(String(req.params['id']), input, req.user!.sub, req) });
}

export async function exitAgentHandler(req: Request, res: Response) {
  const input = parse(exitSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await exitAgent(String(req.params['id']), input, req.user!.sub, req) });
}

/* ── AG-4: screening, verification, the sweep ────────────────────────────── */

export async function scheduleInterviewHandler(req: Request, res: Response) {
  const input = parse(interviewSchema.safeParse(req.body ?? {}));
  res.status(201).json({ success: true, data: await scheduleInterview(String(req.params['id']), input, req.user!.sub, req) });
}

export async function recordInterviewOutcomeHandler(req: Request, res: Response) {
  const input = parse(interviewOutcomeSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await recordInterviewOutcome(String(req.params['id']), String(req.params['interviewId']), input, req.user!.sub, req) });
}

export async function screenAtDeskHandler(req: Request, res: Response) {
  const input = parse(screenSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await screenAtDesk(String(req.params['id']), input, req.user!.sub, req) });
}

export async function verifyVehicleRcHandler(req: Request, res: Response) {
  res.json({ success: true, data: await verifyVehicleRcAtDesk(String(req.params['id']), req.user!.sub, req) });
}

export async function documentExpirySweepHandler(_req: Request, res: Response) {
  res.json({ success: true, data: await runDocumentExpirySweep() });
}

/* ── AG-5: routing settings, fleet partners ──────────────────────────────── */

export async function getRoutingSettingsHandler(_req: Request, res: Response) {
  res.json({ success: true, data: await getRoutingSettings() });
}

export async function saveRoutingSettingsHandler(req: Request, res: Response) {
  const input = parse(routingSettingsSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await saveRoutingSettings(input, req.user!.sub, req) });
}

export async function listFleetPartnersHandler(_req: Request, res: Response) {
  res.json({ success: true, data: await listFleetPartners() });
}

export async function getFleetPartnerHandler(req: Request, res: Response) {
  res.json({ success: true, data: await getFleetPartner(String(req.params['partnerId'])) });
}

export async function createFleetPartnerHandler(req: Request, res: Response) {
  const input = parse(fleetPartnerSchema.safeParse(req.body ?? {}));
  res.status(201).json({ success: true, data: await createFleetPartner(input, req.user!.sub, req) });
}

export async function updateFleetPartnerHandler(req: Request, res: Response) {
  const input = parse(fleetPartnerPatchSchema.safeParse(req.body ?? {}));
  res.json({ success: true, data: await updateFleetPartner(String(req.params['partnerId']), input, req.user!.sub, req) });
}

export async function inviteFleetHandler(req: Request, res: Response) {
  const input = parse(fleetInvitesSchema.safeParse(req.body ?? {}));
  res.status(201).json({ success: true, data: await inviteFleet(String(req.params['partnerId']), input, req.user!.sub, req) });
}
