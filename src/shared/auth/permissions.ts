/**
 * The permission catalogue — Lot A, console access.
 *
 * Generated from one table so an id can only exist here. A `RoleConfig` row
 * stores a list of these ids; `requirePermission()` checks a token against
 * them; the console renders the matrix from `PERMISSION_GROUPS`. Adding a
 * permission means adding a row or a capability below — nothing else, and
 * `tests/contract/permission-catalogue.test.ts` fails on any id referenced in
 * `src/` that is not produced by this file.
 *
 * Ids are `<group>.<tier>` — `finance.view`, `kyc.edit`, `supply.approve` —
 * plus a handful of named capabilities, `<group>.<name>`, for the things a
 * tier does not describe: impersonating a party, exporting the audit trail,
 * seeing a salary.
 *
 * The tiers nest by convention, not by code: a role that may approve is
 * given `view` and `edit` as well. The seeded roles do that; the console
 * matrix should too. `requirePermission('finance.approve')` checks exactly
 * that id, so a role holding `approve` without `view` is a misconfiguration
 * the console prevents rather than one this file papers over.
 */

export const PERMISSION_TIERS = ['view', 'edit', 'approve'] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

interface CapabilitySpec {
  /** The part after the group: `impersonate` → `system.impersonate`. */
  readonly key: string;
  readonly label: string;
}

interface ModuleGroupSpec {
  readonly id: string;
  readonly label: string;
  /** Which of view / edit / approve this group has. `approve` only where the group owns an approval step. */
  readonly tiers: readonly PermissionTier[];
  readonly capabilities: readonly CapabilitySpec[];
}

const VIEW_EDIT = ['view', 'edit'] as const;
const VIEW_EDIT_APPROVE = ['view', 'edit', 'approve'] as const;

/**
 * The console's sections, in the order the matrix draws them. `approve`
 * exists only where there is a queue somebody signs off: payouts and refunds
 * (finance), party verification (kyc), listing verification and claims
 * (supply), and moderation (content).
 */
export const MODULE_GROUPS: readonly ModuleGroupSpec[] = [
  { id: 'marketplace', label: 'Marketplace', tiers: VIEW_EDIT, capabilities: [] },
  { id: 'supply', label: 'Supply', tiers: VIEW_EDIT_APPROVE, capabilities: [] },
  { id: 'demand', label: 'Demand', tiers: VIEW_EDIT, capabilities: [] },
  { id: 'kyc', label: 'KYC', tiers: VIEW_EDIT_APPROVE, capabilities: [] },
  { id: 'finance', label: 'Finance', tiers: VIEW_EDIT_APPROVE, capabilities: [] },
  { id: 'content', label: 'Content', tiers: VIEW_EDIT_APPROVE, capabilities: [] },
  { id: 'comms', label: 'Communications', tiers: VIEW_EDIT, capabilities: [] },
  { id: 'support', label: 'Support', tiers: VIEW_EDIT, capabilities: [] },
  { id: 'growth', label: 'Growth', tiers: VIEW_EDIT, capabilities: [] },
  {
    id: 'hr',
    label: 'People',
    tiers: VIEW_EDIT,
    capabilities: [
      { key: 'salary.view', label: 'See salary figures' },
      { key: 'documents.view', label: 'Open employee documents' },
    ],
  },
  // Lot AA (Q70): the work desk. `approve` is signing off a review as an
  // approver and approving hours — a reviewer's mark, never a payroll step.
  { id: 'work', label: 'Work', tiers: VIEW_EDIT_APPROVE, capabilities: [] },
  { id: 'settings', label: 'Settings', tiers: VIEW_EDIT, capabilities: [] },
  {
    id: 'system',
    label: 'System',
    tiers: VIEW_EDIT,
    capabilities: [
      { key: 'impersonate', label: 'Read the platform as a party sees it' },
      { key: 'audit.export', label: 'Export the audit trail' },
      { key: 'roles', label: 'Manage roles and their members' },
      // Lot G (answer 145): rolling a feature flag back is its own power,
      // because it moves a switch without the person choosing where to.
      { key: 'flags', label: 'Roll a feature flag back to its last good state' },
    ],
  },
  // Flow definitions have no view tier of their own: reading a flow is
  // `settings.view`, and `flows.edit` is the one capability the editor needs.
  { id: 'flows', label: 'Flows', tiers: ['edit'], capabilities: [] },
  // The data-protection officer's one power, in a group of its own so it is
  // never swept up by "give them everything in settings".
  { id: 'dpo', label: 'Data protection', tiers: [], capabilities: [{ key: 'erasure', label: 'Erase a person on request' }] },
];

export interface PermissionEntry {
  readonly id: string;
  readonly label: string;
  /** The tier for `<group>.<tier>` ids; `capability` for the named ones. */
  readonly kind: PermissionTier | 'capability';
}

export interface PermissionGroup {
  readonly id: string;
  readonly label: string;
  readonly permissions: readonly PermissionEntry[];
}

const TIER_LABELS: Record<PermissionTier, string> = { view: 'View', edit: 'Edit', approve: 'Approve' };

/** The matrix the console draws: one row per group, one cell per permission. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = MODULE_GROUPS.map((group) => ({
  id: group.id,
  label: group.label,
  permissions: [
    ...group.tiers.map((tier) => ({ id: `${group.id}.${tier}`, label: TIER_LABELS[tier], kind: tier })),
    ...group.capabilities.map((cap) => ({ id: `${group.id}.${cap.key}`, label: cap.label, kind: 'capability' as const })),
  ],
}));

/** Every permission id, in matrix order. What "every permission" means for the super admin. */
export const PERMISSIONS: readonly string[] = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.id));

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** The ids in `values` the catalogue does not know, in the order given, deduplicated. */
export function unknownPermissions(values: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const value of values) {
    if (!isPermission(value) && !unknown.includes(value)) unknown.push(value);
  }
  return unknown;
}

/** Every id of one tier — `permissionsOfTier('view')` is what Read-only holds. */
export function permissionsOfTier(tier: PermissionTier): string[] {
  return PERMISSION_GROUPS.flatMap((group) => group.permissions.filter((p) => p.kind === tier).map((p) => p.id));
}

/** Every id of one group, tiers and capabilities alike. */
export function permissionsOfGroup(groupId: string): string[] {
  const group = PERMISSION_GROUPS.find((g) => g.id === groupId);
  return group ? group.permissions.map((p) => p.id) : [];
}
