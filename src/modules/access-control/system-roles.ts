import { permissionsOfGroup, permissionsOfTier } from '../../shared/auth';

/**
 * The six roles the console ships with.
 *
 * They are code, not data: `ensureSystemRoles()` upserts them by name at every
 * boot, so a permission added to the catalogue reaches the roles that should
 * hold it without a migration, and an accidental edit in the console is undone
 * on the next restart. An organisation that wants a different set makes its
 * own role — that is what the console's role editor is for.
 *
 * Only **Super admin** is `isSystem`: the row that cannot be deleted, renamed
 * or emptied, and whose last member cannot be moved off it. The other five are
 * ordinary rows seeded for convenience; deleting one (once nobody holds it) is
 * a legitimate thing to do.
 *
 * Each set is built from the catalogue rather than written out, so the three
 * tiers stay nested: a role that may approve also views and edits.
 */

export const SUPER_ADMIN_ROLE = 'Super admin';

/** view + edit + approve on one group. */
const through = (...groups: string[]): string[] => groups.flatMap((group) => permissionsOfGroup(group));

/** view only on the groups named. */
const viewOf = (...groups: string[]): string[] =>
  groups.flatMap((group) => permissionsOfGroup(group).filter((id) => id.endsWith('.view')));

export interface SystemRoleSpec {
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  /** Evaluated at boot so a catalogue change is picked up. Ignored for Super admin, which takes PERMISSIONS. */
  readonly permissions: () => string[];
}

export const SYSTEM_ROLES: readonly SystemRoleSpec[] = [
  {
    name: SUPER_ADMIN_ROLE,
    description: 'Every permission, including impersonation, erasure and role management. Cannot be deleted or emptied.',
    isSystem: true,
    permissions: () => [],
  },
  {
    name: 'Ops manager',
    description: 'Runs the marketplace day to day: supply, demand, orders, support, comms and the work desk. No money, no KYC sign-off, no roles.',
    isSystem: false,
    permissions: () => [
      // Lot AA: the work desk is the ops manager's — tasks, reviews and hours.
      ...through('marketplace', 'supply', 'demand', 'comms', 'support', 'content', 'work'),
      ...viewOf('finance', 'kyc', 'growth', 'settings'),
    ],
  },
  {
    name: 'Finance',
    description: 'Payouts, refunds, wallets and the revenue settings — with sign-off. Reads the rest of the marketplace.',
    isSystem: false,
    permissions: () => [
      ...through('finance'),
      ...viewOf('marketplace', 'supply', 'demand', 'kyc', 'support', 'settings'),
      'system.audit.export',
    ],
  },
  {
    name: 'KYC reviewer',
    description: 'The verification queues for every party, with sign-off. Reads the parties it verifies and nothing else.',
    isSystem: false,
    permissions: () => [...through('kyc'), ...viewOf('supply', 'demand', 'marketplace', 'support')],
  },
  {
    name: 'Support',
    description: 'Tickets, disputes and the person on the phone. Reads the marketplace; edits nothing it is not answering for.',
    isSystem: false,
    permissions: () => [
      ...through('support', 'comms'),
      ...viewOf('marketplace', 'supply', 'demand', 'kyc', 'finance', 'growth'),
    ],
  },
  {
    name: 'Read-only',
    description: 'View on everything and edit on nothing — for auditors, and for a new starter on their first week.',
    isSystem: false,
    permissions: () => permissionsOfTier('view'),
  },
];
