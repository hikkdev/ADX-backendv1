import type { Lead, LeadProposal } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { notify } from '../notifications';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import { isOpenStage, type LeadStageValue } from './stages.rules';
import { markProposed, stampMoment } from './stages.service';
import { touchLead } from './scoring.service';

/**
 * LH7: proposals — the three kinds the agent sends and the landing shows.
 *
 * A RATE_ESTIMATE is a publisher's: what spaces like theirs earn, from the
 * live comparables within the radius (a figure the agent may override). A
 * CAMPAIGN_ESTIMATE is an advertiser's: spots × days at the median rate
 * nearby. A PACKAGE_QUOTE is the catalogue's own quote (`packages.quote`,
 * no term — the prospect has no account yet). Sending one moves the lead
 * to PROPOSED (LH2); the landing marks it opened when it shows it and
 * accepted when the person taps Accept, which engages the lead through
 * the link and tells the holder.
 */

/**
 * The catalogue's doors — `packages.quote` and `packages.listCatalogue` —
 * handed in by bootstrap: `packages` sits over advertisers, agreements and
 * revenue, and `leads` must not pull that chain in.
 */
export type PackageQuotePort = (input: { tier: string; addOnCodes: string[]; cycle: 'MONTHLY' | 'ANNUAL'; advertiserId: null }) => Promise<{ plan: { tier: string; name: string; pricePerMonth: string }; priced: { months: number; perMonth: string; total: string }; addOns: { code: string; name: string; pricePerMonth: string }[] }>;
export type CataloguePort = () => Promise<{ packages: { tier: string; name: string; pricePerMonth: string; description: string | null; isPopular: boolean }[] }>;
let quotePort: PackageQuotePort | null = null;
let cataloguePort: CataloguePort | null = null;
export function registerPackagePorts(ports: { quote: PackageQuotePort; catalogue: CataloguePort }): void {
  quotePort = ports.quote;
  cataloguePort = ports.catalogue;
}
export async function catalogueForLanding(): ReturnType<CataloguePort> {
  if (!cataloguePort) return { packages: [] };
  return cataloguePort();
}

