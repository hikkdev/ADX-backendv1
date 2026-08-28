import type { Role, User } from '../../shared/database';

/**
 * The User reads and writes authentication needs.
 *
 * The `users` module also owns `User`. That overlap is deliberate and is the
 * one place two modules share a table: auth needs the credential columns to log
 * someone in, and inverting it (`auth` calling `users`) would create a cycle,
 * because `users` needs auth's session listing for GET /users/me/sessions.
 * Split by concern, not by table: auth touches passwordHash, isActive,
 * lastLoginAt and the role list; users owns profile and administration.
 * See docs/backend-modules.md.
 */

/** Everything a login response needs, in one query. */
export type LoginUser = User & {
  roles: { role: Role }[];
  agentProfile: unknown;
  publisherProfile: unknown;
};

/** Publisher login joins a narrower set — no agentProfile, no KYC. */
export type PublisherLoginUser = User & {
  roles: { role: Role }[];
  publisherProfile: unknown;
};

export interface AuthRepository {
  findLoginUserById(userId: string): Promise<LoginUser | null>;
  findLoginUserByEmail(email: string): Promise<LoginUser | null>;
  /** Lean lookup for forgot-password, which only needs the id. */
  findByEmail(email: string): Promise<User | null>;
  findUserWithRoles(userId: string): Promise<(User & { roles: { role: Role }[] }) | null>;
  findPublisherLoginUserById(userId: string): Promise<PublisherLoginUser | null>;
  findByMobileWithRoles(mobile: string): Promise<(User & { roles: { role: Role }[] }) | null>;
  findById(userId: string): Promise<User | null>;
  /** Stamps the moment a session was established. */
  recordLogin(userId: string): Promise<unknown>;
  setPasswordHash(userId: string, passwordHash: string): Promise<unknown>;
  setName(userId: string, name: string): Promise<unknown>;
}
