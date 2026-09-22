import type { Lead, LeadInvite } from '../../shared/database';
import type { Role } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { CODE_LEAD_LANDING_LADDER, LEAD_LANDING_FLOW_KEY, getFlow, leadLandingLadderSchema, type LeadLandingLadder } from '../app-config';
import { normalizeMobile, sendOtp, sessionMeta, startSession, verifyOtp } from '../auth';
import { createVisit } from '../visits';
import { createSystemTask } from '../work';
import type { Request } from 'express';
import { requestCallback } from './calls.service';
import { inviteAppLink, inviteUrl, inviteView, INVITE_MS, isInviteCode, mintInviteCode, withOpen, type InviteView } from './invites.rules';
import { convertLead } from './leads.service';
import { alertLinkOpened } from './map.service';
import { engage } from './outreach.service';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import { catalogueForLanding, listProposalsFor, type ProposalView } from './proposals.service';
import { touchLead } from './scoring.service';
import { isOpenStage, type LeadStageValue } from './stages.rules';

/**
 * LH7 (the Lead Hunt, 22 Sep 2026): the invite link — D6 — and the landing
 * behind it.
 *
 * One live invite per lead: `adx.in/j/<code>`, thirty days, re-issuable
 * (the old code stops opening). Every open is recorded on the invite and
 * as a LINK_OPENED intent signal on the lead; the holder is told once an
 * hour (LH5's alert). The landing shows the side's hook — what spaces
 * like theirs earn, or the spots and packages near them — and the
 * proposals the agent sent; its doors are the OTP (the account is opened
 * on the lead's side and the lead converts through the link, channel
 * LINK), a callback, and a slot (a field visit offered to the holder, or
 * a call task).
 */

const LANDING_RADIUS_M = 200;
const NEARBY_KM = 2;
const SAMPLE_SPOTS = 3;
const SAMPLE_DAYS = 30;

/**
 * The door that opens an account's side — `users.chooseParty`, handed in by
 * bootstrap: `users` sits above half the platform and `leads` must not pull
 * it in (every partial mock of `auth` downstream would break at load).
 */
export type PartyOpener = (userId: string, input: { party: 'PUBLISHER' | 'ADVERTISER'; accountType: 'INDIVIDUAL' | 'BUSINESS' | 'ORGANISATION'; name?: string | undefined }) => Promise<{ profileId: string; displayId: string | null; created: boolean }>;
let partyOpener: PartyOpener | null = null;
export function registerPartyOpenerPort(port: PartyOpener): void {
  partyOpener = port;
}
async function openParty(userId: string, input: Parameters<PartyOpener>[1]): ReturnType<PartyOpener> {
  if (!partyOpener) throw new ApiError(503, 'NOT_IMPLEMENTED', 'The invite door is not wired on this server');
  return partyOpener(userId, input);
}

/* ── issuing ─────────────────────────────────────────────────────── */

/** The lead's live invite, minted when there is none (or when `reissue` is asked: the old one revoked). */
export async function issueInvite(leadId: string, actorUserId: string | null, options: { reissue?: boolean | undefined; now?: Date | undefined } = {}): Promise<InviteView> {
  const now = options.now ?? new Date();
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const active = await repository.findActiveInvite(leadId, now);
  if (active && !options.reissue) return inviteView(active, now);
  if (active) await repository.updateInvite(active.id, { revokedAt: now });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await repository.createInvite({ leadId, code: mintInviteCode(), expiresAt: new Date(now.getTime() + INVITE_MS), issuedByUserId: actorUserId });
      await leads.logActivity({ leadId, actorUserId, kind: 'NOTE', note: `${active ? 'Invite link re-issued' : 'Invite link issued'} — ${inviteUrl(created.code)}` });
      return inviteView(created, now);
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not mint an invite code');
}

/** The lead's live invite as the detail shows it, or null. */
export async function inviteFor(leadId: string, now = new Date()): Promise<InviteView | null> {
  const active = await repository.findActiveInvite(leadId, now);
  return active ? inviteView(active, now) : null;
}

/** The link the outreach copy carries — the live invite's, minted by the platform when the lead has none yet. */
export async function inviteLinkFor(lead: Pick<Lead, 'id'>): Promise<string> {
  const view = await issueInvite(lead.id, null).catch(() => null);
  return view?.url ?? inviteUrl('');
}

