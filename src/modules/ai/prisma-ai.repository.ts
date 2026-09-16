import { prisma } from '../../shared/database';
import type {
  AiRepository,
  CachedTranslation,
  NewGeneration,
  NewTranslation,
} from './ai.repository';

export const prismaAiRepository: AiRepository = {
  countGenerations(publisherId: string, subjectKey: string) {
    return prisma.aiGeneration.count({ where: { publisherId, subjectKey } });
  },

  countAdvertiserGenerations(advertiserId: string, subjectKey: string) {
    return prisma.aiGeneration.count({ where: { advertiserId, subjectKey } });
  },

  async recordGeneration(data: NewGeneration) {
    await prisma.aiGeneration.create({ data: { ...data, advertiserId: data.advertiserId ?? null } });
  },

  async hasActivePlan(advertiserId: string) {
    const found = await prisma.packageSale.findFirst({ where: { advertiserId, status: 'ACTIVE' }, select: { id: true } });
    return found !== null;
  },

  async hasActiveSubscription(publisherId: string) {
    // Running means started and not yet ended. `endsAt` is null while it runs
    // and set when it lapses, so a lapsed subscription with a future end date
    // is not a case this has to handle.
    const now = new Date();
    const found = await prisma.publisherSubscription.findFirst({
      where: {
        publisherId,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { id: true },
    });
    return found !== null;
  },

  async findPublisherIdByUserId(userId: string) {
    const publisher = await prisma.publisher.findFirst({
      where: { userId },
      select: { id: true },
    });
    return publisher?.id ?? null;
  },

  async listingBelongsTo(listingId: string, publisherId: string) {
    const listing = await prisma.listing.findFirst({
      where: { id: listingId, publisherId },
      select: { id: true },
    });
    return listing !== null;
  },

  async findTranslations(sourceHashes: string[], targetLang: string) {
    if (sourceHashes.length === 0) return new Map();
    const rows = await prisma.translation.findMany({
      where: { sourceHash: { in: sourceHashes }, targetLang },
      select: { sourceHash: true, text: true, sourceLang: true },
    });
    return new Map<string, CachedTranslation>(
      rows.map((row) => [row.sourceHash, { text: row.text, sourceLang: row.sourceLang }])
    );
  },

  async saveTranslation(data: NewTranslation) {
    // Two readers can miss the cache on the same string at once; the second
    // write is the same text and losing it costs nothing.
    await prisma.translation.upsert({
      where: { sourceHash_targetLang: { sourceHash: data.sourceHash, targetLang: data.targetLang } },
      update: {},
      create: data,
    });
  },

  async findUserLanguage(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { language: true },
    });
    return user?.language ?? null;
  },
};
