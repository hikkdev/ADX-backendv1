import { ApiError } from '../../shared/errors';
import type { AgentProfile } from '../../shared/database';
import { prismaAgentsRepository as repository } from './prisma-agents.repository';
import type { AgentFilter, AgentProfilePatch, AgentRole, AgentZone, NewAgent } from './agents.repository';
import type { AgentPreferencesInput, CreateAgentInput, UpdateAgentInput } from './agents.schema';
import { allocateIdentifier } from '../identifiers';
import { kycSummaryOf } from '../../shared/kyc-state';
import { normalizeMobile } from '../auth';
import { assertCityAllows, cityKeyFor, withCityKey } from '../pricing';

export async function listAgents(filter: AgentFilter, limit: number, offset: number) {
  // Lot X-B: `?city=` is a slug (or a name, for the console's older links) — matched by key, the spelling as the fallback.
  const keyed = filter.city ? { ...filter, cityId: (await cityKeyFor(filter.city))?.cityId ?? null } : filter;
  const { items, total } = await repository.findPage(keyed, limit, offset);
  // Note the meta shape here is { total, limit, offset } — not the
  // { page, pageSize, total, totalPages } used by the paginated admin listings.
  return { items, meta: { total, limit, offset } };
}

/**
 * How an agent comes to exist.
 *
 * There is no self-signup for agents: ops creates them here, in person, and
 * the person then signs in with the number typed at this desk. Three cases.
 * A new number gets a user, a role and a profile in one write. A number that
 * already belongs to somebody — a publisher becoming an agent as well —
 * gains the role and a profile. A number that is already an agent is
 * refused rather than duplicated: `AgentProfile.userId` is unique, and a
 * second profile would be a second earnings ledger for one person.
 *
 * The identifier is allocated last, only once the write is certain:
 * `AGT-1009-2601` comes off an atomic daily sequence and is never reissued,
 * so allocating before a 409 would burn a number for nothing.
 */
export async function createAgent(input: CreateAgentInput) {
  const mobile = normalizeMobile(input.mobile);
  const role: AgentRole = input.side === 'PUBLISHER' ? 'AGENT_PUBLISHER' : 'AGENT_ADVERTISER';

  const existing = await repository.findUserByMobile(mobile);
  if (existing?.agentProfileId) {
    throw new ApiError(409, 'CONFLICT', 'An agent with this mobile already exists');
  }
  if (input.email && (await repository.emailTaken(input.email, existing?.id ?? null))) {
    throw new ApiError(409, 'CONFLICT', 'That email belongs to another account');
  }
  // Lot V: agents are onboarded where the city's rollout stage says so
  // (SEEDING and LAUNCHED); a city outside the catalogue is free text.
  await assertCityAllows(input.city, 'agentOnboarding');

  const displayId = await allocateIdentifier('AGENT');
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const record: NewAgent = await withCityKey({
    mobile,
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    role,
    ...(input.city ? { city: input.city } : {}),
    ...(input.state ? { state: input.state } : {}),
    displayId,
  });
  const profile = existing
    ? await repository.attachAgent(existing.id, record)
    : await repository.createAgent(record);

  return getAgentById(profile.id);
}

export async function getAgentById(id: string) {
  const agent = await repository.findById(id);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  return agent;
}

/**
 * GET /agents/:id — the profile with its four counters (Lot B, Q100).
 *
 * Onboardings, package sales and campaign launches sit beside the record for
 * the console's agent page. They are counts of what attribution records and
 * nothing more: the rating (`rating/`) and the ladder (`tier/`) do not read
 * them, and this is the only place they are assembled.
 */
export async function getAgentDetail(id: string) {
  const agent = await getAgentById(id);
  const [onboarded, sales] = await Promise.all([
    repository.countOnboarded(id).catch(() => ({ publishers: 0, advertisers: 0 })),
    repository.countSales(id).catch(() => ({ packagesSold: 0, campaignsLaunched: 0 })),
  ]);
  return {
    ...agent,
    // N3-B: `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }`, derived the way the
    // agent KYC queue derives it — AWAITING_DOCUMENTS from the moment the profile exists.
    kyc: kycSummaryOf(agent.kyc ?? null),
    counters: {
      publishersOnboarded: onboarded.publishers,
      advertisersOnboarded: onboarded.advertisers,
      packagesSold: sales.packagesSold,
      campaignsLaunched: sales.campaignsLaunched,
    },
  };
}

/**
 * The tier an agent holds right now, or null for a profile that does not
 * exist. Read by the modules that record an incentive — an onboarding, an
 * installation, a campaign assist — at the tier in force when it was earned.
 */
export async function findAgentTier(agentId: string): Promise<string | null> {
  const agent = await repository.findById(agentId);
  return agent?.tier ?? null;
}

/**
 * Resolves the calling user's agent profile, or throws 404.
 *
 * This replaces a `findUnique({ where: { userId } })` + 404 pair that was
 * copy-pasted into twelve handlers across five modules. Exported from the
 * module index so `orders`, `order-milestones`, `earnings` and `publishers`
 * share one definition and one error message.
 */