/* ── the landing ─────────────────────────────────────────────────── */

async function requireInvite(code: string): Promise<LeadInvite & { lead: Lead }> {
  if (!isInviteCode(code)) throw new ApiError(404, 'NOT_FOUND', 'No such invite');
  const invite = await repository.findInviteByCode(code);
  if (!invite) throw new ApiError(404, 'NOT_FOUND', 'No such invite');
  return invite;
}

/** The landing copy per side: the stored ladder when it fits the vocabulary, else the code's. */
export async function landingCopy(): Promise<LeadLandingLadder & { source: 'config' | 'code' }> {
  let flow: Record<string, unknown> | null = null;
  try {
    flow = await getFlow(LEAD_LANDING_FLOW_KEY);
  } catch (err) {
    logger.warn('flows.lead-landing could not be read; serving the code copy', { err: err instanceof Error ? err.message : String(err) });
  }
  if (!flow) return { ...CODE_LEAD_LANDING_LADDER, source: 'code' };
  const parsed = leadLandingLadderSchema.safeParse(flow);
  if (!parsed.success) return { ...CODE_LEAD_LANDING_LADDER, source: 'code' };
  return { ...(parsed.data as LeadLandingLadder), source: 'config' };
}

export type LandingCopy = { headline: string; line: string | null; bullets: string[]; cta: string; blocks: { key: string; label: string }[] };

export function copyForSide(ladder: LeadLandingLadder, side: 'PUBLISHER' | 'ADVERTISER'): LandingCopy {
  const step = ladder.steps.find((s) => s.key === side.toLowerCase()) ?? ladder.steps[side === 'PUBLISHER' ? 0 : 1] ?? ladder.steps[0];
  if (!step) return { headline: 'Welcome to ADX', line: null, bullets: [], cta: 'Get started', blocks: [] };
  return {
    headline: step.title,
    line: step.subtitle ?? null,
    bullets: (step.hint ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    cta: step.cta ?? 'Get started',
    blocks: step.proofs.map((p) => ({ key: p.key, label: p.label })),
  };
}

export type LandingHook =
  | { side: 'PUBLISHER'; rateEstimate: { perDay: string; perMonth: string; comparables: number; radiusM: number } | null; nearbyCampaigns: number }
  | { side: 'ADVERTISER'; nearbySpots: number; sampleEstimate: { spots: number; days: number; perSpotPerDay: string; amount: string } | null; packages: { tier: string; name: string; pricePerMonth: string; description: string | null; isPopular: boolean }[] };

/** The side's hook — the numbers the landing leads with. Every read that fails leaves its block empty rather than failing the page. */
export async function landingHook(lead: Lead): Promise<LandingHook> {
  const point = lead.latitude !== null && lead.longitude !== null ? { latitude: lead.latitude, longitude: lead.longitude } : null;
  const box = point ? { south: point.latitude - NEARBY_KM / 111, north: point.latitude + NEARBY_KM / 111, west: point.longitude - NEARBY_KM / 111, east: point.longitude + NEARBY_KM / 111 } : null;
  if (lead.side === 'PUBLISHER') {
    const [rate, comparables, campaigns] = point
      ? await Promise.all([
          leads.medianLiveRateNear(point, LANDING_RADIUS_M).catch(() => null),
          leads.countLiveListingsNear(point, LANDING_RADIUS_M).catch(() => 0),
          box ? leads.demandPoints(box, new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), 500).then((rows) => rows.length).catch(() => 0) : Promise.resolve(0),
        ])
      : [null, 0, 0];
    return {
      side: 'PUBLISHER',
      rateEstimate: rate ? { perDay: money(Number(rate)), perMonth: money(Number(rate) * 30), comparables, radiusM: LANDING_RADIUS_M } : null,
      nearbyCampaigns: campaigns,
    };
  }
  const [spots, rate, catalogue] = await Promise.all([
    box ? leads.liveListingPoints(box, 500).then((rows) => rows.length).catch(() => 0) : Promise.resolve(0),
    point ? leads.medianLiveRateNear(point, NEARBY_KM * 1000).catch(() => null) : Promise.resolve(null),
    catalogueForLanding().catch(() => ({ packages: [] as { tier: string; name: string; pricePerMonth: string; description: string | null; isPopular: boolean }[] })),
  ]);
  return {
    side: 'ADVERTISER',
    nearbySpots: spots,
    sampleEstimate: rate ? { spots: SAMPLE_SPOTS, days: SAMPLE_DAYS, perSpotPerDay: money(Number(rate)), amount: money(Number(rate) * SAMPLE_SPOTS * SAMPLE_DAYS) } : null,
    packages: catalogue.packages.slice(0, 4).map((p) => ({ tier: p.tier, name: p.name, pricePerMonth: p.pricePerMonth, description: p.description, isPopular: p.isPopular })),
  };
}

