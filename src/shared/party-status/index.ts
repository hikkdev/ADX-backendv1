/**
 * Account lifecycle — one meaning per word (the owner, 2 Oct 2026).
 *
 * "When we suspend or deactivate someone's profile … KYC still shows up in
 * QUEUE." Every desk used to write its own idea of "this party is working"
 * by hand — one checked `User.isActive`, another the BLOCK_NEW scope, a third
 * nothing at all. This is the one place that says it, for every party, in
 * the same five words:
 *
 *   ACTIVE       working: signs in, takes new work
 *   SUSPENDED    temporary and scoped — BLOCK_NEW on the party (or the
 *                agent's status SUSPENDED), or BLOCK_SIGNIN; undone by
 *                Reinstate (the `suspension` module)
 *   DEACTIVATED  off the roster — `User.isActive=false` without a sign-in
 *                suspension behind it, or the row's own switch
 *                (`PrintPartner.isActive`, `Employee.isActive`); undone by
 *                Reactivate
 *   CLOSED       permanent — `User.closedAt`, through the closure case
 *   EXITED       an agent whose engagement ended (`AgentProfile.stage`)
 *
 * Each state comes twice — as a pure check over a row already in hand
 * (`accountStateOf`) and as a Prisma where-fragment per model — and the
 * fragments partition each table exactly as the check does, so a chip count
 * and the pills on the page it filters can never disagree. The fragments are
 * whole where-objects meant to go into an `AND: [...]` list; spreading one
 * into an object that has its own `OR` or `NOT` would overwrite one of them.
 *
 * Shared, not a module: the KYC desks, the rosters, dispatch, the lead
 * router, the live map and the reminder sweeps all read it, and several of
 * them sit underneath one another.
 */
import type { Prisma, SuspensionScope } from '../database';
import { ApiError } from '../errors';
import { upperEnum } from '../validation';

export const ACCOUNT_STATES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSED', 'EXITED'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** The four states every party can be in; agents add EXITED. */
export const PARTY_ACCOUNT_STATES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSED'] as const;
export type PartyAccountState = (typeof PARTY_ACCOUNT_STATES)[number];
export const AGENT_ACCOUNT_STATES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSED', 'EXITED'] as const;

/** `?status=` on the publisher and advertiser rosters; `ALL` is everyone. */
export const rosterStatusSchema = upperEnum([...PARTY_ACCOUNT_STATES, 'ALL'] as const).optional();
export type RosterStatus = PartyAccountState | 'ALL';
/** `?status=` on the agent roster — EXITED is its own value there. */
export const agentRosterStatusSchema = upperEnum([...AGENT_ACCOUNT_STATES, 'ALL'] as const).optional();
export type AgentRosterStatus = AccountState | 'ALL';

/**
 * `?include=inactive` on the five KYC queues: a comma list (or a repeated
 * param), case-insensitive; anything else is ignored rather than refused, the
 * way the queues treat every other unreadable facet.
 */
export function includesInactive(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (entry) =>
      typeof entry === 'string' &&
      entry
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .includes('inactive'),
  );
}

/* ------------------------------------------------------------------ */
/* The pure check                                                      */
/* ------------------------------------------------------------------ */

/** What the check reads off a row — whichever of these the party has. */
export type AccountFacts = {
  /** The account behind the party; null for a party nobody signs in to yet (a desk-held publisher or advertiser). */
  user?: { isActive?: boolean | undefined; closedAt: Date | null } | null;
  suspensionScopes?: readonly SuspensionScope[] | null;
  /** The row's own switch — `PrintPartner.isActive`, `Employee.isActive`. */
  isActive?: boolean | null;
  /** Agents: the ladder stage and the operational switch. */
  stage?: string | null;
  status?: string | null;
  /** A print partner carries no relation to its User; its closure is read separately and passed here. */
  closedAt?: Date | null;
};

