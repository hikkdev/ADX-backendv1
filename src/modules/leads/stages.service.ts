import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { findAgentTier } from '../agents';
import { recordIncentiveOnce } from '../payouts';
import { cityKeyFor } from '../pricing';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import type { FunnelFilter } from './leads.repository';
import { touchLead } from './scoring.service';
import {
  isOpenStage,
  recycleAtFor,
  returnsToSourcing,
  stageMove,
  stampAttribution,
  statusForStage,
  type LeadLostReasonValue,
  type LeadStageValue,
  type StageActor,
} from './stages.rules';

/**
 * LH2 (the Lead Hunt, 22 Sep 2026): the stages, as the service moves them.
 *
 * `moveStage` is the one door: it asks the rules, syncs the lifecycle
 * status the pill reads, writes the STAGE_CHANGED row and restarts the
 * recency clock. The retention watch (`watchRetention`) and the recycle
 * (`recycleDue`) are the system's moves — they pay, so nobody's hand sets
 * them. D14's attribution is stamped alongside (`stampMoment`).
 */

export type StageMoveOptions = {
  actorUserId: string | null;
  note?: string | null;
  /** D11: required for LOST. */
  reason?: LeadLostReasonValue | undefined;
  lostNote?: string | undefined;
  /** D14: the channel that produced this moment, when one did. */
  channel?: string | undefined;
  /** For a system move that carries its own stamp — the activation read off the account. */
  at?: Date | undefined;
};

type LeadRow = Awaited<ReturnType<typeof repository.findById>>;

function assertLead(lead: LeadRow): asserts lead is NonNullable<LeadRow> {
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
}

/** The attribution stamp for a moment, when the move carries a channel. */
function attributionFor(lead: NonNullable<LeadRow>, to: LeadStageValue, channel: string | undefined, at: Date): unknown {
  if (!channel) return undefined;
  if (to === 'CONTACTED') return stampAttribution(lead.attribution, 'firstContact', channel, at);
  if (to === 'ENGAGED') return stampAttribution(lead.attribution, 'engaged', channel, at);
  if (to === 'CONVERTED') return stampAttribution(lead.attribution, 'converted', channel, at);
  return undefined;
}

