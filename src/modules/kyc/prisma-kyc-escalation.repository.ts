import { prisma } from '../../shared/database';
import type { AdvertiserKyc, PrintPartnerKyc, PublisherKyc } from '../../shared/database';
import type { EscalatableCase, EscalationStamp, KycEscalationParty, KycEscalationRepository } from './escalation.repository';

/**
 * Lot G (Q127/142): the escalation columns on both KYC rows, read and
 * written from one place. `PublisherKyc` belongs to `publishers` (which
 * imports this module, so this module cannot import it back); the five
 * escalation columns are the same on both tables and are written only here
 * and by each desk's decision (which clears them).
 */

const publisherJoin = { publisher: { select: { id: true, name: true, userId: true } } } as const;

function fromPublisher(row: PublisherKyc & { publisher: { id: string; name: string; userId: string | null } }): EscalatableCase {
  return {
    party: 'PUBLISHER',
    kycId: row.id,
    partyId: row.publisher.id,
    partyName: row.publisher.name,
    userId: row.publisher.userId,
    status: row.status,
    submittedAt: row.submittedAt,
    assignedToId: row.assignedToId,
    escalatedAt: row.escalatedAt,
    escalationSource: row.escalationSource,
    escalationReason: row.escalationReason,
    escalatedToUserId: row.escalatedToUserId,
    escalatedById: row.escalatedById,
    targetType: 'Publisher',
    targetId: row.publisher.id,
  };
}

/* N3-B: the record is keyed by the Advertiser profile; the user (the legacy key) rides along when the profile has one. */
const advertiserJoin = {
  profile: { select: { id: true, name: true, companyName: true, userId: true } },
  advertiser: { select: { id: true, name: true } },
} as const;

type AdvertiserJoinRow = AdvertiserKyc & {
  profile: { id: string; name: string; companyName: string | null; userId: string | null } | null;
  advertiser: { id: string; name: string | null } | null;
};

function fromAdvertiser(row: AdvertiserJoinRow): EscalatableCase {
  return {
    party: 'ADVERTISER',
    kycId: row.id,
    // The party is the profile; a legacy row with no profile key names its user; a row with neither names itself.
    partyId: row.profile?.id ?? row.advertiserId ?? row.id,
    partyName: row.profile?.companyName ?? row.profile?.name ?? row.advertiser?.name ?? null,
    userId: row.advertiserId ?? row.profile?.userId ?? null,
    status: row.status,
    submittedAt: row.submittedAt,
    assignedToId: row.assignedToId,
    escalatedAt: row.escalatedAt,
    escalationSource: row.escalationSource,
    escalationReason: row.escalationReason,
    escalatedToUserId: row.escalatedToUserId,
    escalatedById: row.escalatedById,
    targetType: 'AdvertiserKyc',
    targetId: row.id,
  };
}

/* Lot N: the print partner's row — `PrintPartnerKyc` belongs to `print-partners`, which imports this module; the five columns are the same. */
const printPartnerJoin = { printPartner: { select: { id: true, name: true, userId: true } } } as const;

function fromPrintPartner(row: PrintPartnerKyc & { printPartner: { id: string; name: string; userId: string } }): EscalatableCase {
  return {
    party: 'PRINT_PARTNER',
    kycId: row.id,
    partyId: row.printPartner.id,
    partyName: row.printPartner.name,
    userId: row.printPartner.userId,
    status: row.status,
    submittedAt: row.submittedAt,
    assignedToId: row.assignedToId,
    escalatedAt: row.escalatedAt,
    escalationSource: row.escalationSource,
    escalationReason: row.escalationReason,
    escalatedToUserId: row.escalatedToUserId,
    escalatedById: row.escalatedById,
    targetType: 'PrintPartnerKyc',
    targetId: row.id,
  };
}

export const prismaKycEscalationRepository: KycEscalationRepository = {
  async findPublisherCase(publisherId) {
    const row = await prisma.publisherKyc.findUnique({ where: { publisherId }, include: publisherJoin });
    return row ? fromPublisher(row) : null;
  },

  async findPublisherCaseByListing(listingId) {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { publisherId: true } });
    return listing?.publisherId ? this.findPublisherCase(listing.publisherId) : null;
  },

  async findAdvertiserCaseById(kycId) {
    const row = await prisma.advertiserKyc.findUnique({ where: { id: kycId }, include: advertiserJoin });
    return row ? fromAdvertiser(row) : null;
  },

  async findAdvertiserCaseByAdvertiserId(advertiserId) {
    // N3-B: by the profile first; a legacy row is still keyed by the profile's user.
    const byProfile = await prisma.advertiserKyc.findUnique({ where: { advertiserProfileId: advertiserId }, include: advertiserJoin });
    if (byProfile) return fromAdvertiser(byProfile);
    const advertiser = await prisma.advertiser.findUnique({ where: { id: advertiserId }, select: { userId: true } });
    if (!advertiser?.userId) return null;
    const row = await prisma.advertiserKyc.findUnique({ where: { advertiserId: advertiser.userId }, include: advertiserJoin });
    return row ? fromAdvertiser(row) : null;
  },

  async findPrintPartnerCaseById(kycId) {
    const row = await prisma.printPartnerKyc.findUnique({ where: { id: kycId }, include: printPartnerJoin });
    return row ? fromPrintPartner(row) : null;
  },

  async markEscalated(party: KycEscalationParty, kycId: string, stamp: EscalationStamp) {
    if (party === 'PUBLISHER') await prisma.publisherKyc.update({ where: { id: kycId }, data: stamp });
    else if (party === 'PRINT_PARTNER') await prisma.printPartnerKyc.update({ where: { id: kycId }, data: stamp });
    else await prisma.advertiserKyc.update({ where: { id: kycId }, data: stamp });
  },

  async findAgedPending(party, cutoff, limit) {
    const where = { status: 'PENDING' as const, escalatedAt: null, submittedAt: { not: null, lt: cutoff } };
    if (party === 'PUBLISHER') {
      const rows = await prisma.publisherKyc.findMany({ where, include: publisherJoin, orderBy: { submittedAt: 'asc' }, take: limit });
      return rows.map(fromPublisher);
    }
    if (party === 'PRINT_PARTNER') {
      const rows = await prisma.printPartnerKyc.findMany({ where, include: printPartnerJoin, orderBy: { submittedAt: 'asc' }, take: limit });
      return rows.map(fromPrintPartner);
    }
    const rows = await prisma.advertiserKyc.findMany({ where, include: advertiserJoin, orderBy: { submittedAt: 'asc' }, take: limit });
    return rows.map(fromAdvertiser);
  },

  async adminUserIds() {
    const rows = await prisma.userRole.findMany({
      where: { role: 'ADMIN', user: { isActive: true, closedAt: null } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.userId);
  },
};
