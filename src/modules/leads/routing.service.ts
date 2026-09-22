import { logger } from '../../shared/logging';
import { getPlatformSettings } from '../app-config';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { distanceM } from './prisma-leads.repository';
import { advanceStage } from './stages.service';

/**
 * LH3 (with D3's caps): where a new lead goes.
 *
 * The nearest active agent of the lead's side with room under their
 * tier's cap takes it — CLAIMED, with the desk's note — else it stays in
 * the pool for the map. "Nearest" is the agent's last live fix (LT-1)
 * when one is on file today, else the same catalogue city; an agent with
 * neither is not near anything. LH5's territories route ahead of this
 * (a territory's agent wins) through `registerTerritoryRouter`.
 */

export type TerritoryRouter = (lead: { id: string; side: string; latitude: number | null; longitude: number | null }) => Promise<{ agentId: string; territoryId: string } | string | null>;
let territoryRouter: TerritoryRouter | null = null;
export function registerTerritoryRouter(router: TerritoryRouter): void {
  territoryRouter = router;
}

/** A position source for an agent — LT-1's last fix, filled by bootstrap so `leads` stays below `agent-locations`. */
export type AgentPositionPort = { lastFix(agentId: string): Promise<{ latitude: number; longitude: number; at: Date } | null> };
let positionPort: AgentPositionPort | null = null;
export function registerAgentPositionPort(port: AgentPositionPort): void {
  positionPort = port;
}

export type ClaimCaps = { BRONZE: number | null; SILVER: number | null; GOLD: number | null; PLATINUM: number | null };

export async function claimCaps(): Promise<ClaimCaps> {
  return (await getPlatformSettings()).leads.claims.caps;
}

/** How many more leads an agent of this tier may hold; Infinity for an uncapped tier. */
export function roomFor(tier: string, open: number, caps: ClaimCaps): number {
  const cap = caps[tier as keyof ClaimCaps];
  if (cap === null || cap === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, cap - open);
}

export async function routeLead(leadId: string, now = new Date()): Promise<{ agentId: string | null; how: 'TERRITORY' | 'NEAREST' | 'CITY' | 'POOL' | 'ALREADY' }> {
  const lead = await repository.findById(leadId);
  if (!lead) return { agentId: null, how: 'POOL' };
  if (lead.assignedAgentId) return { agentId: lead.assignedAgentId, how: 'ALREADY' };

  if (territoryRouter) {
    const owner = await territoryRouter({ id: lead.id, side: lead.side, latitude: lead.latitude, longitude: lead.longitude }).catch(() => null);
    if (owner) {
      const agentId = typeof owner === 'string' ? owner : owner.agentId;
      if (typeof owner !== 'string') await repository.update(leadId, { territoryId: owner.territoryId });
      await assign(leadId, agentId, 'routed by territory');
      return { agentId, how: 'TERRITORY' };
    }
  }

  const caps = await claimCaps();
  const candidates = await repository.candidateAgents(lead.side, lead.cityId);
  const withRoom = candidates.filter((agent) => roomFor(agent.tier, agent.openLeads, caps) > 0);
  if (withRoom.length === 0) return { agentId: null, how: 'POOL' };

  const point = lead.latitude !== null && lead.longitude !== null ? { latitude: lead.latitude, longitude: lead.longitude } : null;
  if (point && positionPort) {
    const today = now.getTime() - 24 * 60 * 60 * 1000;
    let best: { agentId: string; metres: number } | null = null;
    for (const agent of withRoom) {
      const fix = await positionPort.lastFix(agent.id).catch(() => null);
      if (!fix || fix.at.getTime() < today) continue;
      const metres = distanceM(point, fix) ?? Number.POSITIVE_INFINITY;
      if (!best || metres < best.metres) best = { agentId: agent.id, metres };
    }
    if (best) {
      await assign(leadId, best.agentId, `routed to the nearest agent (${Math.round(best.metres / 100) / 10} km)`);
      return { agentId: best.agentId, how: 'NEAREST' };
    }
  }

  // Same city: the one with the fewest open leads, so the work spreads.
  const inCity = withRoom.filter((agent) => lead.cityId && agent.cityId === lead.cityId);
  const pick = (inCity.length ? inCity : []).sort((a, b) => a.openLeads - b.openLeads)[0];
  if (!pick) return { agentId: null, how: 'POOL' };
  await assign(leadId, pick.id, 'routed within the city');
  return { agentId: pick.id, how: 'CITY' };
}

async function assign(leadId: string, agentId: string, note: string): Promise<void> {
  await repository.update(leadId, { assignedAgentId: agentId });
  await advanceStage(leadId, 'CLAIMED', { actorUserId: null, note }).catch((err) => logger.warn('Routed lead not staged', { leadId, err }));
}
