/**
 * AG-5 (the owner, 20 Sep 2026): "more educated and skilled ones can be used
 * to deal with more important clients or publishers."
 *
 * The desk-set GRADE (G1 Field … G4 Enterprise) is the routing axis. An
 * account's importance is the band ops already set on it — a publisher's
 * `sizeBand`, and since AG-5 an advertiser's — and a lead's `importance`.
 * The routing settings map each band to the grade it wants; dispatch offers
 * work to agents at or above that grade, the closest fit first, then the
 * higher tier, then the nearer agent. The desk may always assign by hand
 * over the band (logged as an override).
 *
 * Pure: the settings come in, nothing is read here.
 */

export type AgentGradeCode = 'G1' | 'G2' | 'G3' | 'G4';
export type PartyBand = 'INDIVIDUAL' | 'SMALL_AGENCY' | 'LARGE_AGENCY';
export type LeadBand = 'STANDARD' | 'KEY' | 'ENTERPRISE';

export const GRADE_RANK: Record<AgentGradeCode, number> = { G1: 1, G2: 2, G3: 3, G4: 4 };
export const AGENT_GRADE_CODES: AgentGradeCode[] = ['G1', 'G2', 'G3', 'G4'];

export type RoutingSettings = {
  /** The grade an account of each band is routed to. */
  bands: Record<PartyBand, AgentGradeCode>;
  /** The grade a lead of each importance is routed to. */
  leadBands: Record<LeadBand, AgentGradeCode>;
  /** Off: the band is advice — dispatch prefers the grade but offers to anyone. On: agents below the grade are not offered the work. */
  enforce: boolean;
};

export const ROUTING_CONFIG_KEY = 'agent-routing';

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  bands: { INDIVIDUAL: 'G1', SMALL_AGENCY: 'G2', LARGE_AGENCY: 'G3' },
  leadBands: { STANDARD: 'G1', KEY: 'G3', ENTERPRISE: 'G4' },
  enforce: true,
};

const isGrade = (value: unknown): value is AgentGradeCode => typeof value === 'string' && value in GRADE_RANK;

/** The stored object, with the defaults filling anything missing or malformed. */
export function routingSettingsFrom(raw: Record<string, unknown> | null | undefined): RoutingSettings {
  const bands = { ...DEFAULT_ROUTING_SETTINGS.bands };
  const leadBands = { ...DEFAULT_ROUTING_SETTINGS.leadBands };
  const rawBands = (raw?.['bands'] ?? {}) as Record<string, unknown>;
  const rawLeads = (raw?.['leadBands'] ?? {}) as Record<string, unknown>;
  for (const band of Object.keys(bands) as PartyBand[]) if (isGrade(rawBands[band])) bands[band] = rawBands[band];
  for (const band of Object.keys(leadBands) as LeadBand[]) if (isGrade(rawLeads[band])) leadBands[band] = rawLeads[band];
  return { bands, leadBands, enforce: typeof raw?.['enforce'] === 'boolean' ? raw['enforce'] : DEFAULT_ROUTING_SETTINGS.enforce };
}

export function requiredGradeForBand(band: PartyBand | string | null | undefined, settings: RoutingSettings = DEFAULT_ROUTING_SETTINGS): AgentGradeCode {
  return (band && settings.bands[band as PartyBand]) || 'G1';
}

export function requiredGradeForLead(importance: LeadBand | string | null | undefined, settings: RoutingSettings = DEFAULT_ROUTING_SETTINGS): AgentGradeCode {
  return (importance && settings.leadBands[importance as LeadBand]) || 'G1';
}

/** An agent from before the grade existed reads as G1: they were doing everyday work already. */
export function gradeRank(grade: string | null | undefined): number {
  return isGrade(grade) ? GRADE_RANK[grade] : 1;
}

export function meetsGrade(agentGrade: string | null | undefined, required: AgentGradeCode): boolean {
  return gradeRank(agentGrade) >= GRADE_RANK[required];
}

const TIER_RANK: Record<string, number> = { BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 };
const LEVEL_RANK: Record<string, number> = { I: 1, II: 2, III: 3 };

/** BRONZE I → 11, PLATINUM III → 43: the tier then the level, higher is better. */
export function tierRank(tier: string | null | undefined, level: string | null | undefined): number {
  const t = tier ? (TIER_RANK[tier.toUpperCase()] ?? 0) : 0;
  const l = level ? (LEVEL_RANK[level.toUpperCase()] ?? 0) : 0;
  return t * 10 + l;
}

const EARTH_KM = 6371;

/** Great-circle distance, or null when either side has no fix. */
export function distanceKm(a: { latitude: number | null; longitude: number | null } | null | undefined, b: { latitude: number | null; longitude: number | null } | null | undefined): number | null {
  if (!a || !b || a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) return null;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
