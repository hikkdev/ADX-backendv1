import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import { toListPage } from '../../shared/pagination';
import { agentMeetsGrade, assertAgentAcceptsWork, findAgentProfile, getRoutingSettings } from '../agents';
import { gradeRank, requiredGradeForLead, type AgentGradeCode } from '../../shared/dispatch';
import { logger } from '../../shared/logging';
import { allocateIdentifier } from '../identifiers';
import { rateFor } from '../payouts';
import { cityKeyFor, citySupport, withCityKey } from '../pricing';
import { createVisit } from '../visits';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { prismaOutreachRepository as outreach } from './prisma-outreach.repository';
import { inviteView } from './invites.rules';
import { distanceM } from './prisma-leads.repository';
import type { AccountByPhone, LeadCluster, LeadClusterScope, NewLead } from './leads.repository';
import { foldNameCity, normalisePhone } from './leads.phone';
import { recomputeLead, reasonsOf, touchLead } from './scoring.service';
import type { ScoreReason } from './scoring.rules';
import { advanceStage, moveStage, payConversion } from './stages.service';
import { nextStepOf, type Attribution, type LeadStageValue } from './stages.rules';
import {
  isOpenLead,
  leadPillOf,
  type AdminLeadsQuery,
  type CreateLeadInput,
  type ImportLeadRow,
  type ImportRowReport,
  type LeadStatusValue,
  type LeadTemperatureValue,
  type NearLeadsQuery,
} from './leads.schema';

/**
 * A lead as a screen reads it.
 *
 * `pill` travels with the row so the app never keeps a second copy of the
 * mapping from six statuses onto the three the card draws, and `distanceM` is
 * computed where the point is known rather than on the phone.
 */
export type LeadCard = {
  id: string;
  displayId: string | null;
  side: string;
  businessName: string;
  category: string | null;
  locality: string | null;
  city: string | null;
  status: LeadStatusValue;
  pill: { label: string; tone: string };
  /** A decimal string, or null where the platform has no rate to quote. */
  estimatedCommission: string | null;
  /** Null when either end of the pair has no coordinates. */
  distanceM: number | null;
  /** The card swaps the money slot for this once a visit is on the books. */
  visitBooked: boolean;
  latitude: number | null;
  longitude: number | null;
  contactName: string | null;
  phone: string | null;
  interest: string | null;
  source: string | null;
  bestTimeFrom: string | null;
  bestTimeTo: string | null;
  firstContactedAt: string | null;
  assignedAgentId: string | null;
  /** AG-5: the band, and the grade it is routed to. */
  importance: string;
  requiredGrade: AgentGradeCode;
  /** LH1: the score and the temperature it lands in; null until the first computation. */
  score: number | null;
  temperature: LeadTemperatureValue | null;
  /** LH1: what the business is worth to ADX (not the agent's fee); a decimal string or null. */
  estimatedValue: string | null;
  /** LH1: the breakdown behind the score — "why it is hot". */
  scoreReasons: ScoreReason[];
  /** LH1: the agent's flag, while it lives. */
  agentFlaggedHotAt: string | null;
  lastTouchedAt: string | null;
  /** LH2: where the deal is (D12), and what moves it forward. */
  stage: LeadStageValue;
  stageChangedAt: string | null;
  nextStep: { label: string; action: string };
  lostReason: string | null;
  lostNote: string | null;
  activatedAt: string | null;
  retainedAt: string | null;
  recycleAt: string | null;
  /** LH11: when it last came back to the cold pool, and how many times — the board's "recycled" flag. */
  recycledAt: string | null;
  recycleCount: number;
  /** LH2 (D14): which channel produced the first contact, the engagement, the conversion. */
  attribution: Attribution;
  /** LH4: spotted in the street — by whom, when, and the photo file ids (opened through `/files/:id`). */
  capturedByAgentId: string | null;
  capturedAt: string | null;
  photoFileIds: string[];
  /** LH5 (D3): the claim on it, while the hold runs. */
  claimedByAgentId: string | null;
  claimExpiresAt: string | null;
  territoryId: string | null;
};

export type LeadRow = {
  id: string;
  displayId: string | null;
  side: string;
  businessName: string;
  category: string | null;
  locality: string | null;
  city: string | null;
  status: string;
  estimatedCommission: unknown;
  latitude: number | null;
  longitude: number | null;
  contactName: string | null;
  phone: string | null;
  interest: string | null;
  source: string | null;
  bestTimeFrom: string | null;
  bestTimeTo: string | null;
  firstContactedAt: Date | null;
  assignedAgentId: string | null;
  importance?: string | null;
  score?: number | null;
  temperature?: string | null;
  estimatedValue?: unknown;
  scoreReasons?: unknown;
  agentFlaggedHotAt?: Date | null;
  lastTouchedAt?: Date | null;
  stage?: string;
  stageChangedAt?: Date | null;
  lostReason?: string | null;
  lostNote?: string | null;
  activatedAt?: Date | null;
  retainedAt?: Date | null;
  recycleAt?: Date | null;
  recycledAt?: Date | null;
  recycleCount?: number;
  attribution?: unknown;
  capturedByAgentId?: string | null;
  capturedAt?: Date | null;
  photoFileIds?: string[];
  claimedByAgentId?: string | null;
  claimExpiresAt?: Date | null;
  territoryId?: string | null;
};

