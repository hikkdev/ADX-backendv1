import { prisma } from '../../shared/database';
import type { PartyType } from '../../shared/database';
import type {
  IdentifierFormatPatch,
  IdentifiersRepository,
  NewIdentifierFormat,
} from './identifiers.repository';

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

  async setPublisherIdentifier(publisherId: string, displayId: string) {
    await prisma.publisher.update({ where: { id: publisherId }, data: { displayId } });
  },
};
