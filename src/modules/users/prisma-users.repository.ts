import { prisma, Prisma, USER_CREDENTIALS } from '../../shared/database';
import type { ContactKind, Role } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import type { AdminListFilter, DeletionTarget, PrimarySwap, UsersRepository } from './users.repository';
import type { UpdateProfileInput, UpdateUserByAdminInput, UserState } from './users.schema';

/**
 * K-B1: the directory's where-clause, shared by the page and the chip counts. Exported for its test.
 *
 * 2 Oct 2026 (the owner: "a lot of users ... as if they're not linked at all"):
 * the search also reaches what the login holds: the publisher's and the
 * advertiser's business name and account ID, the agent's business name and
 * ID, the employee's ID, and the person's own ADX-... id. A print shop has no
 * relation on `User`, so the shops whose name or ID matched are looked up
 * first and handed in as `alsoUserIds`.
 */
export function adminListWhere(filter: Omit<AdminListFilter, 'sort'>, alsoUserIds: readonly string[] = []): Prisma.UserWhereInput {
  const q = filter.q?.trim();
  const has = (field: string) => ({ [field]: { contains: q, mode: 'insensitive' as const } });
  return {
    ...(filter.closed === undefined ? {} : filter.closed ? { closedAt: { not: null } } : { closedAt: null }),
    // Account lifecycle (2 Oct 2026): ERASED is its own state — a closed account whose person was erased.
    ...(filter.state === 'CLOSED' ? { closedAt: { not: null }, erasedAt: null } : {}),
    ...(filter.state === 'ERASED' ? { erasedAt: { not: null } } : {}),
    ...(filter.state === 'INACTIVE' ? { closedAt: null, isActive: false } : {}),
    ...(filter.state === 'ACTIVE' ? { closedAt: null, isActive: true } : {}),
    // E6: the console's search box and role chip. K-B1: a contact's value counts too.
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { mobile: { contains: q } },
            { contacts: { some: { value: { contains: q, mode: 'insensitive' } } } },
            has('displayId'),
            { publisherProfile: { is: { OR: [has('name'), has('displayId')] } } },
            { advertiserProfile: { is: { OR: [has('name'), has('displayId')] } } },
            { agentProfile: { is: { OR: [has('businessName'), has('displayId')] } } },
            { employeeProfile: { is: has('displayId') } },
            ...(alsoUserIds.length > 0 ? [{ id: { in: [...alsoUserIds] } }] : []),
          ],
        }
      : {}),
    ...(filter.role ? { roles: { some: { role: filter.role } } } : {}),
  };
}

