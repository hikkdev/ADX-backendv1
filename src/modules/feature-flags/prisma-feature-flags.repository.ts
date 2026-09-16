import { Prisma, prisma } from '../../shared/database';
import type { FeatureFlagsRepository, FlagPosition, FlagWriteInput } from './feature-flags.repository';

const LAST_CHANGE = { changes: { orderBy: { at: 'desc' as const }, take: 1 } };

/** A nullable Json column takes DbNull, not null — Prisma's one wrinkle here. */
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function position(next: FlagPosition) {
  return {
    enabled: next.enabled,
    rolloutPercent: next.rolloutPercent,
    variant: next.variant,
    rollout: json(next.rollout),
  };
}

export const prismaFeatureFlagsRepository: FeatureFlagsRepository = {
  list() {
    return prisma.featureFlag.findMany({ orderBy: { key: 'asc' }, include: LAST_CHANGE });
  },

  listState() {
    return prisma.featureFlag.findMany({
      select: {
        key: true,
        enabled: true,
        rolloutPercent: true,
        variant: true,
        variants: true,
        rollout: true,
        surfaces: true,
        source: true,
      },
      orderBy: { key: 'asc' },
    });
  },

  find(key: string) {
    return prisma.featureFlag.findUnique({ where: { key } });
  },

  async update(key, next, change) {
    // One transaction: the switch and the row saying who moved it are the
    // same fact, and a flag that flipped with no author is what the change
    // table exists to prevent.
    const [flag] = await prisma.$transaction([
      prisma.featureFlag.update({
        where: { key },
        data: {
          ...position(next),
          lastGoodState: next.lastGoodState as unknown as Prisma.InputJsonValue,
          updatedById: change.byUserId,
        },
        include: LAST_CHANGE,
      }),
      prisma.featureFlagChange.create({
        data: {
          flagKey: key,
          ...position(next),
          byUserId: change.byUserId,
          note: change.note,
          rollbackOfId: change.rollbackOfId,
        },
      }),
    ]);
    // Re-read so the returned row carries the change just written rather than
    // the one before it.
    return (await prisma.featureFlag.findUnique({ where: { key }, include: LAST_CHANGE })) ?? flag;
  },

  async updateMany(writes: FlagWriteInput[]) {
    if (writes.length === 0) return [];
    // L-B: the whole batch is one transaction — a bulk move where half the
    // keys landed is worse than one that did not, because the console would
    // then show a position nobody asked for and no single change to undo.
    return prisma.$transaction(async (tx) => {
      const out = [];
      for (const { key, next, change } of writes) {
        await tx.featureFlag.update({
          where: { key },
          data: {
            ...position(next),
            lastGoodState: next.lastGoodState as unknown as Prisma.InputJsonValue,
            updatedById: change.byUserId,
          },
        });
        await tx.featureFlagChange.create({
          data: {
            flagKey: key,
            ...position(next),
            byUserId: change.byUserId,
            note: change.note,
            rollbackOfId: change.rollbackOfId,
          },
        });
        // Re-read inside the transaction so the row carries the change just written.
        out.push(await tx.featureFlag.findUniqueOrThrow({ where: { key }, include: LAST_CHANGE }));
      }
      return out;
    });
  },

  changes(key: string, limit: number) {
    return prisma.featureFlagChange.findMany({
      where: { flagKey: key },
      orderBy: { at: 'desc' },
      take: limit,
    });
  },

  async createRegistered(input) {
    await prisma.featureFlag.create({
      data: {
        key: input.key,
        enabled: input.enabled,
        rolloutPercent: 100,
        description: input.description,
        surfaces: input.surfaces,
        kind: input.kind,
        source: 'REGISTERED',
        owner: input.owner,
        variants: input.variants,
        registeredAt: new Date(),
      },
    });
  },

  async updateRegistered(input) {
    await prisma.featureFlag.update({
      where: { key: input.key },
      data: {
        description: input.description,
        surfaces: input.surfaces,
        kind: input.kind,
        owner: input.owner,
        variants: input.variants,
      },
    });
    // `registeredAt` is stamped once: the first boot that saw the row as a
    // registered feature. A row that predates the column gets that day.
    await prisma.featureFlag.updateMany({ where: { key: input.key, registeredAt: null }, data: { registeredAt: new Date() } });
  },

  async foldLegacy(oldKey, newKey) {
    const old = await prisma.featureFlag.findUnique({ where: { key: oldKey } });
    if (!old) return false;
    await prisma.$transaction(async (tx) => {
      const existing = await tx.featureFlag.findUnique({ where: { key: newKey } });
      if (!existing) {
        await tx.featureFlag.create({
          data: {
            key: newKey,
            enabled: old.enabled,
            rolloutPercent: old.rolloutPercent,
            description: old.description,
            updatedById: old.updatedById,
            variant: old.variant,
            rollout: json(old.rollout),
            lastGoodState: json(old.lastGoodState),
            createdAt: old.createdAt,
          },
        });
      }
      await tx.featureFlagChange.updateMany({ where: { flagKey: oldKey }, data: { flagKey: newKey } });
      await tx.featureFlag.delete({ where: { key: oldKey } });
    });
    return true;
  },
};
