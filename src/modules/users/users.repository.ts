import type { ContactKind, Role, User, UserContact } from '../../shared/database';
import type { UpdateProfileInput, UpdateUserByAdminInput, UserSort, UserState } from './users.schema';

export type WithRoles = User & { roles: { role: Role }[] };
export type ProfileRow = WithRoles & {
  agentProfile: unknown;
  publisherProfile: unknown;
  advertiserProfile: unknown;
};
export type AdminListRow = ProfileRow & {
  placedOrders: unknown;
  onboardingSubmissions: unknown;
  /** E6: the console role, joined for the list. */
  roleConfig?: { roleConfig: { id: string; name: string } } | null;
};

/** E6: the admin list's facets. */
/** E7-3: what a desk needs to say who a user is — never the credentials. */
export type UserSummaryRow = {
  id: string;
  name: string | null;
  mobile: string;
  email: string | null;
  isActive: boolean;
  createdAt: Date;
  roles: { role: Role }[];
};

export type AdminListFilter = {
  closed?: boolean | undefined;
  q?: string | undefined;
  role?: Role | undefined;
  /** K-B1: one of the three chip states, and the sort. */
  state?: UserState | undefined;
  sort?: UserSort | undefined;
};

/* ── K-B1: contacts and the detail read ─────────────────────────── */

export type ContactRow = UserContact;

/** What the make-primary swap writes, in one transaction. */
export type PrimarySwap = {
  userId: string;
  contact: ContactRow;
  /**
   * The old primary, becoming a contact row; null when there was none (email).
   * Lot K2: `verifiedAt` is written as given — the phone's `mobileVerifiedAt`,
   * the email's proof date or null — never defaulted to now.
   */
  previous: { value: string; verifiedAt: Date | null } | null;
  /** Who did it — the `addedById` on the dropped-down row. */
  actorId: string;
  /** For PHONE: the stamp the new primary gets — the contact's own, or null for an unverified promotion. */
  verifiedAt: Date | null;
};

/** K-B1: the party links and counts the console's user page draws beside the profile. */
export type AdminUserDetail = {
  contactsCount: number;
  publisher: { id: string; displayId: string | null } | null;
  advertiser: { id: string; displayId: string | null } | null;
  agent: { id: string; displayId: string | null } | null;
  printPartner: { id: string; displayId: string | null } | null;
};

/** What deleteUserCascade needs to know before it starts. */
export type DeletionTarget = User & {
  roles: { role: Role }[];
  agentProfile: { id: string } | null;
  publisherProfile: { id: string } | null;
  advertiserProfile: { id: string } | null;
};

/**
 * What this account has behind it that a delete would destroy — Lot A's
 * closure guard. Each key is present only when something was found, and the
 * count is what the refusal reports, so an admin can see why the account has
 * to be closed rather than deleted.
 */
export type DeletionHistory = {
  walletEntries: number;
  ledgerLegs: number;
  orders: number;
  listings: number;
  agreementAcceptances: number;
  kycRecords: number;
};

export interface UsersRepository {
  /* DR 07 wave 5: what a person decided about their own account. */
  findPreferences(userId: string): Promise<{ key: string; value: unknown }[]>;
  upsertPreference(userId: string, key: string, value: boolean | string): Promise<void>;
  /**
   * E11-1: the person's own "send them again" — clears `User.emailUnsubscribedAt`.
   * True when a stamp was cleared; false when there was none, which the
   * service answers as 409.
   */
  clearEmailUnsubscribed(userId: string): Promise<boolean>;

