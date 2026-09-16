import type { RoleConfig } from '../../shared/database';
import type { CreateRoleConfigInput, UpdateRoleConfigInput } from './access-control.schema';

/** A role with how many people hold it — what the console list draws. */
export type RoleConfigWithCount = RoleConfig & { _count: { members: number } };

/** The membership row, plus the role it points at. */
export type MembershipRow = {
  id: string;
  userId: string;
  roleConfigId: string;
  assignedById: string | null;
  assignedAt: Date;
  roleConfig: RoleConfig;
};

export interface RoleConfigRepository {
  findAll(): Promise<RoleConfigWithCount[]>;
  /** T-B: the one read and the two writes carry the member count the list carries. */
  findById(id: string): Promise<RoleConfigWithCount | null>;
  findByName(name: string): Promise<RoleConfig | null>;
  create(data: CreateRoleConfigInput): Promise<RoleConfigWithCount>;
  update(id: string, data: UpdateRoleConfigInput): Promise<RoleConfigWithCount>;
  remove(id: string): Promise<unknown>;

  /* ── console access (Lot A) ───────────────────────────────────── */

  /** Upsert by name — how `ensureSystemRoles` seeds without a migration. */
  upsertByName(data: {
    name: string;
    description: string;
    permissions: string[];
    isSystem: boolean;
  }): Promise<RoleConfig>;
  countMembers(roleConfigId: string): Promise<number>;
  /**
   * Who holds this role — the people whose sessions a permission change ends.
   * `activeOnly` narrows it to accounts still open (Lot G: the KYC escalation
   * pool must never name somebody who cannot log in).
   */
  listMemberUserIds(roleConfigId: string, options?: { activeOnly?: boolean }): Promise<string[]>;
  findMembership(userId: string): Promise<MembershipRow | null>;
  setMembership(userId: string, roleConfigId: string, assignedById: string): Promise<MembershipRow>;
  clearMembership(userId: string): Promise<unknown>;
  /** Whether the user holds the ADMIN Role — a role config is console access, and only an admin has a console. */
  isAdmin(userId: string): Promise<boolean>;
  userExists(userId: string): Promise<boolean>;
}
