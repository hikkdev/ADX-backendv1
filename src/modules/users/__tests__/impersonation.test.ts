import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A, Q27 — reading the platform as a party sees it.
 *
 * The read-only guarantee itself is pinned in shared/auth and in
 * tests/contract/impersonation.test.ts, which drives every write route. What
 * is pinned here is who may be read, for how long, and what the token says.
 */
const { repository } = vi.hoisted(() => ({
  repository: {
    findTarget: vi.fn(),
    start: vi.fn(),
    findById: vi.fn(),
    end: vi.fn(),
    listOpenFor: vi.fn(),
  },
}));

vi.mock('../impersonation/prisma-impersonation.repository', () => ({ prismaImpersonationRepository: repository }));
const users = vi.hoisted(() => ({ findUserSummaries: vi.fn(async () => new Map()) }));
vi.mock('../users.service', () => users);

import { IMPERSONATION_TOKEN_TTL_SECONDS, verifyAccessToken } from '../../../shared/auth';
import { endImpersonation, impersonateSchema, listOpenImpersonations, startImpersonation } from '../impersonation/impersonation.service';

const reason = 'Publisher says the payout screen shows zero; checking what they see.';

const target = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  name: 'Asha Rao',
  mobile: '+919845012210',
  isActive: true,
  roles: [{ role: 'PUBLISHER' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findTarget.mockResolvedValue(target());
  repository.start.mockImplementation(async (data: Record<string, unknown>) => ({
    id: 'imp_1',
    ...data,
    scope: 'READ',
    startedAt: new Date(),
    endedAt: null,
  }));
  repository.findById.mockResolvedValue({ id: 'imp_1', adminUserId: 'adm_1', targetUserId: 'pub_1', endedAt: null });
  repository.end.mockImplementation(async (id: string) => ({ id, adminUserId: 'adm_1', targetUserId: 'pub_1', endedAt: new Date() }));
});

describe('starting a session', () => {
  it('mints a fifteen-minute read token naming both people', async () => {
    const started = await startImpersonation('adm_1', 'pub_1', { reason });

    const claims = verifyAccessToken(started.accessToken);
    expect(claims.sub).toBe('pub_1');
    expect(claims.roles).toEqual(['PUBLISHER']);
    expect(claims.act).toEqual({ sub: 'adm_1', sessionId: 'imp_1' });
    expect(claims.scope).toBe('read');
    expect(claims.exp! - claims.iat!).toBe(IMPERSONATION_TOKEN_TTL_SECONDS);
    expect(started.scope).toBe('read');
    expect(repository.start).toHaveBeenCalledWith(expect.objectContaining({ adminUserId: 'adm_1', targetUserId: 'pub_1', reason }));
  });

  it('carries no permissions, whatever the admin holds', async () => {
    const started = await startImpersonation('adm_1', 'pub_1', { reason });
    expect(verifyAccessToken(started.accessToken).perms).toEqual([]);
  });

  it('refuses another admin, an inactive account, yourself, and somebody who does not exist', async () => {
    repository.findTarget.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }] }));
    await expect(startImpersonation('adm_1', 'adm_2', { reason })).rejects.toMatchObject({ statusCode: 403 });

    repository.findTarget.mockResolvedValue(target({ isActive: false }));
    await expect(startImpersonation('adm_1', 'pub_1', { reason })).rejects.toMatchObject({ statusCode: 409 });

    await expect(startImpersonation('adm_1', 'adm_1', { reason })).rejects.toMatchObject({ statusCode: 400 });

    repository.findTarget.mockResolvedValue(null);
    await expect(startImpersonation('adm_1', 'nobody', { reason })).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.start).not.toHaveBeenCalled();
  });

  it('insists on a reason somebody can read back later', () => {
    expect(impersonateSchema.safeParse({ reason: 'looking' }).success).toBe(false);
    expect(impersonateSchema.safeParse({ reason }).success).toBe(true);
  });
});

describe('ending one', () => {
  it('closes the row', async () => {
    const ended = await endImpersonation('adm_1', 'imp_1');
    expect(repository.end).toHaveBeenCalledWith('imp_1');
    expect(ended.endedAt).toBeInstanceOf(Date);
  });

  it('is only the admin who started it', async () => {
    await expect(endImpersonation('adm_2', 'imp_1')).rejects.toMatchObject({ statusCode: 403 });
    repository.findById.mockResolvedValue(null);
    await expect(endImpersonation('adm_1', 'imp_none')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('ending an already-ended session is not an error — the intent is satisfied', async () => {
    const endedAt = new Date('2026-09-12T09:00:00Z');
    repository.findById.mockResolvedValue({ id: 'imp_1', adminUserId: 'adm_1', targetUserId: 'pub_1', endedAt });
    await expect(endImpersonation('adm_1', 'imp_1')).resolves.toMatchObject({ endedAt });
    expect(repository.end).not.toHaveBeenCalled();
  });
});

describe('E7-3: the open sessions list', () => {
  it('names the person being read on every row, null when the account is gone', async () => {
    repository.listOpenFor.mockResolvedValue([
      { id: 'imp_1', adminUserId: 'adm_1', targetUserId: 'pub_1', reason, endedAt: null },
      { id: 'imp_2', adminUserId: 'adm_1', targetUserId: 'gone', reason, endedAt: null },
    ]);
    users.findUserSummaries.mockResolvedValue(
      new Map([['pub_1', { id: 'pub_1', name: 'Asha Rao', role: 'PUBLISHER', roles: ['PUBLISHER'] }]]) as never,
    );

    const rows = await listOpenImpersonations('adm_1');

    expect(users.findUserSummaries).toHaveBeenCalledWith(['pub_1', 'gone']);
    expect(rows[0]).toMatchObject({ id: 'imp_1', target: { id: 'pub_1', name: 'Asha Rao', role: 'PUBLISHER' } });
    expect(rows[1]).toMatchObject({ id: 'imp_2', target: null });
  });
});
