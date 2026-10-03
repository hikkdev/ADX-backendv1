import { describe, expect, it, vi } from 'vitest';

/**
 * 2 Oct 2026 — the console's Access grants page listed two grants as Open
 * eleven days after their windows ended, with the agent shown as a raw id.
 * Nothing flips an ended grant to EXPIRED (the gate reads `expiresAt`
 * itself), so the open list must read the window too; and the read carries
 * the names a screen needs — the agent's and the advertiser's, not only the
 * publisher's.
 */

const prisma = vi.hoisted(() => ({ delegatedAccessGrant: { findMany: vi.fn(async (_args: unknown) => [] as unknown[]) } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAccessGrantsRepository as repository } from '../prisma-access-grants.repository';

describe('the open grants', () => {
  it('are the pending and active ones whose window has not ended (or has none yet)', async () => {
    const before = Date.now();
    await repository.listOpen();
    const args = prisma.delegatedAccessGrant.findMany.mock.calls[0]![0] as unknown as {
      where: { status: { in: string[] }; OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }] };
    };
    expect(args.where.status).toEqual({ in: ['PENDING', 'ACTIVE'] });
    expect(args.where.OR[0]).toEqual({ expiresAt: null });
    expect(args.where.OR[1].expiresAt.gt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('carry the agent’s name and id and the advertiser’s name beside the publisher’s', async () => {
    await repository.listOpen();
    const args = prisma.delegatedAccessGrant.findMany.mock.calls[prisma.delegatedAccessGrant.findMany.mock.calls.length - 1]![0] as unknown as { include: Record<string, { select: Record<string, unknown> }> };
    expect(args.include['assignedAgent']!.select).toMatchObject({ displayId: true, user: { select: { name: true } } });
    expect(args.include['advertiser']!.select).toMatchObject({ name: true });
    expect(args.include['publisher']!.select).toMatchObject({ name: true });
  });
});
