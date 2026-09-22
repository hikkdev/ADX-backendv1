import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { callbackFromInvite, inviteFor, issueInvite, landingCopy, linkInviteToAccount, openLanding, requestInviteOtp, slotFromInvite, verifyInviteOtp } from './invites.service';
import { actorOf } from './outreach.service';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import { acceptProposal, listProposalsFor, proposalView, PROPOSAL_KINDS, sendProposal } from './proposals.service';
import { findAgentProfile } from '../agents';

/**
 * LH7: the invite's doors — the agent's (issue, re-issue, the proposals)
 * and the public landing's (the page, the OTP, a callback, a slot, a
 * proposal opened or accepted). The public ones take no session: the code
 * is the key, and every one records what it did on the lead.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const leadIdOf = (req: Request): string => req.params['leadId'] as string;
const codeOf = (req: Request): string => String(req.params['code'] ?? '').toUpperCase();
const isAdmin = (req: Request): boolean => req.user!.roles.includes('ADMIN');

async function requireMayWork(req: Request, leadId: string): Promise<void> {
  if (isAdmin(req)) return;
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const agent = await findAgentProfile(req.user!.sub);
  const held = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > new Date() ? lead.claimedByAgentId : lead.assignedAgentId;
  if (!agent || (held !== agent.id && held !== null)) throw new ApiError(403, 'FORBIDDEN', 'This lead is on someone else');
}

/* ── the agent's doors ───────────────────────────────────────────── */

export async function getInviteHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  res.json({ success: true, data: await inviteFor(leadId) });
}

const issueSchema = z.object({ reissue: z.boolean().optional() });

export async function issueInviteHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(issueSchema, req.body ?? {});
  const invite = await issueInvite(leadId, req.user!.sub, { reissue: body.reissue });
  if (isAdmin(req)) await logActivity(req.user!.sub, body.reissue ? 'LEAD_INVITE_REISSUED' : 'LEAD_INVITE_ISSUED', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { inviteId: invite.id, code: invite.code, expiresAt: invite.expiresAt } });
  res.status(201).json({ success: true, data: invite });
}

export async function listProposalsHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  res.json({ success: true, data: await listProposalsFor(leadId) });
}

const moneyText = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'A rupee amount');
const proposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RATE_ESTIMATE'), perDay: moneyText.optional(), note: z.string().trim().max(500).optional() }),
  z.object({ kind: z.literal('CAMPAIGN_ESTIMATE'), spots: z.number().int().min(1).max(200).optional(), days: z.number().int().min(1).max(365).optional(), perSpotPerDay: moneyText.optional(), note: z.string().trim().max(500).optional() }),
  z.object({ kind: z.literal('PACKAGE_QUOTE'), tier: z.string().trim().min(1).max(40), addOnCodes: z.array(z.string().trim().min(1).max(40)).max(10).optional(), cycle: z.enum(['MONTHLY', 'ANNUAL']).optional(), note: z.string().trim().max(500).optional() }),
]);

export async function sendProposalHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const body = parse(proposalSchema, req.body);
  if (!(PROPOSAL_KINDS as readonly string[]).includes(body.kind)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown proposal kind');
  const proposal = await sendProposal(leadId, req.user!.sub, body);
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_PROPOSAL_SENT', { req, module: 'leads', targetType: 'Lead', targetId: leadId, metadata: { proposalId: proposal.id, kind: proposal.kind, payload: proposal.payload } });
  res.status(201).json({ success: true, data: proposal });
}

/** `GET /leads/landing-copy` — the ladder in force, for the flow editor's fallback. */
export async function landingCopyHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await landingCopy() });
}

/** The desk may re-mark a proposal by hand (accepted on the phone, say). */
export async function markProposalHandler(req: Request, res: Response): Promise<void> {
  const leadId = leadIdOf(req);
  await requireMayWork(req, leadId);
  const proposalId = req.params['proposalId'] as string;
  const before = await repository.findProposal(proposalId);
  if (!before || before.leadId !== leadId) throw new ApiError(404, 'NOT_FOUND', 'No such proposal');
  const after = await acceptProposal(leadId, proposalId);
  if (isAdmin(req)) await logActivity(req.user!.sub, 'LEAD_PROPOSAL_ACCEPTED', { req, module: 'leads', targetType: 'LeadProposal', targetId: proposalId, diff: auditDiff(proposalView(before), after, ['openedAt', 'acceptedAt'] as const) });
  res.json({ success: true, data: after });
}

/* ── the public landing ──────────────────────────────────────────── */

export async function landingHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await openLanding(codeOf(req), { ua: req.get('user-agent') }) });
}

const otpSchema = z.object({ mobile: z.string().trim().min(10).max(16) });

export async function landingOtpHandler(req: Request, res: Response): Promise<void> {
  const body = parse(otpSchema, req.body);
  res.json({ success: true, data: await requestInviteOtp(codeOf(req), body.mobile) });
}

const verifySchema = z.object({
  mobile: z.string().trim().min(10).max(16),
  otp: z.string().trim().min(4).max(8),
  name: z.string().trim().max(120).optional(),
  accountType: z.enum(['INDIVIDUAL', 'BUSINESS', 'ORGANISATION']).optional(),
});

export async function landingVerifyHandler(req: Request, res: Response): Promise<void> {
  const body = parse(verifySchema, req.body);
  res.json({ success: true, data: await verifyInviteOtp(codeOf(req), body, req) });
}

const linkSchema = z.object({ name: z.string().trim().max(120).optional(), accountType: z.enum(['INDIVIDUAL', 'BUSINESS', 'ORGANISATION']).optional() });

/** The app, opened by the deep link on a signed-in phone. */
export async function landingLinkHandler(req: Request, res: Response): Promise<void> {
  const body = parse(linkSchema, req.body ?? {});
  res.json({ success: true, data: await linkInviteToAccount(codeOf(req), req.user!.sub, body) });
}

const callbackSchema = z.object({ when: z.coerce.date().optional(), note: z.string().trim().max(500).optional() });

export async function landingCallbackHandler(req: Request, res: Response): Promise<void> {
  const body = parse(callbackSchema, req.body ?? {});
  res.status(201).json({ success: true, data: await callbackFromInvite(codeOf(req), { when: body.when ?? null, note: body.note }) });
}

const slotSchema = z.object({ at: z.coerce.date(), kind: z.enum(['VISIT', 'CALL']).default('VISIT'), note: z.string().trim().max(500).optional() });

export async function landingSlotHandler(req: Request, res: Response): Promise<void> {
  const body = parse(slotSchema, req.body);
  res.status(201).json({ success: true, data: await slotFromInvite(codeOf(req), body) });
}

export async function landingAcceptProposalHandler(req: Request, res: Response): Promise<void> {
  const invite = await repository.findInviteByCode(codeOf(req));
  if (!invite) throw new ApiError(404, 'NOT_FOUND', 'No such invite');
  res.json({ success: true, data: await acceptProposal(invite.leadId, req.params['proposalId'] as string) });
}

export { actorOf };