export type LandingPayload = {
  code: string;
  state: InviteView['state'];
  expiresAt: string;
  side: 'PUBLISHER' | 'ADVERTISER';
  business: { name: string; contactName: string | null; city: string | null; locality: string | null; category: string | null };
  agent: { name: string | null } | null;
  copy: LandingCopy;
  hook: LandingHook;
  proposals: ProposalView[];
  appLink: string;
  converted: boolean;
};

/**
 * `GET /j/:code` — the page, and the open it records: on the invite (the
 * last fifty), on the lead (LINK_OPENED — LH1's intent signal, once an
 * hour), to the holder (LH5's push, once an hour), and as a touch. An
 * expired or revoked code still answers the page — with its state — so the
 * person sees why the door is shut and can ask for a callback.
 */
export async function openLanding(code: string, meta: { ua?: string | null | undefined } = {}, now = new Date()): Promise<LandingPayload> {
  const invite = await requireInvite(code);
  const lead = invite.lead;
  const view = inviteView(invite, now);
  if (view.state === 'LIVE' || view.state === 'CONVERTED') {
    await repository.updateInvite(invite.id, { opens: withOpen(invite.opens, now, meta.ua) as never });
    const recent = view.lastOpenedAt && now.getTime() - new Date(view.lastOpenedAt).getTime() < 60 * 60 * 1000;
    if (!recent) {
      await leads.logActivity({ leadId: lead.id, actorUserId: null, kind: 'LINK_OPENED', note: 'Opened the invite link' });
      await touchLead(lead.id, now).catch(() => undefined);
      await alertLinkOpened(lead.id).catch(() => false);
    }
    await repository.markProposalsOpened(lead.id, now).catch(() => 0);
  }
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  const agent = holder ? await repository.findAgentUser(holder) : null;
  const [ladder, hook, proposals] = await Promise.all([landingCopy(), landingHook(lead), listProposalsFor(lead.id)]);
  return {
    code: invite.code,
    state: view.state,
    expiresAt: view.expiresAt,
    side: lead.side as 'PUBLISHER' | 'ADVERTISER',
    business: { name: lead.businessName, contactName: lead.contactName, city: lead.city, locality: lead.locality, category: lead.category },
    agent: agent ? { name: agent.name } : null,
    copy: copyForSide(ladder, lead.side as 'PUBLISHER' | 'ADVERTISER'),
    hook,
    proposals,
    appLink: inviteAppLink(invite.code),
    converted: lead.status === 'CONVERTED',
  };
}

/* ── the OTP door ────────────────────────────────────────────────── */

async function requireLiveInvite(code: string, now = new Date()): Promise<LeadInvite & { lead: Lead }> {
  const invite = await requireInvite(code);
  const state = inviteView(invite, now).state;
  if (state === 'EXPIRED') throw new ApiError(410, 'CONFLICT', 'This link has expired — ask your ADX contact for a fresh one', { reason: 'INVITE_EXPIRED' });
  if (state === 'REVOKED') throw new ApiError(410, 'CONFLICT', 'This link was replaced — ask your ADX contact for the new one', { reason: 'INVITE_REVOKED' });
  return invite;
}

