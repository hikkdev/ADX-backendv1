import { prisma } from '../../shared/database';
import type { PartyType } from '../../shared/database';
import type {
  IdentifiedParty,
  IdentifierFormatPatch,
  IdentifiersRepository,
  MissingIdentifierSummary,
  NewIdentifierFormat,
} from './identifiers.repository';

/** One aggregate per table: how many rows lack an identifier, and when the oldest and newest of them were made. */
const MISSING = {
  where: { displayId: null },
  _count: { _all: true },
  _min: { createdAt: true },
  _max: { createdAt: true },
} as const;

function summaryOf(row: {
  _count: { _all: number };
  _min: { createdAt: Date | null };
  _max: { createdAt: Date | null };
}): MissingIdentifierSummary {
  return { count: row._count._all, oldest: row._min.createdAt, newest: row._max.createdAt };
}

export const prismaIdentifiersRepository: IdentifiersRepository = {
  findFormat(party: PartyType) {
    return prisma.identifierFormat.findUnique({ where: { party } });
  },

  listFormats() {
    return prisma.identifierFormat.findMany({ orderBy: { party: 'asc' } });
  },

  createFormat(data: NewIdentifierFormat) {
    // upsert rather than create: two first-ever allocations for the same party
    // can race, and the loser should read the winner's row rather than fail.
    return prisma.identifierFormat.upsert({
      where: { party: data.party },
      create: data,
      update: {},
    });
  },

  updateFormat(party: PartyType, patch: IdentifierFormatPatch) {
    return prisma.identifierFormat.update({ where: { party }, data: patch });
  },

  /**
   * INSERT ... ON CONFLICT DO UPDATE, so the increment happens inside the
   * database and concurrent callers are serialised there.
   *
   * The row stores the *next* value, so a fresh day is created holding 2 and
   * hands back 1; an existing day increments and hands back what it held.
   */
  async nextSequence(party: PartyType, dateKey: string) {
    const row = await prisma.identifierCounter.upsert({
      where: { party_dateKey: { party, dateKey } },
      create: { party, dateKey, next: 2 },
      update: { next: { increment: 1 } },
      select: { next: true },
    });
    return row.next - 1;
  },

  publishersMissingIdentifier(limit: number) {
    return prisma.publisher.findMany({
      where: { displayId: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, createdAt: true },
    });
  },

  usersMissingIdentifier(limit: number) {
    return prisma.user.findMany({
      where: { displayId: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, createdAt: true },
    });
  },

  async setUserIdentifier(userId: string, displayId: string) {
    await prisma.user.update({ where: { id: userId }, data: { displayId } });
  },

  ordersMissingIdentifier(limit: number) {
    return prisma.order.findMany({ where: { displayId: null }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, createdAt: true } });
  },

  async setOrderIdentifier(orderId: string, displayId: string) {
    await prisma.order.update({ where: { id: orderId }, data: { displayId } });
  },

  async setPublisherIdentifier(publisherId: string, displayId: string) {
    await prisma.publisher.update({ where: { id: publisherId }, data: { displayId } });
  },

  advertisersMissingIdentifier(limit: number) {
    return prisma.advertiser.findMany({ where: { displayId: null }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, createdAt: true } });
  },

  async setAdvertiserIdentifier(advertiserId: string, displayId: string) {
    await prisma.advertiser.update({ where: { id: advertiserId }, data: { displayId } });
  },

  printPartnersMissingIdentifier(limit: number) {
    return prisma.printPartner.findMany({ where: { displayId: null }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, createdAt: true } });
  },

  async setPrintPartnerIdentifier(printPartnerId: string, displayId: string) {
    await prisma.printPartner.update({ where: { id: printPartnerId }, data: { displayId } });
  },

  agentsMissingIdentifier(limit: number) {
    return prisma.agentProfile.findMany({ where: { displayId: null }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, createdAt: true } });
  },

  async setAgentIdentifier(agentProfileId: string, displayId: string) {
    await prisma.agentProfile.update({ where: { id: agentProfileId }, data: { displayId } });
  },

  async missingIdentifierSummary(party: IdentifiedParty) {
    switch (party) {
      case 'PUBLISHER': return summaryOf(await prisma.publisher.aggregate(MISSING));
      case 'ADVERTISER': return summaryOf(await prisma.advertiser.aggregate(MISSING));
      case 'PARTNER': return summaryOf(await prisma.printPartner.aggregate(MISSING));
      case 'AGENT': return summaryOf(await prisma.agentProfile.aggregate(MISSING));
      case 'USER': return summaryOf(await prisma.user.aggregate(MISSING));
    }
  },
};
