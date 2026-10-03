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

/** Account lifecycle (2 Oct 2026): the staff record's KYC carries the agent's seven links. */
const EMPLOYEE_KYC_URL_FIELDS = AGENT_KYC_URL_FIELDS;

const PRINT_PARTNER_KYC_URL_FIELDS = [
  'panFrontUrl',
  'panSignatureUrl',
  'gstUrl',
  'businessRegCertUrl',
  'businessAddressProofUrl',
  'directorIdUrl',
  'govIdFrontUrl',
  'govIdBackUrl',
  'bankProofUrl',
  'selfieUrl',
] as const;

/** The HR record's papers — single links, and the lists of them. */
const EMPLOYEE_URL_FIELDS = [
  'passportPhotoUrl',
  'referenceLetterUrl',
  'ndaAgreementUrl',
  'nonCompeteAgreementUrl',
  'class10MarksheetUrl',
  'class12MarksheetUrl',
  'graduationMarksheetUrl',
  'postGraduationMarksheetUrl',
  'form2NominationUrl',
  'form6aUrl',
  'esiFormUrl',
  'form2FamilyDeclarationUrl',
  'form6EmployeeRegistrationUrl',
  'salaryAccountLetterUrl',
] as const;
const EMPLOYEE_URL_LIST_FIELDS = ['salarySlipUrls', 'complianceFormUrls', 'epfFormUrls', 'gratuityFormUrls'] as const;