export function toLeadCard(
  lead: LeadRow,
  near: { latitude: number; longitude: number } | null,
  requiredGradeOf: (importance: string) => AgentGradeCode = (importance) => requiredGradeForLead(importance),
): LeadCard {
  const importance = lead.importance ?? 'STANDARD';
  const status = lead.status as LeadStatusValue;
  const temperature = (lead.temperature as LeadTemperatureValue | null | undefined) ?? null;
  return {
    id: lead.id,
    displayId: lead.displayId,
    side: lead.side,
    businessName: lead.businessName,
    category: lead.category,
    locality: lead.locality,
    city: lead.city,
    status,
    pill: leadPillOf(status, temperature),
    estimatedCommission: lead.estimatedCommission === null || lead.estimatedCommission === undefined ? null : money(lead.estimatedCommission as never),
    distanceM: near ? distanceM(near, lead) : null,
    visitBooked: status === 'VISIT_BOOKED',
    latitude: lead.latitude,
    longitude: lead.longitude,
    contactName: lead.contactName,
    phone: lead.phone,
    interest: lead.interest,
    source: lead.source,
    bestTimeFrom: lead.bestTimeFrom,
    bestTimeTo: lead.bestTimeTo,
    firstContactedAt: lead.firstContactedAt?.toISOString() ?? null,
    assignedAgentId: lead.assignedAgentId,
    importance,
    requiredGrade: requiredGradeOf(importance),
    score: lead.score ?? null,
    temperature,
    estimatedValue: lead.estimatedValue === null || lead.estimatedValue === undefined ? null : money(lead.estimatedValue as never),
    scoreReasons: reasonsOf(lead.scoreReasons),
    agentFlaggedHotAt: lead.agentFlaggedHotAt?.toISOString() ?? null,
    lastTouchedAt: lead.lastTouchedAt?.toISOString() ?? null,
    stage: (lead.stage as LeadStageValue | undefined) ?? 'SOURCED',
    stageChangedAt: lead.stageChangedAt?.toISOString() ?? null,
    nextStep: nextStepOf({ stage: (lead.stage as LeadStageValue | undefined) ?? 'SOURCED', side: lead.side, lostReason: lead.lostReason ?? null, recycleAt: lead.recycleAt ?? null }),
    lostReason: lead.lostReason ?? null,
    lostNote: lead.lostNote ?? null,
    activatedAt: lead.activatedAt?.toISOString() ?? null,
    retainedAt: lead.retainedAt?.toISOString() ?? null,
    recycleAt: lead.recycleAt?.toISOString() ?? null,
    recycledAt: lead.recycledAt?.toISOString() ?? null,
    recycleCount: lead.recycleCount ?? 0,
    attribution: (lead.attribution && typeof lead.attribution === 'object' ? (lead.attribution as Attribution) : {}),
    capturedByAgentId: lead.capturedByAgentId ?? null,
    capturedAt: lead.capturedAt?.toISOString() ?? null,
    photoFileIds: lead.photoFileIds ?? [],
    claimedByAgentId: lead.claimedByAgentId ?? null,
    claimExpiresAt: lead.claimExpiresAt?.toISOString() ?? null,
    territoryId: lead.territoryId ?? null,
  };
}

/* ── LH1: sources ───────────────────────────────────────────────────────── */

/** The source key a label folds to — lower-cased, trimmed; the migration folded the legacy labels the same way. */
export const sourceKeyOf = (label: string): string => label.trim().toLowerCase();

/**
 * The `LeadSource` row a label names, created on first sight under the
 * kind the door says (an import batch is IMPORT, the console MANUAL, the
 * waitlist INBOUND). A door that knows its row passes the key straight.
 */
export async function resolveSource(label: string | null | undefined, kind: 'IMPORT' | 'FEED' | 'CAPTURE' | 'QR' | 'INBOUND' | 'REFERRAL' | 'ADS' | 'MANUAL'): Promise<string | null> {
  const key = label ? sourceKeyOf(label) : kind.toLowerCase();
  if (!key) return null;
  const existing = await repository.findSourceByKey(key);
  if (existing) return existing.id;
  try {
    return (await repository.createSource({ key, kind, label: label?.trim() || key })).id;
  } catch (error) {
    // Two doors racing on a new label: the unique refuses the second insert and the first row wins.
    if (isUniqueViolation(error)) return (await repository.findSourceByKey(key))?.id ?? null;
    throw error;
  }
}

export async function listSources() {
  return (await repository.listSources()).map(sourceView);
}

