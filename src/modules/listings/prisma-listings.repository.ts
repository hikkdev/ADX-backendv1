import { prisma } from '../../shared/database';
import type { Listing } from '../../shared/database';
import type { ListingPatch, ListingsRepository, NewListing } from './listings.repository';

export const prismaListingsRepository: ListingsRepository = {
  create(data: NewListing) {
    const { photos, ...rest } = data;
    return prisma.listing.create({
      data: { ...rest, photos: photos?.length ? { create: photos } : undefined },
      include: { photos: true },
    });
  },

  findForPublisher(publisherId: string) {
    return prisma.listing.findMany({
      where: { publisherId },
      include: { photos: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  findAllForAdmin() {
    // The admin listing joins publisher and agent; the per-publisher one does
    // not. Both shapes are contract.
    return prisma.listing.findMany({
      include: { publisher: true, agent: true, photos: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  findById(listingId: string) {
    return prisma.listing.findUnique({ where: { id: listingId } });
  },

  update(listingId: string, data: ListingPatch) {
    return prisma.listing.update({ where: { id: listingId }, data, include: { photos: true } });
  },

  publish(listingId: string) {
    return prisma.listing.update({
      where: { id: listingId },
      data: { status: 'ACTIVE', publishedAt: new Date() },
      include: { photos: true },
    });
  },

  findSimilar(listing: Listing) {
    return prisma.listing.findMany({
      where: {
        id: { not: listing.id },
        city: listing.city ?? undefined,
        category: listing.category,
        status: 'ACTIVE',
        monthlyPrice: { gte: listing.monthlyPrice * 0.7, lte: listing.monthlyPrice * 1.3 },
      },
      orderBy: { monthlyPrice: 'asc' },
      take: 5,
    });
  },

  findWithPublisher(listingId: string) {
    return prisma.listing.findUnique({
      where: { id: listingId },
      include: { publisher: { include: { user: true } } },
    }) as never;
  },

  setAvailability(listingId: string, availableNow: boolean) {
    return prisma.listing.update({ where: { id: listingId }, data: { availableNow } });
  },

  async agentExists(agentId: string) {
    return (await prisma.agentProfile.findUnique({ where: { id: agentId } })) !== null;
  },
};
