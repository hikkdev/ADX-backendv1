import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { prismaIntegrityRepository as repository } from './prisma-integrity.repository';
import type { FlagWithLead, ScanLead } from './integrity.repository';

/**
 * LH10 (the Lead Hunt, anti-gaming) — the integrity scan.
 *
 * Four patterns, each a fact the platform can check without judging anybody:
 *
 * - **SELF_REFERRAL** (D9): the referral behind a lead points at the
 *   referrer's own number, or the referrer and the lead's account signed in
 *   from the same device. A referral credit that pays somebody for referring
 *   themselves is the cheapest fraud in the brief.
 * - **PHONE_REUSE**: the same number seen twice. A reading recorded while
 *   building this: the leads table already refuses a second lead on a
 *   normalised number (a partial unique index), so what can actually happen
 *   is a lead whose number never normalised sitting beside one that did, or
 *   a "new lead" whose number already belongs to an account — the cheapest
 *   way to farm a conversion out of a customer who is already ours. Both
 *   are this flag.
 * - **CAPTURE_BURST**: an agent capturing more than `BURST_PER_HOUR` leads in
 *   an hour — more than a street walk can produce.
 * - **WEBHOOK_REPLAY**: a lead-form payload the platform has already taken,
 *   landing again under a second lead.
 *
 * **Nothing here acts.** A flag is opened once per lead and kind, a person
 * confirms or dismisses it (both audited), and only a CONFIRMED flag counts
 * against the agent's quality score or stops a reward. The scan is the
 * hourly job's; it re-reads the same facts and leaves an existing flag
 * alone, so a dismissed pattern does not come back every hour.
 */

/** More captures than this in one hour is a burst worth a person's eye. */
export const BURST_PER_HOUR = 12;
/** How far back the hourly scan reads. */
export const SCAN_WINDOW_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

export const LEAD_FLAG_KINDS = ['SELF_REFERRAL', 'PHONE_REUSE', 'CAPTURE_BURST', 'WEBHOOK_REPLAY'] as const;
export type LeadFlagKindValue = (typeof LEAD_FLAG_KINDS)[number];
export const LEAD_FLAG_STATUSES = ['OPEN', 'CONFIRMED', 'DISMISSED'] as const;
export type LeadFlagStatusValue = (typeof LEAD_FLAG_STATUSES)[number];

export const FLAG_LABEL: Record<LeadFlagKindValue, string> = {
  SELF_REFERRAL: 'Self-referral',
  PHONE_REUSE: 'Phone reused across leads',
  CAPTURE_BURST: 'Capture burst',
  WEBHOOK_REPLAY: 'Lead-form replay',
};

type Finding = { kind: LeadFlagKindValue; detail: string; evidence: unknown; agentId: string | null };

/* ── the four checks ──────────────────────────────────────────────── */

/** D9: the referrer's own number, or the referrer's device behind the lead's account. */
async function selfReferral(lead: ScanLead): Promise<Finding | null> {
  const referral = await repository.referralFor(lead.id);
  if (!referral) return null;
  const referrerPhone = referral.referrerPhone?.replace(/\D/g, '').slice(-10) ?? null;
  const leadPhone = lead.phoneNormalised?.replace(/\D/g, '').slice(-10) ?? null;
  if (referrerPhone && leadPhone && referrerPhone === leadPhone) {
    return {
      kind: 'SELF_REFERRAL',
      detail: `The referrer's own number is the lead's number — ${referral.referrerKind.toLowerCase()} ${referral.referrerName ?? referral.referrerId}.`,
      evidence: { reason: 'SAME_PHONE', referralId: referral.id, referrerKind: referral.referrerKind, referrerId: referral.referrerId, credited: referral.creditedAt !== null },
      agentId: lead.assignedAgentId,
    };
  }
  if (!referral.referrerUserId) return null;
  const leadUserId = await repository.userIdForLead(lead.id);
  if (!leadUserId || leadUserId === referral.referrerUserId) {
    // No account behind the lead yet, or the two are literally one login: the
    // second is the same finding by a shorter road.
    if (leadUserId && leadUserId === referral.referrerUserId) {
      return {
        kind: 'SELF_REFERRAL',
        detail: `The referred account is the referrer's own login — ${referral.referrerKind.toLowerCase()} ${referral.referrerName ?? referral.referrerId}.`,
        evidence: { reason: 'SAME_LOGIN', referralId: referral.id, userId: leadUserId, credited: referral.creditedAt !== null },
        agentId: lead.assignedAgentId,
      };
    }
    return null;
  }
  const tokens = await repository.deviceTokensFor(referral.referrerUserId);
  if (tokens.length === 0) return null;
  const others = await repository.userIdsWithDeviceTokens(tokens, referral.referrerUserId);
  if (!others.includes(leadUserId)) return null;
  return {
    kind: 'SELF_REFERRAL',
    detail: `The referrer and the referred account share a device — ${referral.referrerKind.toLowerCase()} ${referral.referrerName ?? referral.referrerId}.`,
    evidence: { reason: 'SAME_DEVICE', referralId: referral.id, userId: leadUserId, credited: referral.creditedAt !== null },
    agentId: lead.assignedAgentId,
  };
}

