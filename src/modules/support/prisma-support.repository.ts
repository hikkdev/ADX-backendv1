import { prisma } from '../../shared/database';
import type { SupportRepository } from './support.repository';
import type { ListTicketsOptions, NewReply, NewTicket } from './support.types';

export const prismaSupportRepository: SupportRepository = {
  findManyForUser(userId: string, opts: ListTicketsOptions) {
    const { limit = 50, offset = 0, status, search } = opts;
    return prisma.supportTicket.findMany({
      where: {
        userId,
        ...(status ? { status: status as any } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
    });
  },

  findById(ticketId: string) {
    return prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  },

  findSummaryById(ticketId: string) {
    return prisma.supportTicket.findUnique({ where: { id: ticketId } });
  },

  create(data: NewTicket) {
    return prisma.supportTicket.create({ data, include: { messages: true } });
  },

  async addReply(data: NewReply) {
    // One transaction so a reply never lands without bumping updatedAt, which
    // is what the ticket list orders by.
    const [message] = await prisma.$transaction([
      prisma.ticketMessage.create({ data }),
      prisma.supportTicket.update({ where: { id: data.ticketId }, data: { updatedAt: new Date() } }),
    ]);
    return message;
  },

  setStatus(ticketId: string, status: 'OPEN' | 'CLOSED') {
    return prisma.supportTicket.update({ where: { id: ticketId }, data: { status } });
  },
};