/** `POST /j/:code/otp` — the number the person types; an existing account signs in, a new number becomes one. */
export async function requestInviteOtp(code: string, mobile: string, now = new Date()): Promise<{ mobile: string; expiresInSeconds?: number }> {
  const invite = await requireLiveInvite(code, now);
  const normalised = normalizeMobile(mobile);
  // The lead's own number is expected but not required: the owner may sign up from a different phone.
  const result = await sendOtp(normalised, 'LOGIN');
  await leads.logActivity({ leadId: invite.leadId, actorUserId: null, kind: 'NOTE', note: `Asked for an OTP on the invite page (${normalised.slice(-4).padStart(normalised.length, '•')})` });
  return { mobile: normalised, ...result };
}

export type InviteVerifyResult = {
  accessToken: string;
  refreshToken: string;
  party: { party: 'PUBLISHER' | 'ADVERTISER'; profileId: string; displayId: string | null; created: boolean };
  lead: { id: string; displayId: string | null; converted: boolean };
  appLink: string;
};

/**
 * `POST /j/:code/verify` — the code proves the number; the account is
 * opened on the lead's side through the app's own door (`chooseParty`),
 * the lead converts through the link (channel LINK; the holder is paid
 * LEAD_CONVERTED), the invite is marked, and a session is started so the
 * page can hand the person on.
 */
export async function verifyInviteOtp(code: string, input: { mobile: string; otp: string; name?: string | undefined; accountType?: 'INDIVIDUAL' | 'BUSINESS' | 'ORGANISATION' | undefined }, req: Request, now = new Date()): Promise<InviteVerifyResult> {
  const invite = await requireLiveInvite(code, now);
  const lead = invite.lead;
  const mobile = normalizeMobile(input.mobile);
  const userId = await verifyOtp(mobile, input.otp, 'LOGIN');
  const side = lead.side as 'PUBLISHER' | 'ADVERTISER';
  const party = await openParty(userId, { party: side, accountType: input.accountType ?? 'BUSINESS', name: input.name?.trim() || lead.contactName || lead.businessName });
  let converted = lead.status === 'CONVERTED';
  if (!converted) {
    try {
      await convertLead(lead.id, userId, side === 'PUBLISHER' ? { publisherId: party.profileId } : { advertiserId: party.profileId }, 'LINK');
      converted = true;
    } catch (err) {
      // The lead's number belongs to another account, or it converted meanwhile: the person is still signed in and on their side.
      logger.warn('Invite conversion refused', { leadId: lead.id, reason: err instanceof Error ? err.message : String(err) });
      if (err instanceof ApiError && err.statusCode === 409 && lead.status !== 'CONVERTED') {
        await leads.logActivity({ leadId: lead.id, actorUserId: userId, kind: 'NOTE', note: `Signed up through the invite link but the conversion was refused: ${err.message}` });
      }
    }
  }
  if (converted && !invite.convertedAt) await repository.updateInvite(invite.id, { convertedAt: now });
  const roles = (await repository.findUserRoles(userId)) as Role[];
  const session = await startSession(userId, roles, sessionMeta(req));
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    party: { party: side, profileId: party.profileId, displayId: party.displayId, created: party.created },
    lead: { id: lead.id, displayId: lead.displayId, converted },
    appLink: inviteAppLink(invite.code),
  };
}

/**
 * `POST /j/:code/link` (a session) — the app opened by `adx://join/<code>`
 * on a phone already signed in: the same door as the OTP verify, minus
 * the OTP and the session. Idempotent: an account already on the side and
 * a lead already converted both answer what stands.
 */