export async function moveStage(leadId: string, to: LeadStageValue, actor: StageActor, options: StageMoveOptions) {
  const lead = await repository.findById(leadId);
  assertLead(lead);
  const from = lead.stage as LeadStageValue;
  const verdict = stageMove(from, to, actor);
  if (!verdict.ok) throw new ApiError(409, 'CONFLICT', verdict.reason, { from, to });
  if (to === 'LOST' && !options.reason) throw new ApiError(400, 'VALIDATION_ERROR', 'A loss needs a reason', { reasons: ['NOT_INTERESTED', 'WRONG_CONTACT', 'COMPETITOR', 'PRICE', 'TIMING', 'OTHER'] });
  if (to === 'LOST' && options.reason === 'OTHER' && !options.lostNote?.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why, in a note, when the reason is Other');
  const now = options.at ?? new Date();

  // D11: a wrong contact is not a loss — the row goes back to sourcing for a better number.
  if (to === 'LOST' && options.reason && returnsToSourcing(options.reason)) {
    await repository.update(leadId, {
      stage: 'SOURCED',
      stageChangedAt: now,
      status: 'NEW',
      lostReason: options.reason,
      lostNote: options.lostNote ?? null,
      recycleAt: null,
      assignedAgentId: null,
    });
    await repository.logActivity({ leadId, actorUserId: options.actorUserId, kind: 'STAGE_CHANGED', note: `${from} → SOURCED — wrong contact${options.lostNote ? `: ${options.lostNote}` : ''}; back to sourcing` });
    return;
  }

  const status = statusForStage(to, lead.status);
  const attribution = attributionFor(lead, to, options.channel, now);
  await repository.update(leadId, {
    stage: to,
    stageChangedAt: now,
    ...(status ? { status } : {}),
    ...(to === 'LOST'
      ? { lostReason: options.reason ?? null, lostNote: options.lostNote ?? null, recycleAt: options.reason ? recycleAtFor(options.reason, now) : null }
      : from === 'LOST'
        ? { lostReason: null, lostNote: null, recycleAt: null }
        : {}),
    ...(to === 'ACTIVATED' ? { activatedAt: now } : {}),
    ...(to === 'RETAINED' ? { retainedAt: now } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
  });
  const why = options.note ? ` — ${options.note}` : to === 'LOST' && options.reason ? ` — ${options.reason.toLowerCase().replace('_', ' ')}${options.lostNote ? `: ${options.lostNote}` : ''}` : '';
  await repository.logActivity({ leadId, actorUserId: options.actorUserId, kind: 'STAGE_CHANGED', note: `${from} → ${to}${why}` });
  // A closed lead keeps its last score; an open one is re-scored with the touch.
  if (isOpenStage(to)) await touchLead(leadId, now);
}

/**
 * A forward move that happens as a side effect of something else (a call
 * moves SOURCED → CONTACTED; an assignment SOURCED → CLAIMED). Never moves
 * backward and never throws: the act that caused it already happened.
 */
export async function advanceStage(leadId: string, to: LeadStageValue, options: StageMoveOptions): Promise<void> {
  const lead = await repository.findById(leadId);
  if (!lead) return;
  const from = lead.stage as LeadStageValue;
  const verdict = stageMove(from, to, 'SYSTEM');
  if (!verdict.ok) {
    // Already there or further along: only the attribution stamp may still be new.
    const attribution = attributionFor(lead, to, options.channel, options.at ?? new Date());
    if (attribution !== undefined && JSON.stringify(attribution) !== JSON.stringify(lead.attribution ?? {})) await repository.update(leadId, { attribution });
    return;
  }
  await moveStage(leadId, to, 'SYSTEM', options).catch((err) => logger.warn('Stage not advanced', { leadId, to, err }));
}

/** D14: stamp one moment's channel without moving the stage — the outreach hub's inbound reply on an already-engaged lead, say. */
export async function stampMoment(leadId: string, moment: 'firstContact' | 'engaged' | 'converted', channel: string, at = new Date()): Promise<void> {
  const lead = await repository.findById(leadId);
  if (!lead) return;
  const next = stampAttribution(lead.attribution, moment, channel, at);
  if (JSON.stringify(next) !== JSON.stringify(lead.attribution ?? {})) await repository.update(leadId, { attribution: next });
}

/** The agent's "they replied" — ENGAGED from any inbound; the activity row names what came back. */
export async function markEngaged(leadId: string, actorUserId: string | null, options: { note?: string | undefined; channel?: string | undefined }) {
  const lead = await repository.findById(leadId);
  assertLead(lead);
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'That lead is closed');
  await repository.logActivity({ leadId, actorUserId, kind: 'ENGAGED', note: options.note ?? 'They replied' });
  await stampMoment(leadId, 'engaged', options.channel ?? 'OTHER');
  await advanceStage(leadId, 'ENGAGED', { actorUserId, channel: options.channel, note: options.note ?? null });
}

/** The agent's "I sent them a proposal" — PROPOSED; LH7 attaches the proposal record. */
export async function markProposed(leadId: string, actorUserId: string | null, note?: string) {
  const lead = await repository.findById(leadId);
  assertLead(lead);
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'That lead is closed');
  await repository.logActivity({ leadId, actorUserId, kind: 'PROPOSAL_SENT', note: note ?? 'Proposal sent' });
  await advanceStage(leadId, 'PROPOSED', { actorUserId, note: note ?? null });
}

/**
 * D1: LEAD_CONVERTED, once per account, to the agent who holds the lead
 * (or the one converting it). A rate that cannot be priced never stops a
 * conversion.
 */
