import { prisma } from '../../shared/database';
import type {
  NewSuspensionEvent,
  PartyRow,
  PartyType,
  ScopePatch,
  SuspensionRepository,
} from './suspension.repository';

/**
 * The suspension columns, read and written in one place.
 *
 * Four tables carry the same five columns, so every read is normalised to
 * `PartyRow` here and the service never branches on which table it came from
 * except where the consequence genuinely differs.
 */

const empty = {
  status: null,
  publisherId: null,
  publishedAt: null,
  verificationExpiresAt: null,
};

async function findListing(id: string): Promise<PartyRow | null> {
  const row = await prisma.listing.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      status: true,
      publisherId: true,
      publishedAt: true,
      verificationExpiresAt: true,
      suspensionScopes: true,
      suspendedAt: true,
      suspensionReason: true,
      suspendedById: true,
      publisher: { select: { userId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    scopes: row.suspensionScopes,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason,
    suspendedById: row.suspendedById,
    userId: row.publisher?.userId ?? null,
    status: row.status,
    publisherId: row.publisherId,
    publishedAt: row.publishedAt,
    verificationExpiresAt: row.verificationExpiresAt,
    name: row.title,
  };
}

async function findPublisher(id: string): Promise<PartyRow | null> {
  const row = await prisma.publisher.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      userId: true,
      suspensionScopes: true,
      suspendedAt: true,
      suspensionReason: true,
      suspendedById: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    scopes: row.suspensionScopes,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason,
    suspendedById: row.suspendedById,
    userId: row.userId,
    name: row.name,
    ...empty,
  };
}

async function findAdvertiser(id: string): Promise<PartyRow | null> {
  const row = await prisma.advertiser.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      userId: true,
      suspensionScopes: true,
      suspendedAt: true,
      suspensionReason: true,
      suspendedById: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    scopes: row.suspensionScopes,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason,
    suspendedById: row.suspendedById,
    userId: row.userId,
    name: row.name,
    ...empty,
  };
}

async function findAgent(id: string): Promise<PartyRow | null> {
  const row = await prisma.agentProfile.findUnique({
    where: { id },
    select: {
      id: true,
      displayId: true,
      userId: true,
      status: true,
      suspensionScopes: true,
      suspendedAt: true,
      suspensionReason: true,
      suspendedById: true,
      user: { select: { name: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    scopes: row.suspensionScopes,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason,
    suspendedById: row.suspendedById,
    userId: row.userId,
    status: row.status,
    publisherId: null,
    publishedAt: null,
    verificationExpiresAt: null,
    name: row.user?.name ?? row.displayId,
  };
}

export const prismaSuspensionRepository: SuspensionRepository = {
  findParty(partyType: PartyType, partyId: string) {
    switch (partyType) {
      case 'LISTING':
        return findListing(partyId);
      case 'PUBLISHER':
        return findPublisher(partyId);
      case 'ADVERTISER':
        return findAdvertiser(partyId);
      case 'AGENT':
        return findAgent(partyId);
    }
  },

  async setScopes(partyType: PartyType, partyId: string, patch: ScopePatch) {
    const data = {
      suspensionScopes: { set: patch.scopes },
      suspendedAt: patch.suspendedAt,
      suspensionReason: patch.suspensionReason,
      suspendedById: patch.suspendedById,
    };
    switch (partyType) {
      case 'LISTING':
        await prisma.listing.update({ where: { id: partyId }, data });
        return;
      case 'PUBLISHER':
        await prisma.publisher.update({ where: { id: partyId }, data });
        return;
      case 'ADVERTISER':
        await prisma.advertiser.update({ where: { id: partyId }, data });
        return;
      case 'AGENT':
        await prisma.agentProfile.update({ where: { id: partyId }, data });
        return;
    }
  },

  async setListingStatus(listingId: string, status: 'ACTIVE' | 'SUSPENDED') {
    await prisma.listing.update({ where: { id: listingId }, data: { status } });
  },

  async setAgentStatus(agentId: string, status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED') {
    await prisma.agentProfile.update({ where: { id: agentId }, data: { status } });
  },

  async setUserActive(userId: string, isActive: boolean) {
    await prisma.user.update({ where: { id: userId }, data: { isActive } });
  },

  async listingsForPublisher(publisherId: string) {
    const rows = await prisma.listing.findMany({
      where: { publisherId },
      select: { id: true, title: true, status: true, suspensionScopes: true },
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scopes: row.suspensionScopes,
    }));
  },

  createEvent(input: NewSuspensionEvent) {
    return prisma.partySuspensionEvent.create({
      data: {
        partyType: input.partyType,
        partyId: input.partyId,
        action: input.action,
        scopes: input.scopes,
        reason: input.reason,
        byUserId: input.byUserId,
        ...(input.at ? { at: input.at } : {}),
      },
    });
  },

  listEvents(partyType: PartyType, partyId: string, limit: number) {
    return prisma.partySuspensionEvent.findMany({
      where: { partyType, partyId },
      orderBy: { at: 'desc' },
      take: limit,
    });
  },
};