export const PROPOSAL_KINDS = ['RATE_ESTIMATE', 'CAMPAIGN_ESTIMATE', 'PACKAGE_QUOTE'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

const RATE_RADIUS_M = 200;
const RATE_RADIUS_WIDE_M = 2000;

export type RateEstimatePayload = { perDay: string; perMonth: string; comparables: number; radiusM: number; overridden: boolean };
export type CampaignEstimatePayload = { spots: number; days: number; perSpotPerDay: string; amount: string; comparables: number; radiusM: number; overridden: boolean };
export type PackageQuotePayload = { tier: string; name: string; cycle: 'MONTHLY' | 'ANNUAL'; months: number; perMonth: string; total: string; addOns: { code: string; name: string; pricePerMonth: string }[] };

export type ProposalInput =
  | { kind: 'RATE_ESTIMATE'; perDay?: string | undefined; note?: string | undefined }
  | { kind: 'CAMPAIGN_ESTIMATE'; spots?: number | undefined; days?: number | undefined; perSpotPerDay?: string | undefined; note?: string | undefined }
  | { kind: 'PACKAGE_QUOTE'; tier: string; addOnCodes?: string[] | undefined; cycle?: 'MONTHLY' | 'ANNUAL' | undefined; note?: string | undefined };

export type ProposalView = {
  id: string;
  kind: ProposalKind;
  payload: RateEstimatePayload | CampaignEstimatePayload | PackageQuotePayload;
  note: string | null;
  sentAt: string;
  openedAt: string | null;
  acceptedAt: string | null;
};

export const proposalView = (row: LeadProposal): ProposalView => ({
  id: row.id,
  kind: row.kind,
  payload: row.payload as ProposalView['payload'],
  note: row.note,
  sentAt: row.sentAt.toISOString(),
  openedAt: row.openedAt?.toISOString() ?? null,
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
});

/** The comparables' median within the radius, widening once when the street is empty. */
async function medianNear(lead: Lead): Promise<{ rate: string | null; comparables: number; radiusM: number }> {
  if (lead.latitude === null || lead.longitude === null) return { rate: null, comparables: 0, radiusM: RATE_RADIUS_M };
  const point = { latitude: lead.latitude, longitude: lead.longitude };
  for (const radiusM of [RATE_RADIUS_M, RATE_RADIUS_WIDE_M]) {
    const [rate, comparables] = await Promise.all([leads.medianLiveRateNear(point, radiusM).catch(() => null), leads.countLiveListingsNear(point, radiusM).catch(() => 0)]);
    if (rate !== null) return { rate, comparables, radiusM };
  }
  return { rate: null, comparables: 0, radiusM: RATE_RADIUS_WIDE_M };
}

const isMoney = (value: unknown): value is string => typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0;

/** A publisher's rate estimate: the comparables' figure, or the agent's own. */
export async function rateEstimateFor(lead: Lead, perDay?: string): Promise<RateEstimatePayload> {
  const near = await medianNear(lead);
  const rate = perDay && isMoney(perDay) ? perDay : near.rate;
  if (!rate) throw new ApiError(409, 'CONFLICT', 'No live listing nearby to price against — give the rate yourself', { reason: 'NO_COMPARABLES' });
  return { perDay: money(Number(rate)), perMonth: money(Number(rate) * 30), comparables: near.comparables, radiusM: near.radiusM, overridden: Boolean(perDay && isMoney(perDay)) };
}

/** An advertiser's campaign estimate: spots × days at the nearby median (or the agent's rate). */
export async function campaignEstimateFor(lead: Lead, input: { spots?: number | undefined; days?: number | undefined; perSpotPerDay?: string | undefined }): Promise<CampaignEstimatePayload> {
  const spots = Math.max(1, Math.min(200, Math.round(input.spots ?? 3)));
  const days = Math.max(1, Math.min(365, Math.round(input.days ?? 30)));
  const near = await medianNear(lead);
  const rate = input.perSpotPerDay && isMoney(input.perSpotPerDay) ? input.perSpotPerDay : near.rate;
  if (!rate) throw new ApiError(409, 'CONFLICT', 'No live listing nearby to price against — give the per-spot rate yourself', { reason: 'NO_COMPARABLES' });
  return { spots, days, perSpotPerDay: money(Number(rate)), amount: money(Number(rate) * spots * days), comparables: near.comparables, radiusM: near.radiusM, overridden: Boolean(input.perSpotPerDay && isMoney(input.perSpotPerDay)) };
}

/** A package quote off the catalogue, no term (the prospect has no account). */
export async function packageQuoteFor(input: { tier: string; addOnCodes?: string[] | undefined; cycle?: 'MONTHLY' | 'ANNUAL' | undefined }): Promise<PackageQuotePayload> {
  if (!quotePort) throw new ApiError(503, 'NOT_IMPLEMENTED', 'Package quotes are not wired on this server');
  const quoted = await quotePort({ tier: input.tier, addOnCodes: input.addOnCodes ?? [], cycle: input.cycle ?? 'MONTHLY', advertiserId: null });
  return {
    tier: quoted.plan.tier,
    name: quoted.plan.name,
    cycle: input.cycle ?? 'MONTHLY',
    months: quoted.priced.months,
    perMonth: money(Number(quoted.priced.perMonth)),
    total: money(Number(quoted.priced.total)),
    addOns: quoted.addOns.map((a) => ({ code: a.code, name: a.name, pricePerMonth: money(Number(a.pricePerMonth)) })),
  };
}

/** `POST /leads/:id/proposals` — compute, record, PROPOSED. */
export async function sendProposal(leadId: string, actorUserId: string | null, input: ProposalInput, now = new Date()): Promise<ProposalView> {
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenStage(lead.stage as LeadStageValue)) throw new ApiError(409, 'CONFLICT', 'This lead is closed');
  let payload: ProposalView['payload'];
  if (input.kind === 'RATE_ESTIMATE') {
    if (lead.side !== 'PUBLISHER') throw new ApiError(400, 'VALIDATION_ERROR', 'A rate estimate is for a publisher-side lead');
    payload = await rateEstimateFor(lead, input.perDay);
  } else if (input.kind === 'CAMPAIGN_ESTIMATE') {
    if (lead.side !== 'ADVERTISER') throw new ApiError(400, 'VALIDATION_ERROR', 'A campaign estimate is for an advertiser-side lead');
    payload = await campaignEstimateFor(lead, input);
  } else {
    if (lead.side !== 'ADVERTISER') throw new ApiError(400, 'VALIDATION_ERROR', 'A package quote is for an advertiser-side lead');
    payload = await packageQuoteFor(input);
  }
  const row = await repository.createProposal({ leadId, kind: input.kind, payload, note: input.note?.trim() || null, createdByUserId: actorUserId, sentAt: now });
  const line = summaryLine(row.kind, payload);
  await markProposed(leadId, actorUserId, line).catch((err) => logger.warn('Proposal stage not moved', { leadId, err }));
  return proposalView(row);
}