export function sourceView(row: { id: string; key: string; kind: string; label: string; quality: unknown; quotaPerDay: number | null; termsAcceptedAt: Date | null; isActive: boolean; config: unknown; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    label: row.label,
    quality: Number(row.quality),
    quotaPerDay: row.quotaPerDay,
    termsAcceptedAt: row.termsAcceptedAt?.toISOString() ?? null,
    isActive: row.isActive,
    config: row.config ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function patchSource(id: string, patch: { label?: string | undefined; quality?: number | undefined; isActive?: boolean | undefined; quotaPerDay?: number | null | undefined; termsAccepted?: boolean | undefined }) {
  const sources = await repository.listSources();
  const source = sources.find((row) => row.id === id);
  if (!source) throw new ApiError(404, 'NOT_FOUND', 'No such source');
  const { termsAccepted, ...rest } = patch;
  const updated = await repository.updateSource(id, {
    ...(rest.label !== undefined ? { label: rest.label } : {}),
    ...(rest.quality !== undefined ? { quality: rest.quality } : {}),
    ...(rest.isActive !== undefined ? { isActive: rest.isActive } : {}),
    ...(rest.quotaPerDay !== undefined ? { quotaPerDay: rest.quotaPerDay } : {}),
    ...(termsAccepted !== undefined ? { termsAcceptedAt: termsAccepted ? new Date() : null } : {}),
  });
  return sourceView(updated);
}

/**
 * LH1: the agent's "this one is hot" — the flag the score reads for 14
 * days (renewed by flagging again), and the only thing the old HOT status
 * meant. Off clears it. Either way the score is recomputed at once so the
 * pill answers the tap.
 */
export async function flagHot(leadId: string, actorUserId: string, hot: boolean) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenLead(lead.status as LeadStatusValue)) throw new ApiError(409, 'CONFLICT', 'That lead is closed');
  await repository.update(leadId, { agentFlaggedHotAt: hot ? new Date() : null });
  await repository.logActivity({ leadId, actorUserId, kind: 'NOTE', note: hot ? 'Flagged hot by the agent' : 'Hot flag cleared' });
  await touchLead(leadId);
  return getLead(leadId);
}

/* ── AG-5: routing by grade ─────────────────────────────────────────────── */

/** The importance bands an agent of this grade may take — every band whose required grade is at or below theirs. */
export function importancesForGrade(grade: string | null | undefined, settings: Parameters<typeof requiredGradeForLead>[1]): string[] {
  const rank = gradeRank(grade);
  return (['STANDARD', 'KEY', 'ENTERPRISE'] as const).filter((band) => gradeRank(requiredGradeForLead(band, settings)) <= rank);
}

/** The desk assigning a lead over its band — allowed, and said so. */
async function noteGradeOverride(leadId: string, agentId: string, importance: string | null | undefined): Promise<void> {
  const settings = await getRoutingSettings();
  const required = requiredGradeForLead(importance ?? 'STANDARD', settings);
  if (!(await agentMeetsGrade(agentId, required))) {
    logger.info('Lead assigned below the grade its band asks for (desk override)', { leadId, agentId, importance: importance ?? 'STANDARD', required });
  }
}

/**
 * What the platform pays an agent for converting a prospect.
 *
 * DR 06's card prints "Est. ₹1,450". That figure is read from the incentive
 * rate rather than typed onto the lead, because an estimate that does not match
 * what the platform actually pays is worse than no estimate — and the rates are
 * effective-dated, so a number stored last quarter would quietly go stale.
 *
 * A lead may still carry its own figure where ops knows better; this is only
 * the fallback.
 */
async function quotedEstimate(side: string): Promise<string | null> {
  return rateFor(side === 'ADVERTISER' ? 'CAMPAIGN_ASSIST' : 'PUBLISHER_ONBOARDED');
}

/**
 * Lot D (Q93): the phone as the hard key. A number that is not a number is
 * refused; one already on a lead is a duplicate (409, naming the lead); one
 * already on a publisher or advertiser account is an account (409
 * EXISTING_ACCOUNT) — never quietly turned into a prospect.
 */
async function assertPhoneFree(phoneNormalised: string | null): Promise<void> {
  if (!phoneNormalised) return;
  const [leads, accounts] = await Promise.all([
    repository.findByPhones([phoneNormalised]),
    repository.findAccountsByPhones([phoneNormalised]),
  ]);
  const existing = leads[0];
  if (existing) {
    throw new ApiError(409, 'CONFLICT', `That number is already on lead ${existing.displayId ?? existing.id}`, {
      reason: 'DUPLICATE_LEAD',
      leadId: existing.id,
      displayId: existing.displayId,
    });
  }
  const account = accounts[0];
  if (account) {
    throw new ApiError(409, 'CONFLICT', `That number belongs to a ${account.kind.toLowerCase()} account already`, {
      reason: 'EXISTING_ACCOUNT',
      kind: account.kind,
      id: account.id,
    });
  }
}