export async function payConversion(lead: { id: string; displayId: string | null; businessName: string; side: string; assignedAgentId: string | null; convertedPublisherId: string | null; convertedAdvertiserId: string | null }, agentId: string | null): Promise<{ id: string; amount: string } | null> {
  const paidTo = lead.assignedAgentId ?? agentId;
  if (!paidTo) return null;
  try {
    const tier = (await findAgentTier(paidTo)) ?? '*';
    const incentive = await recordIncentiveOnce({
      agentId: paidTo,
      event: 'LEAD_CONVERTED',
      tier,
      side: lead.side === 'ADVERTISER' ? 'ADVERTISER' : 'PUBLISHER',
      publisherId: lead.convertedPublisherId,
      advertiserId: lead.convertedAdvertiserId,
      note: `Lead ${lead.displayId ?? lead.id} converted: ${lead.businessName}`,
      notice: { partyName: lead.businessName },
    });
    return { id: incentive.id, amount: money(incentive.amount) };
  } catch (err) {
    logger.warn('LEAD_CONVERTED was not recorded', { leadId: lead.id, err });
    return null;
  }
}

/**
 * The retention watch: every converted lead's account, read for the catch
 * (first listing live / first campaign paid → ACTIVATED, LEAD_ACTIVATED)
 * and the trailing reward (a second booking / campaign, or thirty days
 * live → RETAINED, LEAD_RETAINED). Hourly; each move once.
 */
export const RETAINED_AFTER_DAYS = 30;