/** "Rate estimate · ₹450/day (₹13,500/month)" — the activity line and the app's row. */
export function summaryLine(kind: ProposalKind, payload: ProposalView['payload']): string {
  if (kind === 'RATE_ESTIMATE') {
    const p = payload as RateEstimatePayload;
    return `Rate estimate · ₹${p.perDay}/day (₹${p.perMonth}/month)`;
  }
  if (kind === 'CAMPAIGN_ESTIMATE') {
    const p = payload as CampaignEstimatePayload;
    return `Campaign estimate · ${p.spots} spots × ${p.days} days = ₹${p.amount}`;
  }
  const p = payload as PackageQuotePayload;
  return `Package quote · ${p.name} (${p.cycle.toLowerCase()}) = ₹${p.total}`;
}

export async function listProposalsFor(leadId: string): Promise<ProposalView[]> {
  return (await repository.listProposals(leadId)).map(proposalView);
}

/** The landing's Accept: the moment stamped, the lead engaged through the link, the holder told. */
export async function acceptProposal(leadId: string, proposalId: string, now = new Date()): Promise<ProposalView> {
  const row = await repository.findProposal(proposalId);
  if (!row || row.leadId !== leadId) throw new ApiError(404, 'NOT_FOUND', 'No such proposal');
  if (row.acceptedAt) return proposalView(row);
  const updated = await repository.updateProposal(row.id, { acceptedAt: now, ...(row.openedAt ? {} : { openedAt: now }) });
  const lead = await leads.findById(leadId);
  if (lead) {
    await leads.logActivity({ leadId, actorUserId: null, kind: 'ENGAGED', note: `Accepted on the invite page: ${summaryLine(row.kind, row.payload as ProposalView['payload'])}` });
    await stampMoment(leadId, 'engaged', 'LINK', now);
    await touchLead(leadId, now).catch(() => undefined);
    const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
    const agent = holder ? await repository.findAgentUser(holder) : null;
    if (agent) {
      await notify(
        'LEAD_PROPOSAL_ACCEPTED',
        agent.userId,
        { businessName: lead.businessName, proposal: summaryLine(row.kind, row.payload as ProposalView['payload']), deepLink: `adx://lead/${lead.id}` },
        { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: `${lead.businessName} accepted`, subtitle: summaryLine(row.kind, row.payload as ProposalView['payload']), message: 'Time to close it.', relatedType: 'LEAD', relatedId: lead.id } },
      ).catch((err) => logger.warn('Proposal-accepted push not sent', { leadId, err }));
    }
  }
  return proposalView(updated);
}