export async function createLead(input: CreateLeadInput, createdByUserId: string | null) {
  // Lot A BLOCK_NEW: a lead handed to an agent is work, so a suspended agent
  // is refused here rather than quietly holding a lead nobody will call.
  if (input.assignedAgentId) {
    await assertAgentAcceptsWork(input.assignedAgentId);
    await noteGradeOverride('(new)', input.assignedAgentId, input.importance);
  }
  const phoneNormalised = normalisePhone(input.phone);
  if (input.phone && !phoneNormalised) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'That does not look like a phone number', { phone: input.phone });
  }
  await assertPhoneFree(phoneNormalised);
  const displayId = await allocateIdentifier('LEAD');
  const estimate = input.estimatedCommission ?? (await quotedEstimate(input.side));
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const lead = await repository.create(
    await withCityKey({
      ...input,
      displayId,
      phoneNormalised,
      estimatedCommission: estimate,
      createdByUserId,
      // LH1: the source door (the label's row, MANUAL for the desk's bare create) and the recency clock.
      sourceId: await resolveSource(input.source, 'MANUAL'),
      lastTouchedAt: new Date(),
    }),
  );
  await repository.logActivity({
    leadId: lead.id,
    actorUserId: createdByUserId,
    kind: 'IMPORTED',
    note: input.source ? `Added from ${input.source}` : 'Added',
  });
  // LH1: scored before the answer, so the card carries its temperature from birth.
  await recomputeLead(lead.id).catch((err) => logger.warn('New lead not scored', { leadId: lead.id, err }));
  // LH2: a lead born on an agent's list is theirs — CLAIMED.
  if (input.assignedAgentId) await advanceStage(lead.id, 'CLAIMED', { actorUserId: createdByUserId, note: 'assigned at creation' });
  // T-B: the create answers what GET /leads/:leadId answers — the card
  // (`pill`, `distanceM`, `visitBooked`) with the address, email and the
  // activity just written — the way the patch already does.
  return getLead(lead.id);
}

/** Prisma's unique-violation code, duck-typed the way agreements/legal/invoices read it — the client stays in the repository. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** W-B: the source label a waitlist tap writes — a `LeadSource`-style label until the leads lots land. */
export const WAITLIST_SOURCE = 'WAITLIST';

export type WaitlistLeadInput = Omit<CreateLeadInput, 'source' | 'assignedAgentId' | 'estimatedCommission'> & { note?: string | undefined };

/**
 * W-B: an account asking to be told when a city launches (`POST
 * /app/geo/waitlist`). The phone rule dedupes — a second tap from the same
 * number answers the lead it already has (`created: false`) and notes the
 * ask on its thread, never a second lead — but the account half of that
 * rule does not apply: the number belongs to the caller's own publisher or
 * advertiser account by construction, and that is the point, not a
 * collision. The city gate is not asked either: a waitlist is for a city
 * whose lead feeds are off. The IMPORTED row names the source; the caller
 * audits nothing (it is the requester's own act).
 */
export async function registerWaitlistLead(input: WaitlistLeadInput, userId: string): Promise<{ lead: Awaited<ReturnType<typeof getLead>>; created: boolean }> {
  const phoneNormalised = normalisePhone(input.phone);
  if (input.phone && !phoneNormalised) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'That does not look like a phone number', { phone: input.phone });
  }
  const { note, ...fields } = input;
  const askedAgain = async (leadId: string) => {
    await repository.logActivity({
      leadId,
      actorUserId: userId,
      kind: 'NOTE',
      note: `Waitlist: ${fields.interest ?? `asked again for ${fields.city ?? 'a city'}`}${note ? ` — ${note}` : ''}`,
    });
    return { lead: await getLead(leadId), created: false };
  };
  const existing = phoneNormalised ? (await repository.findByPhones([phoneNormalised]))[0] : undefined;
  if (existing) return askedAgain(existing.id);
  const displayId = await allocateIdentifier('LEAD');
  let lead: Awaited<ReturnType<typeof repository.create>>;
  try {
    lead = await repository.create(
      await withCityKey({
        ...fields,
        source: WAITLIST_SOURCE,
        displayId,
        phoneNormalised,
        estimatedCommission: await quotedEstimate(fields.side),
        createdByUserId: userId,
        sourceId: await resolveSource(WAITLIST_SOURCE, 'INBOUND'),
        lastTouchedAt: new Date(),
      }),
    );
  } catch (error) {
    // Two taps racing each other: both read no lead on the number, and the
    // partial unique `Lead_phoneNormalised_key` refuses the second insert.
    // The loser answers the lead the winner wrote (the route's 200), never a
    // 500 — the same one-lead-per-number the read above promises.
    const raced = isUniqueViolation(error) && phoneNormalised ? (await repository.findByPhones([phoneNormalised]))[0] : undefined;
    if (!raced) throw error;
    return askedAgain(raced.id);
  }
  await repository.logActivity({
    leadId: lead.id,
    actorUserId: userId,
    kind: 'IMPORTED',
    note: `Added from ${WAITLIST_SOURCE}${note ? `: ${note}` : ''}`,
  });
  await recomputeLead(lead.id).catch((err) => logger.warn('Waitlist lead not scored', { leadId: lead.id, err }));
  return { lead: await getLead(lead.id), created: true };
}

