import { findAgentProfile, listActiveAgentsForDirectory } from '../agents';
import { findEmployeeByUserId, listActiveEmployeesForDirectory } from '../employees';
import type { PeopleQuery, PersonKind } from './hr.schema';

/**
 * The people registry — Lot E (Q99): everyone the diary can put a thing
 * against, in one list. Staff come from `employees` (active records) and
 * agents from `agents` (ACTIVE profiles who can sign in), each through the
 * module's own index; this module owns no table for it and keeps no copy.
 */
/** G11-1: `employeeId` is the Employee row's id, beside the login. */
export type StaffPerson = { userId: string; employeeId: string; name: string | null; kind: 'STAFF'; designation: string | null; department: string | null; active: boolean };
export type AgentPerson = { userId: string; name: string | null; kind: 'AGENT'; tier: string; agentProfileId: string; active: boolean };
export type Person = StaffPerson | AgentPerson;

const byName = (a: Person, b: Person): number => (a.name ?? '').localeCompare(b.name ?? '');

export async function listPeople(query: Omit<PeopleQuery, 'includeInactive'> & { includeInactive?: boolean }): Promise<Person[]> {
  // The registry lists the active; an explicit `active=false` has nothing to say.
  if (query.active === false) return [];
  const wantStaff = query.kind === undefined || query.kind === 'STAFF';
  const wantAgents = query.kind === undefined || query.kind === 'AGENT';
  // E10-1: the people who have left ride along only when asked, each flagged.
  const opts = { includeInactive: query.includeInactive === true };

  const [staff, agents] = await Promise.all([
    wantStaff ? listActiveEmployeesForDirectory(query.q, opts) : Promise.resolve([]),
    wantAgents ? listActiveAgentsForDirectory(query.q, opts) : Promise.resolve([]),
  ]);

  const rows: Person[] = [
    ...staff.map<StaffPerson>((s) => ({ userId: s.userId, employeeId: s.employeeId, name: s.name, kind: 'STAFF', designation: s.designation, department: s.department, active: s.active })),
    ...agents.map<AgentPerson>((a) => ({ userId: a.userId, name: a.name, kind: 'AGENT', tier: a.tier, agentProfileId: a.agentProfileId, active: a.active })),
  ];
  // A person who is both — a staffer with an agent profile — appears once, as staff.
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.userId) ? false : (seen.add(row.userId), true))).sort(byName);
}

/** One person by user id — staff first, then agent — or null if they are neither, or no longer active. */
export async function findPerson(userId: string): Promise<{ userId: string; kind: PersonKind; agentProfileId: string | null } | null> {
  const employee = await findEmployeeByUserId(userId);
  if (employee?.isActive) {
    // The diary overlays field work when the staffer is also an agent.
    const agent = await findAgentProfile(userId);
    return { userId, kind: 'STAFF', agentProfileId: agent?.id ?? null };
  }
  const agent = await findAgentProfile(userId);
  if (agent && agent.status === 'ACTIVE') return { userId, kind: 'AGENT', agentProfileId: agent.id };
  return null;
}