async function phoneReuse(lead: ScanLead): Promise<Finding | null> {
  if (!lead.phoneNormalised) return null;
  const [twins, accounts] = await Promise.all([repository.leadsWithPhone(lead.phoneNormalised, lead.id), repository.accountsWithPhone(lead.phoneNormalised)]);
  if (twins.length === 0 && accounts.length === 0) return null;
  const parts: string[] = [];
  if (twins.length) parts.push(`${twins.length + 1} leads carry this number — ${twins.slice(0, 3).map((twin) => twin.displayId ?? twin.businessName).join(', ')}${twins.length > 3 ? ` and ${twins.length - 3} more` : ''}`);
  if (accounts.length) parts.push(`the number already belongs to ${accounts.map((account) => `${account.kind.toLowerCase()} ${account.name ?? account.id}`).join(', ')}`);
  return {
    kind: 'PHONE_REUSE',
    detail: `${parts.join('; ')}.`,
    evidence: {
      phone: lead.phoneNormalised,
      leads: twins.map((twin) => ({ id: twin.id, displayId: twin.displayId, businessName: twin.businessName })),
      accounts,
    },
    agentId: lead.assignedAgentId,
  };
}

async function captureBurst(lead: ScanLead): Promise<Finding | null> {
  if (!lead.capturedByAgentId || !lead.capturedAt) return null;
  const { count, leadIds } = await repository.capturesInHour(lead.capturedByAgentId, lead.capturedAt);
  if (count <= BURST_PER_HOUR) return null;
  return {
    kind: 'CAPTURE_BURST',
    detail: `${count} leads captured in the hour to ${lead.capturedAt.toISOString().slice(11, 16)} UTC — more than a street walk produces.`,
    evidence: { agentId: lead.capturedByAgentId, count, threshold: BURST_PER_HOUR, hourTo: lead.capturedAt.toISOString(), leadIds: leadIds.slice(0, 20) },
    agentId: lead.capturedByAgentId,
  };
}

async function webhookReplay(lead: ScanLead): Promise<Finding | null> {
  if (!lead.externalKey) return null;
  const twins = await repository.leadsWithExternalKey(lead.externalKey);
  // The column is unique, so more than one row means the key was re-minted —
  // which is exactly the replay this looks for.
  if (twins.filter((twin) => twin.id !== lead.id).length === 0) return null;
  return {
    kind: 'WEBHOOK_REPLAY',
    detail: `The provider key ${lead.externalKey} arrived on ${twins.length} leads.`,
    evidence: { externalKey: lead.externalKey, leads: twins.map((twin) => ({ id: twin.id, displayId: twin.displayId })) },
    agentId: lead.assignedAgentId,
  };
}

/* ── the scan ─────────────────────────────────────────────────────── */

/** Every check over one lead — exported so the desk can re-scan a single row. */
export async function scanLead(lead: ScanLead): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const check of [selfReferral, phoneReuse, captureBurst, webhookReplay]) {
    try {
      const finding = await check(lead);
      if (finding) found.push(finding);
    } catch (err) {
      logger.warn('A lead integrity check failed', { leadId: lead.id, err });
    }
  }
  return found;
}

/**
 * The hourly scan: every lead created in the window, every check, one flag
 * per lead and kind. An existing flag is left where it is — its status is a
 * person's, and a scan that re-opened a dismissed flag every hour would be
 * a scan nobody reads.
 */