/**
 * A batch — Lot D (Q93).
 *
 * Every row is checked before anything is written: the phone is normalised
 * (INVALID when it is not a number); a number already on a lead — in the
 * database or earlier in the sheet — is DUPLICATE_LEAD and skipped; a number
 * on a publisher or advertiser account is EXISTING_ACCOUNT and skipped, never
 * converted; a business name + city already seen is a WARNING and the lead
 * is still created. Then one identifier per surviving row, minted in order
 * (the counter is the one thing that cannot be done in bulk), and one
 * transaction for the whole batch. `dryRun` stops after the report.
 */
export async function importLeads(
  source: string,
  rows: ImportLeadRow[],
  createdByUserId: string | null,
  options: { dryRun?: boolean; sourceKind?: 'IMPORT' | 'FEED' | 'ADS' | 'INBOUND'; feedRunId?: string } = {},
) {
  const phones = rows.map((row) => normalisePhone(row.phone));
  const known = phones.filter((phone): phone is string => phone !== null);
  const [existingLeads, accounts, sameNames] = await Promise.all([
    repository.findByPhones(known),
    repository.findAccountsByPhones(known),
    repository.findByNameAndCity([...new Set(rows.map((row) => row.businessName.trim()))]),
  ]);
  const leadByPhone = new Map(existingLeads.map((lead) => [lead.phoneNormalised, lead]));
  const accountByPhone = new Map<string, AccountByPhone>(accounts.map((account) => [account.phoneNormalised, account]));
  const seenName = new Map<string, string>();
  for (const lead of sameNames) seenName.set(foldNameCity(lead.businessName, lead.city), lead.displayId ?? lead.id);
  const seenPhone = new Map<string, number>();
  // Lot V: the feed only fills cities whose rollout stage has lead feeds on
  // (SEEDING and LAUNCHED). One lookup per distinct city in the sheet; a
  // city the catalogue lacks is free text and passes.
  const closedCities = new Map<string, string>();
  for (const city of new Set(rows.map((row) => row.city?.trim()).filter((city): city is string => Boolean(city)))) {
    const view = await citySupport(city);
    if (view.resolved && !view.switches.leadFeeds) closedCities.set(city, `${view.city!.name} (${view.stage!.toLowerCase()})`);
  }

  const report: ImportRowReport[] = [];
  const toCreate: { index: number; row: ImportLeadRow; phoneNormalised: string | null }[] = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    const phone = phones[i] ?? null;
    const nameKey = foldNameCity(row.businessName, row.city);
    const sameName = seenName.get(nameKey);
    // The name is remembered whatever becomes of the row: a business that
    // was a duplicate is still a business the next row may be repeating.
    if (!sameName) seenName.set(nameKey, `${row.businessName.trim()} (row ${n})`);

    if (row.phone && !phone) {
      report.push({ row: n, outcome: 'INVALID', ref: null, message: `"${row.phone}" is not a phone number` });
      return;
    }
    const closed = row.city?.trim() ? closedCities.get(row.city.trim()) : undefined;
    if (closed) {
      report.push({ row: n, outcome: 'CITY_NOT_OPEN', ref: null, message: `ADX is not taking leads in ${closed}` });
      return;
    }
    if (phone) {
      const earlier = seenPhone.get(phone);
      if (earlier !== undefined) {
        report.push({ row: n, outcome: 'DUPLICATE_LEAD', ref: `row ${earlier}`, message: `Same number as row ${earlier}` });
        return;
      }
      const existing = leadByPhone.get(phone);
      if (existing) {
        report.push({ row: n, outcome: 'DUPLICATE_LEAD', ref: existing.displayId ?? existing.id, message: `Already lead ${existing.displayId ?? existing.id}` });
        return;
      }
      const account = accountByPhone.get(phone);
      if (account) {
        report.push({ row: n, outcome: 'EXISTING_ACCOUNT', ref: account.id, message: `Number belongs to a ${account.kind.toLowerCase()} account` });
        return;
      }
      seenPhone.set(phone, n);
    }
    toCreate.push({ index: report.length, row, phoneNormalised: phone });
    report.push(
      sameName
        ? { row: n, outcome: 'WARNING', ref: null, message: `Looks like ${sameName} — same name and city` }
        : { row: n, outcome: 'CREATED', ref: null, message: 'Created' },
    );
  });

  const skipped = report.filter((entry) => entry.outcome !== 'CREATED' && entry.outcome !== 'WARNING').length;
  const warnings = report.filter((entry) => entry.outcome === 'WARNING').length;
  if (options.dryRun) {
    return { dryRun: true, imported: toCreate.length, skipped, warnings, ids: [] as string[], report };
  }

  for (const entry of toCreate) {
    if (entry.row.assignedAgentId) await assertAgentAcceptsWork(entry.row.assignedAgentId);
  }
  const batch: (NewLead & { displayId: string })[] = [];
  // LH1: one source row per batch label, resolved once.
  const sourceId = await resolveSource(source, options.sourceKind ?? 'IMPORT');
  const now = new Date();
  for (const entry of toCreate) {
    // Lot X-B: the key beside each row's typed city — cached a minute per spelling, so one lookup per distinct town.
    batch.push(
      await withCityKey({
        ...entry.row,
        source,
        displayId: await allocateIdentifier('LEAD'),
        phoneNormalised: entry.phoneNormalised,
        estimatedCommission: entry.row.estimatedCommission ?? (await quotedEstimate(entry.row.side)),
        createdByUserId,
        sourceId,
        lastTouchedAt: now,
        ...(entry.row.externalKey ? { externalKey: entry.row.externalKey } : {}),
        ...(options.feedRunId ? { feedRunId: options.feedRunId } : {}),
      }),
    );
  }
  const created = batch.length > 0 ? await repository.importBatch(batch) : [];
  created.forEach((lead, i) => {
    const entry = report[toCreate[i]!.index]!;
    entry.ref = lead.displayId ?? lead.id;
  });
  // LH1: every new row scored — a batch of 500 is 500 small reads, well inside a request.
  for (const lead of created) await recomputeLead(lead.id, now).catch((err) => logger.warn('Imported lead not scored', { leadId: lead.id, err }));
  return { dryRun: false, imported: created.length, skipped, warnings, ids: created.map((lead) => lead.id), report };
}

