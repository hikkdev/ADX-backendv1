/**
 * LH2 (the Lead Hunt, 22 Sep 2026): the twelve stages, as rules — D11 and
 * D12. Pure; the service reads the row and writes what these decide.
 */

export const LEAD_STAGES = [
  'SOURCED',
  'SCORED',
  'CLAIMED',
  'CONTACTED',
  'ENGAGED',
  'VISIT_BOOKED',
  'PROPOSED',
  'CONVERTED',
  'ONBOARDING',
  'ACTIVATED',
  'RETAINED',
  'LOST',
] as const;
export type LeadStageValue = (typeof LEAD_STAGES)[number];

export const LEAD_LOST_REASONS = ['NOT_INTERESTED', 'WRONG_CONTACT', 'COMPETITOR', 'PRICE', 'TIMING', 'OTHER'] as const;
export type LeadLostReasonValue = (typeof LEAD_LOST_REASONS)[number];

/** Who is asking for the move. */
export type StageActor = 'ADMIN' | 'AGENT' | 'SYSTEM';

const RANK: Record<LeadStageValue, number> = Object.fromEntries(LEAD_STAGES.map((stage, i) => [stage, i])) as Record<LeadStageValue, number>;

export const stageRank = (stage: LeadStageValue): number => RANK[stage];

/** True while the deal is still being worked — not converted, not lost. */
export const isOpenStage = (stage: LeadStageValue): boolean => stageRank(stage) < RANK.CONVERTED;

/** True once an account exists — CONVERTED and everything after it but LOST. */
export const isWonStage = (stage: LeadStageValue): boolean => stage !== 'LOST' && stageRank(stage) >= RANK.CONVERTED;

/** The stages a hand may move a lead to. Money-bearing stages are the server's. */
const HAND_STAGES: readonly LeadStageValue[] = ['SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED', 'ONBOARDING'];

/** What the stage says about the lifecycle status (the pill's vocabulary), or null to leave it. */
export function statusForStage(stage: LeadStageValue, currentStatus: string): string | null {
  switch (stage) {
    case 'CONTACTED':
    case 'ENGAGED':
    case 'PROPOSED':
      return currentStatus === 'NEW' ? 'CONTACTED' : null;
    case 'VISIT_BOOKED':
      return currentStatus === 'NEW' || currentStatus === 'CONTACTED' ? 'VISIT_BOOKED' : null;
    case 'CONVERTED':
    case 'ONBOARDING':
    case 'ACTIVATED':
    case 'RETAINED':
      return 'CONVERTED';
    case 'LOST':
      return 'LOST';
    case 'SOURCED':
    case 'SCORED':
    case 'CLAIMED':
      return currentStatus === 'LOST' ? 'NEW' : null;
  }
}

/**
 * Whether `from → to` is allowed for this actor, and why not.
 *
 * Forward only, except LOST (from any open stage, by anybody) and the
 * recycle (LOST → SCORED / SOURCED, the system's). CONVERTED is only ever
 * reached through `/convert`; ACTIVATED and RETAINED only through the
 * retention watch — they pay, and money moves only on what the platform
 * verified itself.
 */
export function stageMove(from: LeadStageValue, to: LeadStageValue, actor: StageActor): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'Already there' };
  if (to === 'LOST') {
    if (from === 'LOST') return { ok: false, reason: 'Already lost' };
    if (!isOpenStage(from) && actor !== 'SYSTEM') return { ok: false, reason: 'A converted lead cannot be lost; close the account instead' };
    return { ok: true };
  }
  if (from === 'LOST') {
    if (actor === 'SYSTEM' && (to === 'SCORED' || to === 'SOURCED')) return { ok: true };
    if (actor === 'ADMIN' && (to === 'SCORED' || to === 'SOURCED')) return { ok: true };
    return { ok: false, reason: 'A lost lead comes back through the recycle, to SOURCED or SCORED' };
  }
  if (stageRank(to) < stageRank(from)) return { ok: false, reason: 'Stages move forward only' };
  if (to === 'CONVERTED') return actor === 'SYSTEM' ? { ok: true } : { ok: false, reason: 'Convert a lead through /convert, so the account it became is recorded' };
  if (to === 'ACTIVATED' || to === 'RETAINED') return actor === 'SYSTEM' ? { ok: true } : { ok: false, reason: `${to} is read off the account by the retention watch, never set by hand` };
  if (to === 'ONBOARDING' && !isWonStage(from)) return { ok: false, reason: 'Onboarding follows conversion' };
  if (actor === 'SYSTEM') return { ok: true };
  if (!HAND_STAGES.includes(to)) return { ok: false, reason: `${to} is not a stage a hand sets` };
  // A hand may not skip the account: SOURCED..PROPOSED are open to it, ONBOARDING only from CONVERTED.
  return { ok: true };
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECYCLE_DAYS = 60;