  findProfile(userId: string): Promise<ProfileRow | null>;
  updateProfile(userId: string, data: UpdateProfileInput): Promise<ProfileRow>;
  /** QR-6: the terms and privacy consent, stamped with the versions agreed. */
  recordConsent(userId: string, data: { consentAcceptedAt: Date; consentTermsVersion: number | null; consentPrivacyVersion: number | null }): Promise<ProfileRow>;
  /** `closed` omitted means every account; true or false filters on User.closedAt. E6: `q` and `role`. */
  findAllForAdmin(filter?: AdminListFilter): Promise<AdminListRow[]>;
  findById(userId: string): Promise<User | null>;
  /** The target of an admin edit, with the roles the mobile rule reads. */
  findWithRoles(userId: string): Promise<WithRoles | null>;
  findByMobile(mobile: string): Promise<User | null>;
  /** Lot K2: case-insensitive — the unique index is not, and legacy rows may carry capitals (see `scripts/lowercaseEmails.ts`). */
  findByEmail(email: string): Promise<User | null>;
  updateByAdmin(userId: string, data: Omit<UpdateUserByAdminInput, 'reason' | 'roles'>): Promise<WithRoles>;
  /** K-B1: rows per state for the directory's chips — counted with the state facet removed. */
  countByState(filter: Omit<AdminListFilter, 'state' | 'sort'>): Promise<Record<UserState, number>>;
  /** K-B1: the counts and party links `GET /users/:id` adds to the profile. */
  findAdminDetail(userId: string): Promise<AdminUserDetail>;

  /* K-B1: contacts. */
  findContacts(userId: string): Promise<ContactRow[]>;
  findContact(contactId: string): Promise<ContactRow | null>;
  findContactByValue(kind: ContactKind, value: string): Promise<ContactRow | null>;
  createContact(data: { userId: string; kind: ContactKind; value: string; label?: string | undefined; addedById: string }): Promise<ContactRow>;
  updateContact(contactId: string, data: { label?: string | null; verifiedAt?: Date | null }): Promise<ContactRow>;
  deleteContact(contactId: string): Promise<unknown>;
  /**
   * The promotion: the contact's value becomes the primary, the old primary
   * becomes a verified contact row, the promoted row goes — one transaction,
   * so the account never holds the same value twice or loses one.
   */
  swapPrimary(swap: PrimarySwap): Promise<WithRoles>;
  findDeletionTarget(userId: string): Promise<DeletionTarget | null>;
  /**
   * Removes the user and everything that references them, in one transaction.
   * See the README — this is the one place a module reaches across domains on
   * purpose, because the cascade has to be atomic.
   */
  deleteUserCascade(target: DeletionTarget): Promise<void>;
  /**
   * Everything that makes this account history rather than a mistake. Read
   * before a delete: an account with any of it is closed through the closure
   * case, never removed. See the README.
   */
  findDeletionHistory(target: DeletionTarget): Promise<DeletionHistory>;
  createWithRoles(data: {
    mobile: string;
    name?: string;
    email?: string;
    roles: Role[];
  }): Promise<User>;
  findAnyAdminRole(): Promise<{ userId: string } | null>;
  findAdminUserIds(): Promise<{ userId: string }[]>;
  /** E6: the display names behind a set of ids, for the reads that join an actor. */
  findNamesByIds(ids: string[]): Promise<{ id: string; name: string | null; mobile: string }[]>;
  /** E7-3: name, contacts and roles behind a set of ids, for the desks that name a requester or a target. */
  findSummariesByIds(ids: string[]): Promise<UserSummaryRow[]>;
  /**
   * E6: the system account the jobs write their audit rows under. Created
   * once — inactive, no roles, a mobile nobody can register — and never
   * rewritten: an existing row is returned as it stands.
   */
  ensureSystemUser(input: { mobile: string; name: string }): Promise<{ id: string }>;
  grantAdmin(userId: string): Promise<unknown>;
  grantRole(userId: string, role: Role): Promise<unknown>;
  /** M-B: the admin editor's roles patch — the rows become exactly `roles`, in one transaction. */
  replaceRoles(userId: string, roles: Role[]): Promise<unknown>;
  ensureAgentProfile(userId: string): Promise<unknown>;
}