/**
 * Lot V: the city wind-down closes every open lead in a city ADX pulled out
 * of — LOST, with the loss recorded on the activity thread (`Lead` carries
 * no loss-reason column; the activity note is where a loss has always been
 * explained). `spellings` are the city's name and aliases as `geo` knows
 * them; the match is case-insensitive on the free-text `city`.
 */
export const CITY_WITHDRAWN_LOSS = 'city withdrawn';

/** Lot X-B: `city` is the key (rows keyed to it, however typed) with the spellings as the fallback for the rows whose key is null. */
export async function closeOpenLeadsInCity(city: { cityId: string | null; spellings: string[] }, actorUserId: string | null): Promise<string[]> {
  return repository.closeOpenLeadsInCities(city, actorUserId, CITY_WITHDRAWN_LOSS);
}

/**
 * The agent's own list. AG-5: narrowed to the importance bands their grade
 * may take, when the settings enforce it — a G1 does not see a KEY lead on
 * the map; an ops read (no viewer) sees every band.
 */
export async function leadsNear(query: NearLeadsQuery, viewer?: { userId: string }) {
  const near =
    query.lat !== undefined && query.lng !== undefined
      ? { latitude: query.lat, longitude: query.lng }
      : null;
  const settings = await getRoutingSettings();
  let importances: string[] | undefined;
  if (viewer && settings.enforce) {
    const agent = await findAgentProfile(viewer.userId);
    importances = importancesForGrade(agent?.grade ?? null, settings);
  }
  const { items, total, counts, temperatureCounts, stageCounts } = await repository.findNear(query, importances);
  return { ...toListPage(items.map((lead) => toLeadCard(lead as LeadRow, near, (importance) => requiredGradeForLead(importance, settings))), total, counts, query), temperatureCounts, stageCounts };
}

export async function leadsForAdmin(query: AdminLeadsQuery) {
  // Lot X-B: `?city=` is a slug (or a name, for the console's older links) — matched by key, the spelling as the fallback.
  const keyed = query.city ? { ...query, cityId: (await cityKeyFor(query.city))?.cityId ?? null } : query;
  const { items, total, counts, temperatureCounts, stageCounts } = await repository.findForAdmin(keyed);
  return { ...toListPage(items.map((lead) => toLeadCard(lead as LeadRow, null)), total, counts, query), temperatureCounts, stageCounts };
}

/**
 * One lead with its thread. LH5: `viewerUserId` names the caller so the
 * answer can say whose the hold is — `claim.mine` is what the agent app's
 * Claim / Release door reads, since a phone does not know its own agent id.
 */
export async function getLead(leadId: string, viewerUserId?: string) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const now = new Date();
  const held = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  let mine = false;
  if (held && viewerUserId) {
    try {
      const viewer = await findAgentProfile(viewerUserId);
      mine = viewer?.id === held;
    } catch {
      mine = false;
    }
  }
  // LH7: the live invite, for Share and "opened 2 h ago".
  const invite = await outreach.findActiveInvite(leadId, now).catch(() => null);
  // LH8: what the hunt paid on this lead — the phone's success modal on ACTIVATED reads the figure here, never off a card.
  const rewards = lead.status === 'CONVERTED' ? await repository.rewardsFor({ id: lead.id, convertedPublisherId: lead.convertedPublisherId, convertedAdvertiserId: lead.convertedAdvertiserId }).catch(() => []) : [];
  return {
    ...toLeadCard(lead as LeadRow, null),
    claim: held ? { agentId: held, mine, expiresAt: lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimExpiresAt.toISOString() : null } : null,
    invite: invite ? inviteView(invite, now) : null,
    rewards: rewards.map((reward) => ({ id: reward.id, event: reward.event, amount: money(reward.amount), status: reward.status, note: reward.note, at: reward.at.toISOString() })),
    address: lead.address,
    email: lead.email,
    activity: lead.activity.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      note: entry.note,
      at: entry.createdAt.toISOString(),
    })),
  };
}