/** The users whose print shop matches the search by name, legal name or ID; `PrintPartner.userId` has no relation on `User`. */
async function printPartnerUserIdsMatching(q: string | undefined): Promise<string[]> {
  const text = q?.trim();
  if (!text) return [];
  const contains = { contains: text, mode: 'insensitive' as const };
  const rows = await prisma.printPartner.findMany({
    where: { OR: [{ name: contains }, { legalName: contains }, { displayId: contains }] },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

const ADMIN_LIST_ORDER: Record<NonNullable<AdminListFilter['sort']>, Prisma.UserOrderByWithRelationInput[]> = {
  newest: [{ createdAt: 'desc' }],
  oldest: [{ createdAt: 'asc' }],
  name: [{ name: 'asc' }, { createdAt: 'desc' }],
  lastLogin: [{ lastLoginAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
};

/** Account lifecycle (2 Oct 2026): a KYC row with something in it — the column names every party's KYC table shares. */
const KYC_WITH_HISTORY = {
  OR: [{ submittedAt: { not: null } }, { requestedAt: { not: null } }, { digioRequestId: { not: null } }, { status: { not: 'PENDING' as const } }],
};

/** An employee's desk work: interviews held, agents managed, departments headed, and actions taken on records other than their own account. */
async function staffWorkOf(employeeId: string, userId: string): Promise<number> {
  const [interviews, managed, headed, actions] = await Promise.all([
    prisma.agentInterview.count({ where: { interviewerId: employeeId } }),
    prisma.agentProfile.count({ where: { reportingManagerId: employeeId } }),
    prisma.department.count({ where: { headId: employeeId } }),
    prisma.activityLog.count({ where: { userId, targetId: { not: null }, NOT: { targetId: userId } } }),
  ]);
  return interviews + managed + headed + actions;
}

const profileInclude = {
  roles: true,
  agentProfile: true,
  publisherProfile: { include: { kyc: true } },
  // The app routes on which side of the marketplace the account is on, and
  // an account can be on both; both sides come back.
  advertiserProfile: true,
} as const;

// Prisma's default strategy runs one query per relation. GET /users/me is on
// every authenticated page load, and with the database in another region those
// five sequential round trips cost ~85ms each. `join` collapses them into one
// LATERAL JOIN. Used on the single-row profile reads only — see the comment on
// findAllForAdmin for why the admin list is left alone.
const JOIN = { relationLoadStrategy: 'join' } as const;

// 2 Oct 2026: the profile reads opt back into the credential columns the
// global omit keeps back — `hasPassword` and the second-factor summary are
// computed from them in users.mapper, which copies neither into a response.
const CREDENTIALS = { omit: USER_CREDENTIALS } as const;

export const prismaUsersRepository: UsersRepository = {
  findPreferences(userId: string) {
    return prisma.userPreference.findMany({ where: { userId }, select: { key: true, value: true } });
  },

  async upsertPreference(userId: string, key: string, value: boolean | string) {
    await prisma.userPreference.upsert({
      where: { userId_key: { userId, key } },
      update: { value },
      create: { userId, key, value },
    });
  },

  // E11-1: the mirror of notifications' `markEmailUnsubscribed` — one
  // updateMany narrowed to the stamped row, so the count says whether there
  // was anything to undo.
  async clearEmailUnsubscribed(userId: string) {
    const result = await prisma.user.updateMany({
      where: { id: userId, emailUnsubscribedAt: { not: null } },
      data: { emailUnsubscribedAt: null },
    });
    return result.count > 0;
  },

  findProfile(userId: string) {
    return prisma.user.findUnique({ ...JOIN, ...CREDENTIALS, where: { id: userId }, include: profileInclude }) as never;
  },

  updateProfile(userId: string, data: UpdateProfileInput) {
    return prisma.user.update({ ...CREDENTIALS, where: { id: userId }, data, include: profileInclude }) as never;
  },

  recordConsent(userId: string, data: { consentAcceptedAt: Date; consentTermsVersion: number | null; consentPrivacyVersion: number | null }) {
    return prisma.user.update({ ...CREDENTIALS, where: { id: userId }, data, include: profileInclude }) as never;
  },

  // NOTE: unbounded, and deliberately left on the default load strategy.
  // It returns every user joined to seven relations including one-to-many
  // listings/sites/orders. A `join` strategy here would widen an already
  // unbounded result set rather than fix it, and the real fix is pagination,
  // which changes this endpoint's contract. Cheap today (2 users) but it will
  // degrade sharply with real data — see the audit notes.
  async findAllForAdmin(filter: AdminListFilter = {}) {
    const users = await prisma.user.findMany({
      ...CREDENTIALS,
      where: adminListWhere(filter, await printPartnerUserIdsMatching(filter.q)),
      include: {
        roles: true,
        // E6: the console role, for the list's column.
        roleConfig: { include: { roleConfig: { select: { id: true, name: true } } } },
        agentProfile: true,
        // Nested so the admin panel can show Publisher KYC status/documents for
        // business visibility without needing the agent-scoped /publishers
        // endpoints — actual KYC review stays agent-mediated (QR-claim flow in
        // the Publisher/Agent apps), the admin panel only ever reads this.
        publisherProfile: { include: { kyc: true, listings: true, sites: true } },
        // 2 Oct 2026: what the login holds, named on the row (`parties`).
        advertiserProfile: { select: { id: true, name: true, displayId: true } },
        employeeProfile: { select: { id: true, displayId: true, designation: true } },
        placedOrders: { select: { id: true, status: true, createdAt: true } },
        onboardingSubmissions: {
          include: { flowTemplate: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: ADMIN_LIST_ORDER[filter.sort ?? 'newest'],
    });
    // The print shop each login runs, read once for the whole list: no relation on `User` to include it by.
    const shops = users.length
      ? await prisma.printPartner.findMany({
          where: { userId: { in: users.map((user) => user.id) } },
          select: { id: true, name: true, displayId: true, userId: true },
        })
      : [];
    const shopOf = new Map(shops.map((shop) => [shop.userId, shop]));
    return users.map((user) => ({ ...user, printPartner: shopOf.get(user.id) ?? null })) as never;
  },

  async countByState(filter) {
    const base = adminListWhere({ ...filter, state: undefined }, await printPartnerUserIdsMatching(filter.q));
    const [closed, erased, inactive, active] = await Promise.all([
      prisma.user.count({ where: { AND: [base, { closedAt: { not: null }, erasedAt: null }] } }),
      prisma.user.count({ where: { AND: [base, { erasedAt: { not: null } }] } }),
      prisma.user.count({ where: { AND: [base, { closedAt: null, isActive: false }] } }),
      prisma.user.count({ where: { AND: [base, { closedAt: null, isActive: true }] } }),
    ]);
    const counts: Record<UserState, number> = { ACTIVE: active, INACTIVE: inactive, CLOSED: closed, ERASED: erased };
    return counts;
  },

  /*
   * K-B1: the party links the user page cross-links. `PrintPartner.userId`
   * has no back-relation on `User` and `print-partners` sits above this
   * module (through `orders`), so that one is a narrow select here — the
   * same deliberate cross-domain read the deletion cascade already makes.
   */
  async findAdminDetail(userId: string) {
    const [row, printPartner] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          _count: { select: { contacts: true } },
          publisherProfile: { select: { id: true, displayId: true } },
          advertiserProfile: { select: { id: true, displayId: true } },
          agentProfile: { select: { id: true, displayId: true } },
        },
      }),
      prisma.printPartner.findUnique({ where: { userId }, select: { id: true, displayId: true } }),
    ]);
    return {
      contactsCount: row?._count.contacts ?? 0,
      publisher: row?.publisherProfile ?? null,
      advertiser: row?.advertiserProfile ?? null,
      agent: row?.agentProfile ?? null,
      printPartner: printPartner ?? null,
    };
  },

  /* ── K-B1: contacts ─────────────────────────────────────────── */

  findContacts(userId: string) {
    return prisma.userContact.findMany({ where: { userId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
  },

  findContact(contactId: string) {
    return prisma.userContact.findUnique({ where: { id: contactId } });
  },

  findContactByValue(kind: ContactKind, value: string) {
    return prisma.userContact.findUnique({ where: { kind_value: { kind, value } } });
  },

  async createContact(data) {
    try {
      return await prisma.userContact.create({ data });
    } catch (error) {
      // Lot K2: two adds of the same value in the same instant — the check
      // ran clean for both, the @@unique(kind, value) caught the second.
      // The same 409 the check answers, so the race reads like the rule.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiError(409, 'CONTACT_TAKEN', `This ${data.kind === 'EMAIL' ? 'email' : 'number'} is already on an account as a contact.`, {
          kind: data.kind,
          value: data.value,
          which: 'CONTACT',
        });
      }
      throw error;
    }
  },

  updateContact(contactId: string, data) {
    return prisma.userContact.update({ where: { id: contactId }, data });
  },

  deleteContact(contactId: string) {
    return prisma.userContact.delete({ where: { id: contactId } });
  },

  swapPrimary({ userId, contact, previous, actorId, verifiedAt }: PrimarySwap) {
    return prisma.$transaction(async (tx) => {
      // The promoted row goes first, so the unique (kind, value) pair is free
      // before the old primary is written down as a contact of the same kind.
      await tx.userContact.delete({ where: { id: contact.id } });
      if (previous) {
        await tx.userContact.create({
          data: {
            userId,
            kind: contact.kind,
            value: previous.value,
            label: contact.kind === 'PHONE' ? 'Previous number' : 'Previous email',
            // Lot K2 (Lot K verifier): the stamp the old primary actually
            // had. A PHONE carries `mobileVerifiedAt`; an EMAIL carries the
            // moment `hasProvenEmail` vouched for, or null — a primary that
            // was never proved does not become a verified contact by moving.
            verifiedAt: previous.verifiedAt,
            addedById: actorId,
          },
        });
      }
      return tx.user.update({
        where: { id: userId },
        // ED-1: an EMAIL promotion carries its proof onto the row the same way.
        data: contact.kind === 'PHONE' ? { mobile: contact.value, mobileVerifiedAt: verifiedAt } : { email: contact.value, emailVerifiedAt: verifiedAt },
        include: { roles: true },
      }) as never;
    });
  },

  findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  findWithRoles(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, include: { roles: true } }) as never;
  },

  findByMobile(mobile: string) {
    return prisma.user.findUnique({ where: { mobile } });
  },

  async findByEmail(email: string) {
    // Lot K2: `lower() = lower()`, not Prisma's `mode: 'insensitive'` —
    // that compiles to ILIKE, where `_` and `%` in the value are wildcards
    // and `a_b@x.co` would match `aXb@x.co`. Same reason as auth's Google
    // lookup. The unique index is case-sensitive and rows written before
    // K-B1 may carry capitals; `scripts/lowercaseEmails.ts` folds those.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE lower("email") = lower(${email}) LIMIT 1
    `;
    const id = rows[0]?.id;
    return id ? prisma.user.findUnique({ where: { id } }) : null;
  },

  updateByAdmin(userId: string, data: Omit<UpdateUserByAdminInput, 'reason' | 'roles'>) {
    return prisma.user.update({ where: { id: userId }, data, include: { roles: true } }) as never;
  },

  async findDeletionTarget(userId: string) {
    const [user, printPartner] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        include: { roles: true, agentProfile: true, publisherProfile: true, advertiserProfile: true, employeeProfile: { select: { id: true } } },
      }),
      // Account lifecycle: `PrintPartner.userId` carries no relation on User.
      prisma.printPartner.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    return (user ? { ...user, printPartner } : null) as never;
  },

  /**
   * Lot A: the five kinds of history that make an account uncloseable by
   * delete — money that moved, work that was done, spots that were listed,
   * agreements that were signed and identity that was checked.
   *
   * Counted rather than merely detected: the refusal names what it found, and
   * "3 orders" is a different conversation from "1 KYC record".
   */
  async findDeletionHistory(user: DeletionTarget) {
    const publisherId = user.publisherProfile?.id ?? null;
    const advertiserId = user.advertiserProfile?.id ?? null;
    const agentId = user.agentProfile?.id ?? null;
    const printPartnerId = user.printPartner?.id ?? null;
    const employeeId = user.employeeProfile?.id ?? null;

    const walletOwners = [
      ...(publisherId ? [{ publisherId }] : []),
      ...(advertiserId ? [{ advertiserId }] : []),
      ...(agentId ? [{ agentId }] : []),
      ...(printPartnerId ? [{ printPartnerId }] : []),
    ];
    const wallets = walletOwners.length
      ? await prisma.wallet.findMany({ where: { OR: walletOwners }, select: { id: true } })
      : [];
    const walletIds = wallets.map((wallet) => wallet.id);

    const listingOwners = [
      ...(publisherId ? [{ publisherId }] : []),
      ...(agentId ? [{ agentId }] : []),
    ];

    const [walletEntries, ledgerLegs, ownedListings, orders, acceptances, kycRecords] =
      await Promise.all([
        walletIds.length
          ? prisma.walletEntry.count({ where: { walletId: { in: walletIds } } })
          : 0,
        walletIds.length
          ? prisma.ledgerLeg.count({ where: { account: { walletId: { in: walletIds } } } })
          : 0,
        listingOwners.length
          ? prisma.listing.findMany({ where: { OR: listingOwners }, select: { id: true } })
          : [],
        prisma.order.count({
          where: {
            OR: [{ advertiserId: user.id }, ...(agentId ? [{ agentId }] : [])],
          },
        }),
        prisma.agreementAcceptance.count({
          where: {
            OR: [
              { acceptedByUserId: user.id },
              ...(publisherId ? [{ publisherId }] : []),
              ...(advertiserId ? [{ advertiserId }] : []),
            ],
          },
        }),
        // Account lifecycle (2 Oct 2026): a KYC record is history once something
        // is in it — submitted, requested, started on Digio, or decided. The
        // blank row a publisher is born with is not, so it no longer makes
        // every publisher undeletable. The print shop's and the HR record's count too.
        Promise.all([
          prisma.userKyc.count({ where: { userId: user.id, OR: [{ submittedAt: { not: null } }, { status: { not: 'PENDING' } }, { selfVideoUrl: { not: null } }] } }),
          publisherId ? prisma.publisherKyc.count({ where: { publisherId, ...KYC_WITH_HISTORY } }) : 0,
          // The record hangs off the profile; a legacy one only off the user (`advertiserId` is the user id).
          prisma.advertiserKyc.count({ where: { AND: [{ OR: [{ advertiserId: user.id }, ...(advertiserId ? [{ advertiserProfileId: advertiserId }] : [])] }, KYC_WITH_HISTORY] } }),
          agentId ? prisma.agentKyc.count({ where: { agentId, ...KYC_WITH_HISTORY } }) : 0,
          printPartnerId ? prisma.printPartnerKyc.count({ where: { printPartnerId, ...KYC_WITH_HISTORY } }) : 0,
          employeeId ? prisma.employeeKyc.count({ where: { employeeId, ...KYC_WITH_HISTORY } }) : 0,
        ]).then((counts) => counts.reduce((total, count) => total + count, 0)),
      ]);

    // Account lifecycle (2 Oct 2026): the rest of what makes an account a record.
    const grantSubjects = [...(publisherId ? [{ publisherId }] : []), ...(advertiserId ? [{ advertiserId }] : []), ...(agentId ? [{ assignedAgentId: agentId }] : [])];
    const [invoices, publisherInvoices, campaigns, packageSales, accessGrantsUsed, printJobs, printQuotes, staffWork] = await Promise.all([
      prisma.invoice.count({ where: { advertiserId: { in: [user.id, ...(advertiserId ? [advertiserId] : [])] } } }),
      publisherId ? prisma.publisherInvoice.count({ where: { publisherId } }) : 0,
      advertiserId ? prisma.campaign.count({ where: { advertiserId } }) : 0,
      advertiserId ? prisma.packageSale.count({ where: { advertiserId } }) : 0,
      grantSubjects.length ? prisma.delegatedAccessGrant.count({ where: { claimedAt: { not: null }, OR: grantSubjects } }) : 0,
      printPartnerId ? prisma.printJob.count({ where: { printPartnerId } }) : 0,
      printPartnerId ? prisma.printQuote.count({ where: { printPartnerId } }) : 0,
      employeeId ? staffWorkOf(employeeId, user.id) : 0,
    ]);

    // An order raised against one of this person's spots is their history too,
    // even when somebody else placed it.
    const listingIds = ownedListings.map((listing) => listing.id);
    const ordersOnListings = listingIds.length
      ? await prisma.order.count({ where: { listingId: { in: listingIds } } })
      : 0;

    return {
      walletEntries,
      ledgerLegs,
      orders: orders + ordersOnListings,
      listings: listingIds.length,
      agreementAcceptances: acceptances,
      kycRecords,
      invoices: invoices + publisherInvoices,
      campaigns,
      packageSales,
      accessGrantsUsed,
      printWork: printJobs + printQuotes,
      staffWork,
    };
  },

  async deleteUserCascade(user: DeletionTarget) {
    const id = user.id;

    // One transaction end to end. The rows below live in other modules'
    // tables, but the delete has to be atomic: a partial cascade would leave
    // orders pointing at a user that no longer exists. See README.
    await prisma.$transaction(async (tx) => {
      const orderIds = new Set<string>();

      const advertiserOrders = await tx.order.findMany({
        where: { advertiserId: id },
        select: { id: true },
      });
      advertiserOrders.forEach((order) => orderIds.add(order.id));

      if (user.agentProfile) {
        const agentOrders = await tx.order.findMany({
          where: { agentId: user.agentProfile.id },
          select: { id: true },
        });
        agentOrders.forEach((order) => orderIds.add(order.id));
      }

      if (user.publisherProfile || user.agentProfile) {
        const listingWhere = {
          OR: [
            ...(user.publisherProfile ? [{ publisherId: user.publisherProfile.id }] : []),
            ...(user.agentProfile ? [{ agentId: user.agentProfile.id }] : []),
          ],
        };
        const listings = listingWhere.OR.length
          ? await tx.listing.findMany({ where: listingWhere, select: { id: true } })
          : [];
        if (listings.length) {
          const listingOrders = await tx.order.findMany({
            where: { listingId: { in: listings.map((listing) => listing.id) } },
            select: { id: true },
          });
          listingOrders.forEach((order) => orderIds.add(order.id));
        }
      }

      const orderIdList = [...orderIds];
      if (orderIdList.length) {
        const milestones = await tx.orderMilestone.findMany({
          where: { orderId: { in: orderIdList } },
          select: { id: true },
        });
        const milestoneIds = milestones.map((milestone) => milestone.id);
        if (milestoneIds.length) {
          await tx.orderMilestoneEvidence.deleteMany({ where: { milestoneId: { in: milestoneIds } } });
        }
        await tx.orderMilestone.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.orderAgentAssignment.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.checkIn.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.siteVerification.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.order.deleteMany({ where: { id: { in: orderIdList } } });
      }

      if (user.publisherProfile || user.agentProfile) {
        const listingWhere = {
          OR: [
            ...(user.publisherProfile ? [{ publisherId: user.publisherProfile.id }] : []),
            ...(user.agentProfile ? [{ agentId: user.agentProfile.id }] : []),
          ],
        };
        if (listingWhere.OR.length) {
          await tx.listing.deleteMany({ where: listingWhere });
        }
      }

      if (user.publisherProfile) {
        await tx.site.deleteMany({ where: { publisherId: user.publisherProfile.id } });
        await tx.publisher.delete({ where: { id: user.publisherProfile.id } });
      }

      // Account lifecycle (2 Oct 2026): the advertiser profile goes with the
      // account (it used to be left behind with its user nulled), and so does
      // the print shop, which has no foreign key to cascade through. Their
      // wallets, KYC rows, brands and unclaimed grants cascade with them.
      if (user.advertiserProfile) {
        await tx.advertiser.delete({ where: { id: user.advertiserProfile.id } });
      }
      if (user.printPartner) {
        await tx.printPartner.delete({ where: { id: user.printPartner.id } });
      }

      if (user.agentProfile) {
        // An unclaimed grant offered to this agent names them without a cascade; a claimed one is history and never reaches here.
        await tx.delegatedAccessGrant.deleteMany({ where: { assignedAgentId: user.agentProfile.id, claimedAt: null } });
        await tx.orderMilestone.updateMany({
          where: { assignedAgentId: user.agentProfile.id },
          data: { assignedAgentId: null },
        });
        await tx.order.updateMany({
          where: { agentId: user.agentProfile.id },
          data: { agentId: null },
        });
        await tx.orderAgentAssignment.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.transaction.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.agentMilestone.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.publisher.updateMany({
          where: { agentId: user.agentProfile.id },
          data: { agentId: null },
        });
        await tx.agentProfile.delete({ where: { id: user.agentProfile.id } });
      }

      await tx.qrScan.deleteMany({ where: { scannedById: id } });
      await tx.ticketMessage.deleteMany({ where: { authorId: id } });
      await tx.supportTicket.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });
  },

  createWithRoles({ mobile, displayId, name, email, roles }) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { mobile, ...(displayId ? { displayId } : {}), name, email } });

      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId: created.id, role })),
      });

      const isAgent = roles.some((r) => r === 'AGENT_PUBLISHER' || r === 'AGENT_ADVERTISER');
      if (isAgent) {
        await tx.agentProfile.create({ data: { userId: created.id } });
      }

      return created;
    });
  },

  findAnyAdminRole() {
    return prisma.userRole.findFirst({ where: { role: 'ADMIN' } });
  },

  findAdminUserIds() {
    return prisma.userRole.findMany({ where: { role: 'ADMIN' }, select: { userId: true } });
  },

  async ensureSystemUser({ mobile, name }: { mobile: string; name: string }) {
    const existing = await prisma.user.findUnique({ where: { mobile }, select: { id: true } });
    if (existing) return existing;
    return prisma.user.create({ data: { mobile, name, isActive: false }, select: { id: true } });
  },

  findNamesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, mobile: true } });
  },

  findSummariesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, mobile: true, email: true, isActive: true, createdAt: true, roles: { select: { role: true } } },
    });
  },

  grantAdmin(userId: string) {
    return prisma.userRole.create({ data: { userId, role: 'ADMIN' } });
  },

  grantRole(userId: string, role: Role) {
    return prisma.userRole.upsert({
      where: { userId_role: { userId, role } },
      update: {},
      create: { userId, role },
    });
  },

  replaceRoles(userId: string, roles: Role[]) {
    return prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId, role: { notIn: roles } } });
      await tx.userRole.createMany({ data: roles.map((role) => ({ userId, role })), skipDuplicates: true });
    });
  },

  ensureAgentProfile(userId: string) {
    return prisma.agentProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  },
};
