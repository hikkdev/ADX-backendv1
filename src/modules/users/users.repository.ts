import type { ContactKind, Role, User, UserContact, UserRead } from '../../shared/database';
import type { UpdateProfileInput, UpdateUserByAdminInput, UserSort, UserState } from './users.schema';

export type WithRoles = UserRead & { roles: { role: Role }[] };
/**
 * The profile reads (`/users/me`, the admin user page and list) opt back into
 * the credential columns past the global omit, because `hasPassword` and the
 * second-factor summary are computed from them. The row leaves only through
 * users.mapper, which copies neither column.
 */
export type ProfileRow = User & { roles: { role: Role }[] } & {
  agentProfile: unknown;
  publisherProfile: unknown;
  advertiserProfile: unknown;
};
export type AdminListRow = ProfileRow & {
  placedOrders: unknown;
  onboardingSubmissions: unknown;
  /** E6: the console role, joined for the list. */
  roleConfig?: { roleConfig: { id: string; name: string } } | null;
  /** 2 Oct 2026: the staff record and the print shop the login holds, for the row's `parties`. */
  employeeProfile?: { id: string; displayId: string | null; designation: string | null } | null;
  printPartner?: { id: string; name: string; displayId: string | null } | null;
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
  /** The stamp the new primary gets (`mobileVerifiedAt` / ED-1 `emailVerifiedAt`) — the contact's own, or null for an unverified promotion. */
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
export type DeletionTarget = UserRead & {
  roles: { role: Role }[];
  agentProfile: { id: string } | null;
  publisherProfile: { id: string } | null;
  advertiserProfile: { id: string } | null;
  /** Account lifecycle (2 Oct 2026): the HR record and the print shop — `PrintPartner.userId` has no relation, so it is looked up beside. Optional for the callers that predate them. */
  employeeProfile?: { id: string } | null;
  printPartner?: { id: string } | null;
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
  /** Account lifecycle: a KYC record with something in it — submitted, requested, started on Digio or decided — on any party, the print shop's and the HR record's included. A blank row made with the account is not history. */
  kycRecords: number;
  /** Account lifecycle (2 Oct 2026): invoices raised to the advertiser or the publisher. */
  invoices: number;
  campaigns: number;
  packageSales: number;
  /** Access grants that were claimed — on the person's account, or held as an agent. */
  accessGrantsUsed: number;
  /** A print partner's jobs and quotes. */
  printWork: number;
  /** An employee's desk work — interviews held, agents managed, departments headed, actions on other records. */
  staffWork: number;
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
  findById(userId: string): Promise<UserRead | null>;
  /** The target of an admin edit, with the roles the mobile rule reads. */
  findWithRoles(userId: string): Promise<WithRoles | null>;
  findByMobile(mobile: string): Promise<UserRead | null>;
  /** Lot K2: case-insensitive — the unique index is not, and legacy rows may carry capitals (see `scripts/lowercaseEmails.ts`). */
  findByEmail(email: string): Promise<UserRead | null>;
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
    /** 28 Sep 2026: the person's own ADX-… id, minted by the service. */
    displayId?: string;
    name?: string;
    email?: string;
    roles: Role[];
  }): Promise<UserRead>;
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