export async function linkInviteToAccount(code: string, userId: string, input: { name?: string | undefined; accountType?: 'INDIVIDUAL' | 'BUSINESS' | 'ORGANISATION' | undefined } = {}, now = new Date()): Promise<Omit<InviteVerifyResult, 'accessToken' | 'refreshToken'> & { agentName: string | null }> {
  const invite = await requireLiveInvite(code, now);
  const lead = invite.lead;
  const side = lead.side as 'PUBLISHER' | 'ADVERTISER';
  const party = await openParty(userId, { party: side, accountType: input.accountType ?? 'BUSINESS', name: input.name?.trim() || lead.contactName || lead.businessName });
  let converted = lead.status === 'CONVERTED';
  if (!converted) {
    try {
      await convertLead(lead.id, userId, side === 'PUBLISHER' ? { publisherId: party.profileId } : { advertiserId: party.profileId }, 'LINK');
      converted = true;
    } catch (err) {
      logger.warn('Invite link-to-account conversion refused', { leadId: lead.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (converted && !invite.convertedAt) await repository.updateInvite(invite.id, { convertedAt: now });
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  const agent = holder ? await repository.findAgentUser(holder) : null;
  return {
    party: { party: side, profileId: party.profileId, displayId: party.displayId, created: party.created },
    lead: { id: lead.id, displayId: lead.displayId, converted },
    appLink: inviteAppLink(invite.code),
    agentName: agent?.name ?? null,
  };
}

/* ── the two asks ────────────────────────────────────────────────── */

/** `POST /j/:code/callback` — a callback task on the holder's day, through the hub's door (via LINK). */
export async function callbackFromInvite(code: string, input: { when?: Date | null | undefined; note?: string | undefined }, now = new Date()): Promise<{ taskId: string }> {
  const invite = await requireInvite(code);
  const lead = invite.lead;
  const result = await requestCallback(lead, { via: 'LINK', when: input.when ?? null, note: input.note }, now);
  if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, 'LINK', `Asked for a callback on the invite page${input.note ? `: ${input.note}` : ''}`, null, now).catch((err) => logger.warn('Invite callback not engaged', { leadId: lead.id, err }));
  return { taskId: result.taskId };
}

export type SlotResult = { kind: 'VISIT'; visitId: string; displayId: string | null; at: string } | { kind: 'CALL'; taskId: string; at: string };

/**
 * `POST /j/:code/slot` — an appointment. A visit is offered to the agent
 * holding the lead (the LH-visits offer, 25 minutes to accept); with
 * nobody holding it, or when a call was asked for, a call task lands on
 * the holder's day (or unassigned, for the tele team).
 */
export async function slotFromInvite(code: string, input: { at: Date; kind: 'VISIT' | 'CALL'; note?: string | undefined }, now = new Date()): Promise<SlotResult> {
  const invite = await requireLiveInvite(code, now);
  const lead = invite.lead;
  if (input.at.getTime() < now.getTime() - 60_000) throw new ApiError(400, 'VALIDATION_ERROR', 'Pick a time that is still to come');
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  const agent = holder ? await repository.findAgentUser(holder) : null;
  const note = `Asked on the invite page${input.note ? `: ${input.note}` : ''}`;
  if (input.kind === 'VISIT' && holder && agent) {
    const visit = await createVisit(
      {
        kind: 'ONBOARDING',
        leadId: lead.id,
        agentId: holder,
        businessName: lead.businessName,
        ...(lead.locality ? { locality: lead.locality } : {}),
        ...(lead.city ? { city: lead.city } : {}),
        ...(lead.latitude !== null ? { latitude: lead.latitude } : {}),
        ...(lead.longitude !== null ? { longitude: lead.longitude } : {}),
        scheduledFor: input.at.toISOString(),
        notes: note,
      },
      { userId: agent.userId, isAdmin: true },
      now,
    );
    await leads.logActivity({ leadId: lead.id, actorUserId: null, kind: 'VISIT_BOOKED', note: `${note} — visit ${visit.displayId ?? visit.id} at ${input.at.toISOString()}` });
    if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, 'LINK', `Picked a visit slot on the invite page`, null, now).catch(() => undefined);
    return { kind: 'VISIT', visitId: visit.id, displayId: visit.displayId, at: input.at.toISOString() };
  }
  const task = await createSystemTask({ title: `Call ${lead.businessName} at their slot`, description: `${note}${lead.phone ? ` · ${lead.phone}` : ''}`, linkedKind: 'LEAD', linkedId: lead.id, assigneeUserIds: agent ? [agent.userId] : [], deadline: input.at, priority: 'HIGH', tag: 'callback' }, now);
  await leads.logActivity({ leadId: lead.id, actorUserId: null, kind: 'FOLLOW_UP', note: `${note} — a call at ${input.at.toISOString()}` });
  if (isOpenStage(lead.stage as LeadStageValue)) await engage(lead, 'LINK', `Picked a call slot on the invite page`, null, now).catch(() => undefined);
  return { kind: 'CALL', taskId: task.id, at: input.at.toISOString() };
}
