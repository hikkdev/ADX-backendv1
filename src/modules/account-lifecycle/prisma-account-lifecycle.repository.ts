import { Prisma, prisma } from '../../shared/database';
import type { ClosureDecision, ErasureStatus } from '../../shared/database';
import type {
  AccountLifecycleRepository,
  ClosureCaseFilter,
  ClosureCaseRow,
  ErasureFilter,
  ErasureFootprint,
  ErasurePlan,
  ErasureRow,
  Slice,
} from './account-lifecycle.repository';

/** What an erasure blanks in the document tables that carry URLs. */
const PUBLISHER_KYC_URL_FIELDS = [
  'aadhaarFrontUrl',
  'aadhaarBackUrl',
  'panFrontUrl',
  'panBackUrl',
  'gstUrl',
  'addressProofUrl',
  'bankStatement',
  'govIdFrontUrl',
  'govIdBackUrl',
  'panSignatureUrl',
  'selfieUrl',
  'businessRegCertUrl',
  'directorIdUrl',
  'businessAddressProofUrl',
  'adAuthLetterUrl',
  'ngoRegCertUrl',
  'ngoAddressProofUrl',
  'ngoTaxExemptionCertUrl',
  'ngoOperationalOverviewUrl',
] as const;

const ADVERTISER_KYC_URL_FIELDS = [
  'nationalIdUrl',
  'panCardUrl',
  'utilityBillUrl',
  'drivingLicenseUrl',
  'commercialIncCertUrl',
  'commercialAssociationArticleUrl',
  'commercialPanIdUrl',
  'commercialGstCertUrl',
  'ngoRegCertUrl',
  'ngo80gCertUrl',
  'ngoFcraRegUrl',
  'agencyAuthLetterUrl',
  'agencyGovtIdUrl',
  'govIdFrontUrl',
  'govIdBackUrl',
  'panSignatureUrl',
  'addressProofUrl',
  'selfieUrl',
] as const;

const AGENT_KYC_URL_FIELDS = [
  'govIdFrontUrl',
  'govIdBackUrl',
  'panFrontUrl',
  'panSignatureUrl',
  'addressProofUrl',
  'selfieUrl',
  'bankProofUrl',
] as const;

/**
 * The upload purposes an erasure removes outright.
 *
 * AVATAR is in the list beside the two KYC purposes: a face is the same
 * personal data whether it was uploaded to prove an identity or to decorate a
 * profile, and the User row's avatarUrl is nulled in the same transaction.
 */
const ERASABLE_PURPOSES = ['KYC', 'AGENT_KYC', 'AVATAR'];

const blank = (fields: readonly string[]): Record<string, null> =>
  Object.fromEntries(fields.map((field) => [field, null]));

/**
 * Last four of a PAN, or null when there is nothing to keep.
 *
 * The tail stays because a tax authority reconciling a TDS certificate years
 * later has the last four and nothing else to match on; the leading characters
 * are the part that identifies the person.
 */
const maskPan = (pan: string | null): string | null =>
  pan && pan.length >= 4 ? 'XXXXXX' + pan.slice(-4) : null;

/** The search term matches the person rather than the case, so the desk can search a number. */
async function userIdsMatching(q: string | undefined): Promise<string[] | null> {
  if (!q) return null;
  const text = { contains: q, mode: 'insensitive' as const };
  const users = await prisma.user.findMany({
    where: { OR: [{ name: text }, { email: text }, { mobile: { contains: q } }] },
    select: { id: true },
    take: 500,
  });
  return users.map((user) => user.id);
}

const personSelect = { id: true, name: true, mobile: true, closedAt: true } as const;

async function attachUsers<T extends { userId: string }>(
  rows: T[],
): Promise<(T & { user: ClosureCaseRow['user'] })[]> {
  if (rows.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
    select: personSelect,
  });
  const byId = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({ ...row, user: byId.get(row.userId) ?? null }));
}

function countsOf(
  groups: readonly Record<string, unknown>[],
  key: string,
  values: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = 0;
  for (const group of groups) {
    counts[String(group[key])] = (group['_count'] as { _all: number })._all;
  }
  return counts;
}

const DECISIONS: ClosureDecision[] = ['PENDING', 'CLOSED', 'REFUSED'];
const STATUSES: ErasureStatus[] = ['PENDING', 'APPROVED', 'DONE', 'REFUSED'];