export async function scanIntegrity(now = new Date()): Promise<{ scanned: number; flagged: number; byKind: Record<string, number> }> {
  const since = new Date(now.getTime() - SCAN_WINDOW_HOURS * HOUR_MS);
  const leads = await repository.leadsCreatedSince(since, 500);
  const byKind: Record<string, number> = {};
  let flagged = 0;
  for (const lead of leads) {
    for (const finding of await scanLead(lead)) {
      const existing = await repository.findFlag(lead.id, finding.kind);
      if (existing) continue;
      await repository.createFlag({ leadId: lead.id, kind: finding.kind, detail: finding.detail, evidence: finding.evidence, agentId: finding.agentId });
      byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
      flagged += 1;
    }
  }
  // The replay pattern the message thread sees: one provider key on two leads.
  try {
    const repeats = await repository.repeatedFormMessages(since, 500);
    const byKey = new Map<string, string[]>();
    for (const row of repeats) byKey.set(row.providerId, [...(byKey.get(row.providerId) ?? []), row.leadId]);
    for (const [providerId, leadIds] of byKey) {
      if (leadIds.length < 2) continue;
      for (const leadId of leadIds) {
        if (await repository.findFlag(leadId, 'WEBHOOK_REPLAY')) continue;
        await repository.createFlag({
          leadId,
          kind: 'WEBHOOK_REPLAY',
          detail: `The lead-form payload ${providerId} was delivered to ${leadIds.length} leads.`,
          evidence: { providerId, leadIds },
          agentId: null,
        });
        byKind['WEBHOOK_REPLAY'] = (byKind['WEBHOOK_REPLAY'] ?? 0) + 1;
        flagged += 1;
      }
    }
  } catch (err) {
    logger.warn('The form-replay check failed', { err });
  }
  return { scanned: leads.length, flagged, byKind };
}

/* ── the desk ─────────────────────────────────────────────────────── */

export type FlagView = {
  id: string;
  leadId: string;
  displayId: string | null;
  businessName: string;
  city: string | null;
  side: string;
  stage: string;
  kind: string;
  label: string;
  status: string;
  detail: string;
  evidence: unknown;
  agentId: string | null;
  openedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  note: string | null;
};

export function flagView(row: FlagWithLead): FlagView {
  return {
    id: row.id,
    leadId: row.leadId,
    displayId: row.lead.displayId,
    businessName: row.lead.businessName,
    city: row.lead.city,
    side: row.lead.side,
    stage: row.lead.stage,
    kind: row.kind,
    label: FLAG_LABEL[row.kind as LeadFlagKindValue] ?? row.kind,
    status: row.status,
    detail: row.detail,
    evidence: row.evidence ?? null,
    agentId: row.agentId,
    openedAt: row.openedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    note: row.note,
  };
}

export async function listFlags(filter: { status?: string | undefined; kind?: string | undefined; agentId?: string | undefined; limit?: number | undefined }) {
  const [rows, counts] = await Promise.all([
    repository.listFlags({ status: filter.status, kind: filter.kind, agentId: filter.agentId, limit: Math.min(filter.limit ?? 100, 200) }),
    repository.countFlags({ status: 'OPEN' }),
  ]);
  return {
    items: rows.map(flagView),
    total: rows.length,
    /** How many OPEN flags of each kind wait — the desk's chips. */
    openByKind: Object.fromEntries(LEAD_FLAG_KINDS.map((kind) => [kind, counts.find((row) => row.kind === kind)?.count ?? 0])),
  };
}

/** The desk's decision — CONFIRMED or DISMISSED, with a note, audited by the caller. */
export async function decideFlag(flagId: string, input: { status: 'CONFIRMED' | 'DISMISSED'; note?: string | undefined }, actorUserId: string, now = new Date()): Promise<FlagView> {
  const flag = await repository.findFlagById(flagId);
  if (!flag) throw new ApiError(404, 'NOT_FOUND', 'No such flag');
  if (flag.status !== 'OPEN') throw new ApiError(409, 'CONFLICT', `That flag was already ${flag.status.toLowerCase()}`);
  await repository.updateFlag(flagId, { status: input.status, decidedByUserId: actorUserId, decidedAt: now, note: input.note?.trim() || null });
  await logActivity(actorUserId, input.status === 'CONFIRMED' ? 'LEAD_FLAG_CONFIRMED' : 'LEAD_FLAG_DISMISSED', undefined, {
    flagId,
    leadId: flag.leadId,
    kind: flag.kind,
    agentId: flag.agentId,
    note: input.note ?? null,
  });
  const after = await repository.findFlagById(flagId);
  return flagView(after!);
}

/** LH10: the flags on one lead — the detail's integrity line. */
export async function flagsForLead(leadId: string): Promise<FlagView[]> {
  const rows = await repository.listFlags({ limit: 50 });
  return rows.filter((row) => row.leadId === leadId).map(flagView);
}
