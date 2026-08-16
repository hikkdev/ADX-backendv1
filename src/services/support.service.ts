import { prisma } from '../lib/prisma';

export async function getTickets(
  userId: string,
  opts: { limit?: number; offset?: number; status?: string; search?: string } = {},
) {
  const { limit = 50, offset = 0, status, search } = opts;
  return prisma.supportTicket.findMany({
    where: {
      userId,
      ...(status ? { status: status as any } : {}),
      ...(search
        ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }] }
        : {}),
    },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function getTicketById(ticketId: string) {
  return prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function createTicket(data: {
  userId: string;
  title: string;
  description: string;
  category?: string;
  relatedOrderId?: string;
}) {
  return prisma.supportTicket.create({
    data,
    include: { messages: true },
  });
}

export async function addReply(data: {
  ticketId: string;
  authorId: string;
  authorName: string;
  message: string;
}) {
  const [message] = await prisma.$transaction([
    prisma.ticketMessage.create({ data }),
    prisma.supportTicket.update({
      where: { id: data.ticketId },
      data: { updatedAt: new Date() },
    }),
  ]);
  return message;
}

export async function closeTicket(ticketId: string) {
  return prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED' } });
}

export async function reopenTicket(ticketId: string) {
  return prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'OPEN' } });
}