/**
 * The agent says they have spoken to them.
 *
 * `firstContactedAt` is stamped once and never moved: the detail screen prints
 * "First contact — Not yet", and a field that reset on every call could never
 * answer that question.
 */
export async function logContact(
  leadId: string,
  actorUserId: string,
  entry: { kind: 'CALLED' | 'MESSAGED' | 'NOTE' | 'FOLLOW_UP'; note?: string | undefined },
) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');

  await repository.logActivity({
    leadId,
    actorUserId,
    kind: entry.kind,
    note: entry.note ?? null,
  });

  const patch: Record<string, unknown> = {};
  if (!lead.firstContactedAt) patch['firstContactedAt'] = new Date();
  // NEW is the only status a contact moves on its own. HOT is a judgement the
  // agent makes and a visit is a fact; neither is undone by a phone call.
  if (lead.status === 'NEW') patch['status'] = 'CONTACTED';
  if (Object.keys(patch).length > 0) await repository.update(leadId, patch);
  // LH1: a contact is a touch — the recency clock restarts and the score follows.
  await touchLead(leadId);
  // LH2: a call or a message is the first touch — CONTACTED, with the channel stamped (D14).
  if (entry.kind === 'CALLED' || entry.kind === 'MESSAGED') {
    await advanceStage(leadId, 'CONTACTED', { actorUserId, channel: entry.kind === 'CALLED' ? 'CALL' : 'OTHER' });
  }

  return getLead(leadId);
}

/**
 * Books a visit against a lead — DR 06's "Visit" button and START ONBOARDING
 * VISIT.
 *
 * The visit is a real `FieldVisit` on the agent's day, not a flag on the lead:
 * the Visits list, the day view and the dispatch board all read it from there.
 * The lead just remembers that one exists.
 */
export async function bookVisit(leadId: string, actorUserId: string, note?: string, scheduledFor?: string) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenLead(lead.status as LeadStatusValue)) {
    throw new ApiError(409, 'CONFLICT', 'That lead is closed');
  }
  const visit = await createVisit(
    {
      kind: 'ONBOARDING',
      leadId,
      businessName: lead.businessName,
      ...(lead.locality ? { locality: lead.locality } : {}),
      ...(lead.city ? { city: lead.city } : {}),
      ...(lead.latitude !== null ? { latitude: lead.latitude } : {}),
      ...(lead.longitude !== null ? { longitude: lead.longitude } : {}),
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(note ? { notes: note } : {}),
    },
    { userId: actorUserId, isAdmin: false },
  );
  await repository.update(leadId, {
    status: 'VISIT_BOOKED',
    ...(lead.firstContactedAt ? {} : { firstContactedAt: new Date() }),
    ...(lead.assignedAgentId ? {} : { assignedAgentId: visit.agentId }),
  });
  await repository.logActivity({
    leadId,
    actorUserId,
    kind: 'VISIT_BOOKED',
    note: note ?? `Visit ${visit.displayId ?? visit.id}`,
  });
  await touchLead(leadId);
  await advanceStage(leadId, 'VISIT_BOOKED', { actorUserId, note: `visit ${visit.displayId ?? visit.id}` });
  return { ...(await getLead(leadId)), visit };
}

/**
 * The lead became an account. Recorded once and never again — the funnel counts
 * conversions, and a lead that could convert twice would be counted twice.
 */
export async function convertLead(
  leadId: string,
  actorUserId: string,
  target: { publisherId?: string | undefined; advertiserId?: string | undefined },
  /** LH2 (D14): the channel the conversion came through — the field by default; LINK from the invite page. */
  channel: string = 'IN_PERSON',
) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (lead.status === 'CONVERTED') {
    throw new ApiError(409, 'CONFLICT', 'That lead has already been converted');
  }
  // Lot D (Q93): the lead's number against both account tables. The match is
  // what the lead became; a caller naming a different account is refused
  // rather than second-guessed, and with nothing named the match is linked.
  const phone = lead.phoneNormalised ?? normalisePhone(lead.phone);
  const match = phone ? (await repository.findAccountsByPhones([phone]))[0] ?? null : null;
  let publisherId = target.publisherId ?? null;
  let advertiserId = target.advertiserId ?? null;
  if (match) {
    const named = match.kind === 'PUBLISHER' ? publisherId : advertiserId;
    const other = match.kind === 'PUBLISHER' ? advertiserId : publisherId;
    if ((named && named !== match.id) || other) {
      throw new ApiError(409, 'CONFLICT', `The lead's number belongs to ${match.kind.toLowerCase()} ${match.id}`, { kind: match.kind, id: match.id });
    }
    if (match.kind === 'PUBLISHER') publisherId = match.id;
    else advertiserId = match.id;
  }
  if (!publisherId && !advertiserId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name the account the lead became — its number matches none');
  }
  await repository.update(leadId, {
    status: 'CONVERTED',
    convertedAt: new Date(),
    convertedPublisherId: publisherId,
    convertedAdvertiserId: advertiserId,
  });
  await repository.logActivity({
    leadId,
    actorUserId,
    kind: 'STATUS_CHANGED',
    note: 'Converted',
  });
  await touchLead(leadId);
  // LH2: the stage, the channel that closed it, and D1's LEAD_CONVERTED to the agent holding it (or the agent converting it).
  await moveStage(leadId, 'CONVERTED', 'SYSTEM', { actorUserId, channel, note: channel === 'LINK' ? 'through the invite link' : null }).catch((err) => logger.warn('Conversion stage not moved', { leadId, err }));
  const converted = await repository.findById(leadId);
  if (converted) {
    let actorAgentId: string | null = null;
    if (!lead.assignedAgentId) {
      try {
        actorAgentId = (await findAgentProfile(actorUserId))?.id ?? null;
      } catch {
        actorAgentId = null;
      }
    }
    await payConversion(converted, actorAgentId);
  }
  return getLead(leadId);
}