export async function watchRetention(now = new Date()): Promise<{ checked: number; activated: number; retained: number }> {
  let cursor: string | null = null;
  let checked = 0;
  let activated = 0;
  let retained = 0;
  for (;;) {
    const rows = await repository.findAtStages(['CONVERTED', 'ONBOARDING', 'ACTIVATED'], 200, cursor);
    if (rows.length === 0) break;
    for (const lead of rows) {
      checked += 1;
      const account = { publisherId: lead.convertedPublisherId, advertiserId: lead.convertedAdvertiserId };
      if (!account.publisherId && !account.advertiserId) continue;
      if (lead.stage === 'CONVERTED' || lead.stage === 'ONBOARDING') {
        const catchRead = await repository.accountActivation(account);
        if (!catchRead.activatedAt) {
          if (lead.stage === 'CONVERTED') await advanceStage(lead.id, 'ONBOARDING', { actorUserId: null, note: 'Account open, onboarding under way', at: now });
          continue;
        }
        await advanceStage(lead.id, 'ACTIVATED', { actorUserId: null, note: `The catch: ${catchRead.label ?? 'first business'}`, at: catchRead.activatedAt > now ? now : catchRead.activatedAt });
        await payStage(lead, 'LEAD_ACTIVATED', `Lead ${lead.displayId ?? lead.id} activated: ${lead.businessName}`);
        await countTowardLadder(lead, account);
        for (const hook of activationHooks) await hook(lead).catch((err) => logger.warn('Activation hook failed', { leadId: lead.id, err }));
        activated += 1;
        continue;
      }
      if (lead.stage === 'ACTIVATED') {
        const repeat = await repository.accountRetention(account);
        const since = lead.activatedAt ? (now.getTime() - lead.activatedAt.getTime()) / (24 * 60 * 60 * 1000) : 0;
        if (repeat.repeatCount >= 2 || (since >= RETAINED_AFTER_DAYS && repeat.stillLive)) {
          await advanceStage(lead.id, 'RETAINED', { actorUserId: null, note: repeat.repeatCount >= 2 ? 'Repeat business' : `${RETAINED_AFTER_DAYS} days live`, at: now });
          await payStage(lead, 'LEAD_RETAINED', `Lead ${lead.displayId ?? lead.id} retained: ${lead.businessName}`);
          retained += 1;
        }
      }
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return { checked, activated, retained };
}

/**
 * LH8 (D2): an activation is one onboarding toward the holder's rung. The
 * ladder counts publishers and advertisers by the `agentId` on the account,
 * so the holder is stamped there — only where the account names nobody yet
 * (a scanned or desk-onboarded account keeps the agent who brought it in),
 * and only now, after the catch, so the onboarding commissions the account
 * doors pay at ONBOARDING_COMPLETE / KYC are not triggered for a link
 * conversion: the hunt pays LEAD_ACTIVATED for that, the rung climbs, and
 * nothing is paid twice.
 */
async function countTowardLadder(lead: { id: string; assignedAgentId: string | null }, account: { publisherId: string | null; advertiserId: string | null }): Promise<void> {
  if (!lead.assignedAgentId) return;
  try {
    const stamped = await repository.attributeAccountToAgent(account, lead.assignedAgentId);
    if (!stamped) return;
    await repository.logActivity({ leadId: lead.id, actorUserId: null, kind: 'STATUS_CHANGED', note: 'Counted toward the tier ladder (D2)' });
  } catch (err) {
    logger.warn('Activation was not counted toward the ladder', { leadId: lead.id, err });
  }
}

async function payStage(lead: { id: string; side: string; assignedAgentId: string | null; convertedPublisherId: string | null; convertedAdvertiserId: string | null; businessName: string }, event: 'LEAD_ACTIVATED' | 'LEAD_RETAINED', note: string): Promise<void> {
  if (!lead.assignedAgentId) return;
  try {
    const tier = (await findAgentTier(lead.assignedAgentId)) ?? '*';
    await recordIncentiveOnce({
      agentId: lead.assignedAgentId,
      event,
      tier,
      side: lead.side === 'ADVERTISER' ? 'ADVERTISER' : 'PUBLISHER',
      publisherId: lead.convertedPublisherId,
      advertiserId: lead.convertedAdvertiserId,
      note,
      notice: { partyName: lead.businessName },
    });
  } catch (err) {
    logger.warn(`${event} was not recorded`, { leadId: lead.id, err });
  }
}

/** LH3 (D9) hooks here: the referrer's wallet credit on the catch; LH5's priority top-up too. Registered from the module's index. */
export type ActivationHook = (lead: { id: string; side: string; assignedAgentId: string | null; latitude: number | null; longitude: number | null; category: string | null }) => Promise<void>;
const activationHooks: ActivationHook[] = [];
export function registerActivationHook(hook: ActivationHook): void {
  activationHooks.push(hook);
}

/** LH6 hooks here: a fresh sequence for a recycled lead. Unregistered, the recycle just re-scores. */
export type RecyclePort = { onRecycled(leadId: string): Promise<void> };
let recyclePort: RecyclePort | null = null;
export function registerLeadRecyclePort(port: RecyclePort): void {
  recyclePort = port;
}

/** D11: PRICE and TIMING losses come back to the cold pool after 60 days. */
export async function recycleDue(now = new Date()): Promise<{ recycled: number }> {
  const due = await repository.dueForRecycle(now, 500);
  for (const lead of due) {
    await moveStage(lead.id, 'SCORED', 'SYSTEM', { actorUserId: null, note: `recycled after ${Math.round((now.getTime() - (lead.stageChangedAt?.getTime() ?? now.getTime())) / (24 * 60 * 60 * 1000))} days (${lead.lostReason?.toLowerCase() ?? 'lost'})`, at: now });
    // LH9/LH11: the stamp the board's flag and the overview's recycle yield read.
    await repository.update(lead.id, { assignedAgentId: null, lostNote: `Recycled ${now.toISOString().slice(0, 10)}; was ${lead.lostReason ?? 'LOST'}`, recycledAt: now, recycleCount: ((lead as { recycleCount?: number }).recycleCount ?? 0) + 1 });
    if (recyclePort) await recyclePort.onRecycled(lead.id).catch((err) => logger.warn('Recycle port failed', { leadId: lead.id, err }));
  }
  return { recycled: due.length };
}

/** GET /leads/funnel — aggregates only. `city` is a slug or a name, keyed the way the desk's list keys it. */
export async function funnel(filter: Omit<FunnelFilter, 'cityId'>) {
  const keyed: FunnelFilter = filter.city ? { ...filter, cityId: (await cityKeyFor(filter.city))?.cityId ?? null } : filter;
  return repository.funnel(keyed);
}