export const prismaAccountLifecycleRepository: AccountLifecycleRepository = {
  /* -- The person ------------------------------------------------- */

  async findParties(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        mobile: true,
        email: true,
        isActive: true,
        closedAt: true,
        closeReason: true,
        publisherProfile: { select: { id: true } },
        advertiserProfile: { select: { id: true } },
        agentProfile: { select: { id: true } },
      },
    });
    if (!user) return null;
    return {
      userId: user.id,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      isActive: user.isActive,
      closedAt: user.closedAt,
      closeReason: user.closeReason,
      publisherId: user.publisherProfile?.id ?? null,
      advertiserId: user.advertiserProfile?.id ?? null,
      agentProfileId: user.agentProfile?.id ?? null,
    };
  },

  async closeUser(userId, data) {
    await prisma.user.update({
      where: { id: userId },
      data: { closedAt: data.at, closeReason: data.reason, closedById: data.byUserId },
    });
  },

  /* -- Closure cases ---------------------------------------------- */

  createCase(data) {
    return prisma.accountClosureCase.create({ data });
  },

  findCase(id: string) {
    return prisma.accountClosureCase.findUnique({ where: { id } });
  },

  findPendingCaseForUser(userId: string) {
    return prisma.accountClosureCase.findFirst({
      where: { userId, decision: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });
  },

  setCaseTicket(id: string, ticketId: string) {
    return prisma.accountClosureCase.update({ where: { id }, data: { ticketId } });
  },

  decideCase(id, patch) {
    return prisma.accountClosureCase.update({
      where: { id },
      data: {
        decision: patch.decision,
        decidedById: patch.decidedById,
        decidedAt: patch.decidedAt,
        ...(patch.lossNote === undefined ? {} : { lossNote: patch.lossNote }),
      },
    });
  },

  async listCases(filter: ClosureCaseFilter, slice: Slice) {
    const ids = await userIdsMatching(filter.q);
    const where: Prisma.AccountClosureCaseWhereInput = {
      ...(filter.decision ? { decision: filter.decision } : {}),
      ...(ids ? { userId: { in: ids } } : {}),
    };
    // The histogram ignores the caller's own decision facet, or selecting
    // "Closed" would make every other chip read zero.
    const facetless: Prisma.AccountClosureCaseWhereInput = ids ? { userId: { in: ids } } : {};

    const [rows, total, groups] = await Promise.all([
      prisma.accountClosureCase.findMany({ where, orderBy: { requestedAt: 'desc' }, ...slice }),
      prisma.accountClosureCase.count({ where }),
      prisma.accountClosureCase.groupBy({
        by: ['decision'],
        where: facetless,
        _count: { _all: true },
      }),
    ]);
    return {
      items: await attachUsers(rows),
      total,
      counts: countsOf(groups, 'decision', DECISIONS),
    };
  },

  /* -- Erasure ---------------------------------------------------- */

  createErasure(data) {
    return prisma.erasureRequest.create({ data });
  },

  findErasure(id: string) {
    return prisma.erasureRequest.findUnique({ where: { id } });
  },

  findOpenErasureForUser(userId: string) {
    return prisma.erasureRequest.findFirst({
      where: { userId, status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { requestedAt: 'desc' },
    });
  },

  updateErasure(id, patch) {
    return prisma.erasureRequest.update({ where: { id }, data: patch });
  },

  async listErasures(filter: ErasureFilter, slice: Slice) {
    const ids = await userIdsMatching(filter.q);
    const where: Prisma.ErasureRequestWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(ids ? { userId: { in: ids } } : {}),
    };
    const facetless: Prisma.ErasureRequestWhereInput = ids ? { userId: { in: ids } } : {};

    const [rows, total, groups] = await Promise.all([
      prisma.erasureRequest.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        include: { user: { select: personSelect } },
        ...slice,
      }),
      prisma.erasureRequest.count({ where }),
      prisma.erasureRequest.groupBy({ by: ['status'], where: facetless, _count: { _all: true } }),
    ]);
    return {
      items: rows as ErasureRow[],
      total,
      counts: countsOf(groups, 'status', STATUSES),
    };
  },

  async erase(plan: ErasurePlan): Promise<ErasureFootprint> {
    const profilesAnonymised: string[] = [];
    const kycRecordsMasked: string[] = [];

    const documentsDeleted = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: plan.userId },
        data: {
          name: 'Erased user',
          email: null,
          mobile: plan.userMobile,
          avatarUrl: null,
          passwordHash: null,
        },
      });
      profilesAnonymised.push('User');

      if (plan.publisher) {
        await tx.publisher.update({
          where: { id: plan.publisher.id },
          data: {
            name: 'ERASED',
            mobile: plan.publisher.mobile,
            email: null,
            gstin: null,
            contactName: null,
            contactMobile: null,
            contactEmail: null,
            address: null,
            city: null,
            cityId: null, // Lot X-B: the key goes with the typed city
            state: null,
          },
        });
        profilesAnonymised.push('Publisher');

        const kyc = await tx.publisherKyc.findUnique({
          where: { publisherId: plan.publisher.id },
          select: { panNumber: true },
        });
        if (kyc) {
          await tx.publisherKyc.update({
            where: { publisherId: plan.publisher.id },
            data: {
              ...blank(PUBLISHER_KYC_URL_FIELDS),
              panNumber: maskPan(kyc.panNumber),
              // The stored webhook body is the whole identity document as
              // Digio read it. Keeping it would undo everything above; the
              // four Digio identifiers are what a trace actually needs.
              digioPayload: Prisma.DbNull,
            },
          });
          kycRecordsMasked.push('PublisherKyc');
        }
      }

      if (plan.advertiser) {
        await tx.advertiser.update({
          where: { id: plan.advertiser.id },
          data: {
            name: 'ERASED',
            mobile: plan.advertiser.mobile,
            email: null,
            companyName: null,
            gstin: null,
            billingAddress: null,
            city: null,
            cityId: null, // Lot X-B: the key goes with the typed city
            state: null,
          },
        });
        profilesAnonymised.push('Advertiser');
      }

      // AdvertiserKyc is keyed by User.id, not by Advertiser.id -- see the
      // relation on the model. It can exist before the Advertiser profile
      // does, so it is handled on its own rather than inside the block above.
      const advertiserKyc = await tx.advertiserKyc.findUnique({
        where: { advertiserId: plan.advertiserKycUserId },
        select: { panNumber: true },
      });
      if (advertiserKyc) {
        await tx.advertiserKyc.update({
          where: { advertiserId: plan.advertiserKycUserId },
          data: {
            ...blank(ADVERTISER_KYC_URL_FIELDS),
            panNumber: maskPan(advertiserKyc.panNumber),
            digioPayload: Prisma.DbNull,
          },
        });
        kycRecordsMasked.push('AdvertiserKyc');
      }

      if (plan.agentProfileId) {
        await tx.agentProfile.update({
          where: { id: plan.agentProfileId },
          data: { businessName: null, city: null, cityId: null, state: null, territory: null, homeZone: null }, // Lot X-B: the key goes with the typed city
        });
        profilesAnonymised.push('AgentProfile');

        const agentKyc = await tx.agentKyc.findUnique({
          where: { agentId: plan.agentProfileId },
          select: { panNumber: true },
        });
        if (agentKyc) {
          await tx.agentKyc.update({
            where: { agentId: plan.agentProfileId },
            data: { ...blank(AGENT_KYC_URL_FIELDS), panNumber: maskPan(agentKyc.panNumber) },
          });
          kycRecordsMasked.push('AgentKyc');
        }
      }

      const userKyc = await tx.userKyc.findUnique({
        where: { userId: plan.userId },
        select: { id: true },
      });
      if (userKyc) {
        await tx.userKyc.update({ where: { userId: plan.userId }, data: { selfVideoUrl: null } });
        kycRecordsMasked.push('UserKyc');
      }

      const removed = await tx.uploadedFile.deleteMany({
        where: { userId: plan.userId, purpose: { in: ERASABLE_PURPOSES } },
      });

      // The number is gone from every column above; this is the only thing
      // that remembers it existed, and it remembers it as a hash.
      await tx.mobileTombstone.upsert({
        where: { mobileHash: plan.mobileHash },
        update: {},
        create: { mobileHash: plan.mobileHash },
      });

      return removed.count;
    });

    return { documentsDeleted, profilesAnonymised, kycRecordsMasked };
  },

  listErasuresDue(now: Date) {
    return prisma.erasureRequest.findMany({
      where: { status: 'PENDING', dueAt: { lt: now } },
      orderBy: { dueAt: 'asc' },
    });
  },

  listErasuresPastRetention(now: Date) {
    return prisma.erasureRequest.findMany({
      where: { status: 'DONE', retainUntil: { lt: now } },
      orderBy: { retainUntil: 'asc' },
    });
  },

  /* -- Tombstone -------------------------------------------------- */

  async isTombstoned(mobileHash: string) {
    return (await prisma.mobileTombstone.findUnique({ where: { mobileHash } })) !== null;
  },
};