export async function requireAgentProfile(userId: string): Promise<AgentProfile> {
  const agent = await repository.findByUserId(userId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return agent;
}

/** Same lookup without the throw, for callers that treat absence as normal. */
export async function findAgentProfile(userId: string): Promise<AgentProfile | null> {
  return repository.findByUserId(userId);
}

/**
 * E7-3: `{ id, userId, displayId, name, kycStatus }` per login that has an
 * agent profile, in one query — for the support and dispute desks, composed
 * into their ports by bootstrap.
 */
export const findAgentLabelsForUsers = (userIds: readonly string[]) =>
  repository.findLabelsByUserIds([...new Set(userIds)]);

/** K-B1: `{ id, label, displayId }` per agent id, one query — the QR desk's ref column. */
export const findAgentLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

/**
 * Directory lookups the `orders` module needs for assignment and notification,
 * so it never queries AgentProfile itself.
 */
export async function getAgentWithUser(agentId: string) {
  return repository.findWithUser(agentId);
}

/** Whether an agent profile id exists — used before assigning work to it. */
export async function agentExists(agentId: string): Promise<boolean> {
  return repository.exists(agentId);
}

export async function findAssignableAgent(excludeIds: string[]) {
  return repository.findAssignable(excludeIds);
}

/**
 * Lot A BLOCK_NEW, asked once and answered the same way everywhere.
 *
 * An agent is offered new work only while their profile is ACTIVE and
 * BLOCK_NEW is not on them. The two move together — suspending sets the status
 * as well — and both are checked so a hand-edited status cannot let work
 * through a suspension.
 *
 * False for an agent that does not exist: a dispatch to nobody is not work
 * being offered.
 */
export async function agentAcceptsWork(agentId: string): Promise<boolean> {
  const state = await repository.findWorkState(agentId);
  if (!state) return false;
  return state.status === 'ACTIVE' && !state.scopes.includes('BLOCK_NEW');
}

/** The same answer, as the refusal every dispatch point raises. */
export async function assertAgentAcceptsWork(agentId: string): Promise<void> {
  if (!(await agentAcceptsWork(agentId))) {
    throw new ApiError(409, 'AGENT_SUSPENDED', 'That agent is not being offered work at the moment');
  }
}

/** For the order lane's auto-accept: the agent's switch and zone, or null for no such agent. */
export async function getAgentZone(agentId: string): Promise<AgentZone | null> {
  return repository.findZone(agentId);
}

/* ── Lot E (Q99): the people registry ─────────────────────────────────── */

export type AgentDirectoryEntry = {
  userId: string;
  agentProfileId: string;
  name: string | null;
  /** "GOLD II" — the rung, as the registry prints it beside a designation. */
  tier: string;
  city: string | null;
  /** E10-1: false only when `includeInactive` was asked for. */
  active: boolean;
};

/** ACTIVE agents who can sign in, by name — `hr` unions this with the active staff. */
export async function listActiveAgentsForDirectory(q?: string, opts: { includeInactive?: boolean } = {}): Promise<AgentDirectoryEntry[]> {
  const rows = await repository.findDirectory(q, opts.includeInactive ?? false);
  return rows.map((row) => ({
    userId: row.userId,
    agentProfileId: row.id,
    name: row.user.name,
    tier: `${row.tier} ${row.tierLevel}`,
    city: row.city,
    // E10-1: an agent is active when the profile is ACTIVE and the account can sign in.
    active: row.status === 'ACTIVE' && row.user.isActive,
  }));
}

/* ── D5: status, territory and work preferences ────────────────────────── */

/**
 * Ops changing the profile from the console: the territory, the business the
 * agent works under, where they are based, the DR 07 preferences, and whether
 * they are offered work at all. A key left out is left alone.
 */
export async function updateAgent(id: string, patch: UpdateAgentInput) {
  if (!(await repository.findById(id))) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  // Lot X-B: a patched city carries its key; a patch of other fields leaves the key alone.
  await repository.update(id, await withCityKey(patch as AgentProfilePatch));
  return getAgentById(id);
}

/** The DR 07 "Work preferences" screen, as the profile holds it. */
export type AgentPreferences = {
  homeZone: string | null;
  radiusKm: number | null;
  workingDays: string[];
  hoursFrom: string | null;
  hoursTo: string | null;
  autoAcceptInZone: boolean;
  orderTypes: string[];
  maxActiveOrders: number | null;
};

const preferencesOf = (profile: AgentProfile): AgentPreferences => ({
  homeZone: profile.homeZone,
  radiusKm: profile.radiusKm,
  workingDays: profile.workingDays,
  hoursFrom: profile.hoursFrom,
  hoursTo: profile.hoursTo,
  autoAcceptInZone: profile.autoAcceptInZone,
  orderTypes: profile.orderTypes,
  maxActiveOrders: profile.maxActiveOrders,
});

/** The agent's own preferences — the subset they may set about themselves. */
export async function getMyPreferences(userId: string): Promise<AgentPreferences> {
  return preferencesOf(await requireAgentProfile(userId));
}

export async function updateMyPreferences(userId: string, patch: AgentPreferencesInput): Promise<AgentPreferences> {
  const profile = await requireAgentProfile(userId);
  return preferencesOf(await repository.update(profile.id, patch as AgentProfilePatch));
}