/** Every link a row holds in these columns, for removing the stored files behind them. */
const linksOf = (row: Record<string, unknown> | null, fields: readonly string[]): string[] =>
  row ? fields.flatMap((field) => { const value = row[field]; return Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string') : typeof value === 'string' ? [value] : []; }) : [];

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
        employeeProfile: { select: { id: true } },
      },
    });
    if (!user) return null;
    // `PrintPartner.userId` carries no relation on User; the shop is found by the column.
    const printPartner = await prisma.printPartner.findUnique({ where: { userId }, select: { id: true } });
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
      printPartnerId: printPartner?.id ?? null,
      employeeId: user.employeeProfile?.id ?? null,
    };
  },

  async closeUser(userId, data) {
    await prisma.user.update({
      where: { id: userId },
      // Account lifecycle (2 Oct 2026): sign-in off as well — a person with no
      // profile to suspend (a print shop, an employee) has no BLOCK_SIGNIN to do it.
      data: { closedAt: data.at, closeReason: data.reason, closedById: data.byUserId, isActive: false },
    });
  },

  async countOpenPrintWork(printPartnerId) {
    const [jobs, quotes] = await Promise.all([
      prisma.printJob.findMany({ where: { printPartnerId, status: { notIn: ['COLLECTED', 'CANCELLED'] } }, select: { id: true } }),
      prisma.printQuote.count({ where: { printPartnerId, status: 'SUBMITTED' } }),
    ]);
    return { jobs: jobs.map((job) => job.id), quotes };
  },

  async retirePrintPartner(printPartnerId) {
    await prisma.printPartner.update({ where: { id: printPartnerId }, data: { isActive: false, acceptsQuoteRequests: false } });
  },

  async deactivateEmployee(employeeId) {
    await prisma.employee.update({ where: { id: employeeId }, data: { isActive: false } });
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
      // Account lifecycle (2 Oct 2026): the links whose stored files go with the erasure, beside the uploader's own.
      const fileUrls: string[] = [];
      await tx.user.update({
        where: { id: plan.userId },
        data: {
          name: 'Erased user',
          email: null,
          mobile: plan.userMobile,
          avatarUrl: null,
          passwordHash: null,
          // Account lifecycle: the person's own name, birth date and gender, and the moment.
          firstName: null,
          lastName: null,
          dateOfBirth: null,
          gender: null,
          erasedAt: plan.erasedAt ?? new Date(),
        },
      });
      profilesAnonymised.push('User');
      // The extra emails and numbers beside the sign-in pair are the person's too.
      const contacts = await tx.userContact.deleteMany({ where: { userId: plan.userId } });
      if (contacts.count > 0) profilesAnonymised.push('UserContact');

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
            // Account lifecycle: where the address was.
            latitude: null,
            longitude: null,
            postalCode: null,
          },
        });
        profilesAnonymised.push('Publisher');

        const kyc = await tx.publisherKyc.findUnique({
          where: { publisherId: plan.publisher.id },
        });
        fileUrls.push(...linksOf(kyc, PUBLISHER_KYC_URL_FIELDS));
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
            // Account lifecycle: the rest of the billing address.
            postalCode: null,
            country: null,
          },
        });
        profilesAnonymised.push('Advertiser');
      }

      // AdvertiserKyc is keyed by User.id, not by Advertiser.id -- see the
      // relation on the model. It can exist before the Advertiser profile
      // does, so it is handled on its own rather than inside the block above.
      // Account lifecycle: N3-B keys the record by the profile too — found by either.
      const advertiserKyc = await tx.advertiserKyc.findFirst({
        where: { OR: [{ advertiserId: plan.advertiserKycUserId }, ...(plan.advertiser ? [{ advertiserProfileId: plan.advertiser.id }] : [])] },
      });
      if (advertiserKyc) {
        fileUrls.push(...linksOf(advertiserKyc, ADVERTISER_KYC_URL_FIELDS));
        await tx.advertiserKyc.update({
          where: { id: advertiserKyc.id },
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
          data: {
            businessName: null,
            city: null,
            cityId: null, // Lot X-B: the key goes with the typed city
            state: null,
            territory: null,
            homeZone: null,
            // Account lifecycle (2 Oct 2026): where they live, who to call, what they drive.
            currentAddress: null,
            currentLatitude: null,
            currentLongitude: null,
            currentPostalCode: null,
            permanentAddress: null,
            emergencyContactName: null,
            emergencyContactRelation: null,
            emergencyContactPhone: null,
            vehicleNumber: null,
          },
        });
        profilesAnonymised.push('AgentProfile');

        // The application's papers: the rows go, and the stored files with them.
        const documents = await tx.agentDocument.findMany({ where: { agentId: plan.agentProfileId }, select: { url: true } });
        fileUrls.push(...documents.map((document) => document.url));
        if (documents.length > 0) {
          await tx.agentDocument.deleteMany({ where: { agentId: plan.agentProfileId } });
          kycRecordsMasked.push('AgentDocument');
        }

        const agentKyc = await tx.agentKyc.findUnique({
          where: { agentId: plan.agentProfileId },
        });
        if (agentKyc) {
          fileUrls.push(...linksOf(agentKyc, AGENT_KYC_URL_FIELDS));
          await tx.agentKyc.update({
            where: { agentId: plan.agentProfileId },
            // The README always said so: the webhook body is the identity document as Digio read it.
            data: { ...blank(AGENT_KYC_URL_FIELDS), panNumber: maskPan(agentKyc.panNumber), digioPayload: Prisma.DbNull },
          });
          kycRecordsMasked.push('AgentKyc');
        }
      }

      // Account lifecycle (2 Oct 2026): the print shop — its contact, its address, its papers.
      if (plan.printPartnerId) {
        await tx.printPartner.update({
          where: { id: plan.printPartnerId },
          data: {
            name: 'ERASED',
            legalName: null,
            contactName: null,
            mobile: plan.userMobile,
            email: null,
            gstin: null,
            panNumber: null,
            address: null,
            city: null,
            cityId: null,
            state: null,
            postalCode: null,
            latitude: null,
            longitude: null,
            notes: null,
          },
        });
        profilesAnonymised.push('PrintPartner');
        const partnerKyc = await tx.printPartnerKyc.findUnique({ where: { printPartnerId: plan.printPartnerId } });
        if (partnerKyc) {
          fileUrls.push(...linksOf(partnerKyc, PRINT_PARTNER_KYC_URL_FIELDS));
          await tx.printPartnerKyc.update({
            where: { printPartnerId: plan.printPartnerId },
            data: { ...blank(PRINT_PARTNER_KYC_URL_FIELDS), panNumber: maskPan(partnerKyc.panNumber), digioPayload: Prisma.DbNull },
          });
          kycRecordsMasked.push('PrintPartnerKyc');
        }
      }

      // Account lifecycle: the HR record's papers and its KYC links.
      if (plan.employeeId) {
        const employee = await tx.employee.findUnique({ where: { id: plan.employeeId } });
        fileUrls.push(...linksOf(employee, [...EMPLOYEE_URL_FIELDS, ...EMPLOYEE_URL_LIST_FIELDS]));
        await tx.employee.update({
          where: { id: plan.employeeId },
          data: { ...blank(EMPLOYEE_URL_FIELDS), ...Object.fromEntries(EMPLOYEE_URL_LIST_FIELDS.map((field) => [field, []])) },
        });
        profilesAnonymised.push('Employee');
        const employeeKyc = await tx.employeeKyc.findUnique({ where: { employeeId: plan.employeeId } });
        if (employeeKyc) {
          fileUrls.push(...linksOf(employeeKyc, EMPLOYEE_KYC_URL_FIELDS));
          await tx.employeeKyc.update({
            where: { employeeId: plan.employeeId },
            data: { ...blank(EMPLOYEE_KYC_URL_FIELDS), panNumber: maskPan(employeeKyc.panNumber), digioPayload: Prisma.DbNull },
          });
          kycRecordsMasked.push('EmployeeKyc');
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
        where: {
          OR: [
            { userId: plan.userId, purpose: { in: ERASABLE_PURPOSES } },
            // Account lifecycle (2 Oct 2026): papers the desk or an agent uploaded for the person, and every link blanked above.
            { ownerUserId: plan.userId, purpose: { in: ERASABLE_PURPOSES } },
            ...(fileUrls.length > 0 ? [{ url: { in: [...new Set(fileUrls)] } }] : []),
          ],
        },
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