/**
 * The state of one party, in precedence order: EXITED, CLOSED, the row's own
 * switch off, an account that cannot sign in (SUSPENDED when a BLOCK_SIGNIN
 * suspension is why, DEACTIVATED otherwise), BLOCK_NEW or an agent's
 * SUSPENDED status, else ACTIVE.
 *
 * A user deactivation suspends the user's profiles with BLOCK_NEW as well —
 * so a deactivated user's publisher reads DEACTIVATED, not SUSPENDED: the
 * sign-in switch is checked before the scope.
 */
export function accountStateOf(facts: AccountFacts): AccountState {
  if (facts.stage === 'EXITED') return 'EXITED';
  if (facts.closedAt || facts.user?.closedAt) return 'CLOSED';
  if (facts.isActive === false) return 'DEACTIVATED';
  const scopes = facts.suspensionScopes ?? [];
  if (facts.user && facts.user.isActive === false) return scopes.includes('BLOCK_SIGNIN') ? 'SUSPENDED' : 'DEACTIVATED';
  if (scopes.includes('BLOCK_NEW') || facts.status === 'SUSPENDED') return 'SUSPENDED';
  return 'ACTIVE';
}

/** Whether the party is a working account — the queues' default and every gate below. */
export const isWorkingAccount = (facts: AccountFacts): boolean => accountStateOf(facts) === 'ACTIVE';

/** User: signs in — `isActive` and never closed. */
export const isWorkingUser = (user: { isActive: boolean; closedAt: Date | null }): boolean => user.isActive && !user.closedAt;

/**
 * An agent who is offered work: a working account, through the ladder
 * (stage ACTIVE) and switched on (status ACTIVE — not away, not suspended).
 */
export const isWorkingAgent = (agent: AccountFacts): boolean =>
  isWorkingAccount(agent) && agent.stage === 'ACTIVE' && agent.status === 'ACTIVE';

/* ------------------------------------------------------------------ */
/* Where-fragments                                                     */
/* ------------------------------------------------------------------ */

/** The account that signs in. */
export const workingUserWhere = (): Prisma.UserWhereInput => ({ isActive: true, closedAt: null });

const NO_BLOCK_NEW = { NOT: { suspensionScopes: { has: 'BLOCK_NEW' as const } } };
const HAS_BLOCK_NEW = { suspensionScopes: { has: 'BLOCK_NEW' as const } };
const HAS_BLOCK_SIGNIN = { suspensionScopes: { has: 'BLOCK_SIGNIN' as const } };
const NO_BLOCK_SIGNIN = { NOT: { suspensionScopes: { has: 'BLOCK_SIGNIN' as const } } };

/**
 * Publisher and advertiser: the account is optional (a party the desk holds
 * for somebody who has not registered), so "the user is fine" is "no user, or
 * a user who signs in". The two models spell these columns identically.
 */
type HeldPartyWhere = Prisma.PublisherWhereInput & Prisma.AdvertiserWhereInput;

function heldPartyStateWhere(state: PartyAccountState): HeldPartyWhere {
  const userOk: HeldPartyWhere = { OR: [{ userId: null }, { user: { is: workingUserWhere() } }] };
  const signedOut = { user: { is: { closedAt: null, isActive: false } } };
  switch (state) {
    case 'CLOSED':
      return { user: { is: { closedAt: { not: null } } } };
    case 'DEACTIVATED':
      return { AND: [signedOut, NO_BLOCK_SIGNIN] };
    case 'SUSPENDED':
      return { OR: [{ AND: [signedOut, HAS_BLOCK_SIGNIN] }, { AND: [userOk, HAS_BLOCK_NEW] }] };
    case 'ACTIVE':
      return { AND: [userOk, NO_BLOCK_NEW] };
  }
}

export const publisherStateWhere = (state: PartyAccountState): Prisma.PublisherWhereInput => heldPartyStateWhere(state);
export const advertiserStateWhere = (state: PartyAccountState): Prisma.AdvertiserWhereInput => heldPartyStateWhere(state);