/** D11: when a loss comes back, if ever. */
export function recycleAtFor(reason: LeadLostReasonValue, now: Date): Date | null {
  return reason === 'PRICE' || reason === 'TIMING' ? new Date(now.getTime() + RECYCLE_DAYS * DAY_MS) : null;
}

/** D11: a WRONG_CONTACT loss is not a loss — the row goes back to sourcing for a better number. */
export const returnsToSourcing = (reason: LeadLostReasonValue): boolean => reason === 'WRONG_CONTACT';

export const LOST_REASON_LABEL: Record<LeadLostReasonValue, string> = {
  NOT_INTERESTED: 'Not interested',
  WRONG_CONTACT: 'Wrong contact',
  COMPETITOR: 'With a competitor',
  PRICE: 'Price',
  TIMING: 'Timing',
  OTHER: 'Other',
};

/** "What moves this lead forward" — the detail's one line per stage. */
export function nextStepOf(lead: { stage: LeadStageValue; side: string; lostReason?: string | null; recycleAt?: Date | string | null }): { label: string; action: 'CLAIM' | 'CONTACT' | 'ENGAGE' | 'VISIT' | 'PROPOSE' | 'CONVERT' | 'ONBOARD' | 'ACTIVATE' | 'RETAIN' | 'NONE' } {
  const catchLine = lead.side === 'ADVERTISER' ? 'first campaign paid' : 'first listing live';
  switch (lead.stage) {
    case 'SOURCED':
    case 'SCORED':
      return { label: 'Claim it and make the first call', action: 'CLAIM' };
    case 'CLAIMED':
      return { label: 'Make first contact — a call, a message, a walk-in', action: 'CONTACT' };
    case 'CONTACTED':
      return { label: 'Get a reply: share the invite link or call again', action: 'ENGAGE' };
    case 'ENGAGED':
      return { label: lead.side === 'ADVERTISER' ? 'Book a demo or a call' : 'Book the visit', action: 'VISIT' };
    case 'VISIT_BOOKED':
      return { label: lead.side === 'ADVERTISER' ? 'Send an estimate or a package quote' : 'Make the visit and send the rate estimate', action: 'PROPOSE' };
    case 'PROPOSED':
      return { label: 'Convert — open the account', action: 'CONVERT' };
    case 'CONVERTED':
      return { label: 'Onboarding: KYC, the agreement, the documents', action: 'ONBOARD' };
    case 'ONBOARDING':
      return { label: `The catch: ${catchLine}`, action: 'ACTIVATE' };
    case 'ACTIVATED':
      return { label: lead.side === 'ADVERTISER' ? 'Keep them: a second campaign' : 'Keep them: a second booking', action: 'RETAIN' };
    case 'RETAINED':
      return { label: 'Retained — nothing left to do', action: 'NONE' };
    case 'LOST': {
      const reason = lead.lostReason ? LOST_REASON_LABEL[lead.lostReason as LeadLostReasonValue] ?? lead.lostReason : 'Lost';
      const when = lead.recycleAt ? ` · back in the pool ${new Date(lead.recycleAt).toISOString().slice(0, 10)}` : '';
      return { label: `Lost: ${reason}${when}`, action: 'NONE' };
    }
  }
}

/** The stage a status implies when a row carries no stage yet (the migration's rule, kept for a row written by an older path). */
export function stageForLegacy(lead: { status: string; firstContactedAt: Date | null; assignedAgentId: string | null; score: number | null }): LeadStageValue {
  if (lead.status === 'CONVERTED') return 'CONVERTED';
  if (lead.status === 'LOST') return 'LOST';
  if (lead.status === 'VISIT_BOOKED') return 'VISIT_BOOKED';
  if (lead.firstContactedAt) return 'CONTACTED';
  if (lead.assignedAgentId) return 'CLAIMED';
  if (lead.score !== null) return 'SCORED';
  return 'SOURCED';
}

export type Attribution = {
  firstContact?: { channel: string; at: string };
  engaged?: { channel: string; at: string };
  converted?: { channel: string; at: string };
};

/** D14: stamp a moment once — the first channel that produced it stands. */
export function stampAttribution(current: unknown, moment: keyof Attribution, channel: string, at: Date): Attribution {
  const base: Attribution = current && typeof current === 'object' ? { ...(current as Attribution) } : {};
  if (!base[moment]) base[moment] = { channel, at: at.toISOString() };
  return base;
}
