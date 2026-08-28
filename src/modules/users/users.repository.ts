import type { Role, User } from '../../shared/database';
import type { UpdateProfileInput, UpdateUserByAdminInput } from './users.schema';

export type WithRoles = User & { roles: { role: Role }[] };
export type ProfileRow = WithRoles & { agentProfile: unknown; publisherProfile: unknown };
export type AdminListRow = ProfileRow & { placedOrders: unknown; onboardingSubmissions: unknown };

/** What deleteUserCascade needs to know before it starts. */
export type DeletionTarget = User & {
  roles: { role: Role }[];
  agentProfile: { id: string } | null;
  publisherProfile: { id: string } | null;
};

export interface UsersRepository {
  findProfile(userId: string): Promise<ProfileRow | null>;
  updateProfile(userId: string, data: UpdateProfileInput): Promise<ProfileRow>;
  findAllForAdmin(): Promise<AdminListRow[]>;
  findById(userId: string): Promise<User | null>;
  findByMobile(mobile: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  updateByAdmin(userId: string, data: UpdateUserByAdminInput): Promise<WithRoles>;
  findDeletionTarget(userId: string): Promise<DeletionTarget | null>;
  countAdmins(): Promise<number>;
  /**
   * Removes the user and everything that references them, in one transaction.
   * See the README — this is the one place a module reaches across domains on
   * purpose, because the cascade has to be atomic.
   */
  deleteUserCascade(target: DeletionTarget): Promise<void>;
  createWithRoles(data: {
    mobile: string;
    name?: string;
    email?: string;
    roles: Role[];
  }): Promise<User>;
  findAnyAdminRole(): Promise<{ userId: string } | null>;
  grantAdmin(userId: string): Promise<unknown>;
  grantRole(userId: string, role: Role): Promise<unknown>;
  ensureAgentProfile(userId: string): Promise<unknown>;
}