/** A publisher that is a working account — the KYC queue's default, the reminder sweeps'. */
export const workingPublisherWhere = (): Prisma.PublisherWhereInput => publisherStateWhere('ACTIVE');
export const workingAdvertiserWhere = (): Prisma.AdvertiserWhereInput => advertiserStateWhere('ACTIVE');

/** Agents: the account is required; EXITED comes first, and the agent's own SUSPENDED status counts as suspended. */
export function agentStateWhere(state: AccountState): Prisma.AgentProfileWhereInput {
  const notExited: Prisma.AgentProfileWhereInput = { stage: { not: 'EXITED' } };
  switch (state) {
    case 'EXITED':
      return { stage: 'EXITED' };
    case 'CLOSED':
      return { AND: [notExited, { user: { closedAt: { not: null } } }] };
    case 'DEACTIVATED':
      return { AND: [notExited, { user: { closedAt: null, isActive: false } }, NO_BLOCK_SIGNIN] };
    case 'SUSPENDED':
      return {
        AND: [
          notExited,
          {
            OR: [
              { AND: [{ user: { closedAt: null, isActive: false } }, HAS_BLOCK_SIGNIN] },
              { AND: [{ user: workingUserWhere() }, { OR: [HAS_BLOCK_NEW, { status: 'SUSPENDED' }] }] },
            ],
          },
        ],
      };
    case 'ACTIVE':
      return { AND: [notExited, { user: workingUserWhere() }, NO_BLOCK_NEW, { status: { not: 'SUSPENDED' } }] };
  }
}

/** The account side of an agent who works — the KYC queue's default (with the ladder's dead ends left out there). */
export const workingAgentAccountWhere = (): Prisma.AgentProfileWhereInput => agentStateWhere('ACTIVE');

/** An agent who is offered work: dispatch, lead routing, the live map. */
export const workingAgentWhere = (): Prisma.AgentProfileWhereInput => ({
  AND: [agentStateWhere('ACTIVE'), { stage: 'ACTIVE' }, { status: 'ACTIVE' }],
});

/** The ladder's dead ends — an agent KYC queue leaves them out unless asked for the inactive. */
export const AGENT_DEAD_END_STAGES = ['REJECTED', 'WITHDRAWN', 'EXITED'] as const;

/** Print partner: the row's own switch (it has no relation to its User; closure turns the switch off). */
export const workingPrintPartnerWhere = (): Prisma.PrintPartnerWhereInput => ({ isActive: true });

/** Employee: the row's switch, and an account that signs in. */
export const workingEmployeeWhere = (): Prisma.EmployeeWhereInput => ({ isActive: true, user: workingUserWhere() });

/* ------------------------------------------------------------------ */
/* The door a closed or blocked party does not come through            */
/* ------------------------------------------------------------------ */

/**
 * The desk's "Request KYC" and Digio start: a closed account is never asked
 * (409 ACCOUNT_CLOSED); one suspended from new work is not asked until it is
 * reinstated (409 ACCOUNT_SUSPENDED). Sentences a person reads on the desk.
 */
export function assertOpenForKyc(facts: { closedAt?: Date | null; suspensionScopes?: readonly SuspensionScope[] | null }): void {
  if (facts.closedAt) {
    throw new ApiError(409, 'ACCOUNT_CLOSED', 'This account is closed, so KYC cannot be requested. A closed account stays closed.');
  }
  if (facts.suspensionScopes?.includes('BLOCK_NEW')) {
    throw new ApiError(
      409,
      'ACCOUNT_SUSPENDED',
      'This account is suspended from new work, so KYC cannot be requested until it is reinstated.',
    );
  }
}

/** The 409 every reactivation door answers for a closed account. */
export function assertNotClosed(closedAt: Date | null | undefined): void {
  if (closedAt) {
    throw new ApiError(409, 'ACCOUNT_CLOSED', 'This account is closed and cannot be reactivated. A closed account stays closed.');
  }
}

export { accountClosedAt, findAccountFacts } from './account-facts';