/**
 * The map layer the agent dashboard has been drawing from an empty array.
 * Lot X-L: a city scope is resolved to its key first, so the bubbles cover
 * the leads keyed to the city whatever they were typed as, plus the
 * null-keyed ones typed under this spelling.
 */
export async function leadClusters(scope: LeadClusterScope): Promise<LeadCluster[]> {
  if (scope.point || !scope.city) return repository.clustersNear(scope);
  return repository.clustersNear({ ...scope, cityId: (await cityKeyFor(scope.city))?.cityId ?? null });
}

export async function patchLead(leadId: string, actorUserId: string, patch: Record<string, unknown>) {
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  // Lot A BLOCK_NEW: reassigning a lead is the same dispatch a creation is.
  // Clearing it (null) always works — that is how a lead comes off a suspended
  // agent and back into the open pool.
  if (typeof patch['assignedAgentId'] === 'string') {
    await assertAgentAcceptsWork(patch['assignedAgentId']);
    await noteGradeOverride(leadId, patch['assignedAgentId'], (patch['importance'] as string | undefined) ?? (lead as { importance?: string }).importance);
  }
  // Converting is its own act, with its own record. A PATCH that could set the
  // status to CONVERTED would leave `convertedAt` null and break the table's
  // own check constraint.
  if (patch['status'] === 'CONVERTED') {
    throw new ApiError(400, 'BAD_REQUEST', 'Convert a lead through /convert, so the account it became is recorded');
  }
  // Lot D (Q93): a new number is re-normalised and checked like a new lead's.
  if ('phone' in patch) {
    const phoneNormalised = normalisePhone(patch['phone'] as string | null | undefined);
    if (patch['phone'] && !phoneNormalised) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'That does not look like a phone number', { phone: patch['phone'] });
    }
    if (phoneNormalised !== lead.phoneNormalised) await assertPhoneFree(phoneNormalised);
    patch = { ...patch, phoneNormalised };
  }
  // LH1: the status HOT the desk used to set is the agent's flag now — the
  // score reads it for 14 days and the pill reads the temperature. The row
  // keeps its lifecycle status; a console that still sends HOT is honoured.
  if (patch['status'] === 'HOT') {
    const { status: _hot, ...rest } = patch;
    patch = { ...rest, agentFlaggedHotAt: new Date() };
  }
  // LH2: a loss goes through the stage door so it carries a reason (OTHER,
  // "closed at the desk", for a console still sending the status).
  if (patch['status'] === 'LOST') {
    const { status: _lost, ...rest } = patch;
    await moveStage(leadId, 'LOST', 'ADMIN', { actorUserId, reason: 'OTHER', lostNote: 'Closed at the desk' });
    patch = rest;
    if (Object.keys(patch).length === 0) return getLead(leadId);
  }
  // Lot X-B: a patched city carries its key; a patch of other fields leaves the key alone.
  await repository.update(leadId, await withCityKey(patch as { city?: string | null }));
  if (patch['status'] && patch['status'] !== lead.status) {
    await repository.logActivity({
      leadId,
      actorUserId,
      kind: 'STATUS_CHANGED',
      note: `${lead.status} → ${String(patch['status'])}`,
    });
  }
  if ('agentFlaggedHotAt' in patch) {
    await repository.logActivity({ leadId, actorUserId, kind: 'NOTE', note: 'Flagged hot at the desk' });
  }
  // LH1: a category, an importance or a flag moves the score; recomputed either way.
  await recomputeLead(leadId).catch((err) => logger.warn('Lead score not recomputed after a patch', { leadId, err }));
  // LH2: an assignment is a claim in the desk's hand; LH5 (D3): it overrides a running claim.
  if (typeof patch['assignedAgentId'] === 'string') {
    if (lead.claimedByAgentId && lead.claimedByAgentId !== patch['assignedAgentId']) {
      await repository.closeOpenClaims(leadId, new Date(), 'overridden by ops');
      await repository.update(leadId, { claimedByAgentId: null, claimExpiresAt: null });
    }
    await advanceStage(leadId, 'CLAIMED', { actorUserId, note: 'assigned at the desk' });
  }
  return getLead(leadId);
}
