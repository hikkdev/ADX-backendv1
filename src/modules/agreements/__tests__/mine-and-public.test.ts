import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — two reads the website needed.
 *
 * `GET /agreements/mine`: the signed-in account's platform agreements — the
 * version accepted, when, and whether it is still the live one — across
 * every party profile the account holds. Per-deal kinds are not in it.
 *
 * `GET /legal/agreements/:kind`: the live text of a party-facing platform
 * agreement, signed out — `{ id, kind, version, title, body, activatedAt }`
 * and nothing more; the employee's and the print partner's documents, the
 * per-deal kinds, and an unknown kind are 404.
 */

const { repository } = vi.hoisted(() => ({
  repository: { partiesOfUser: vi.fn(), findPlatformAcceptance: vi.fn(), activeTemplate: vi.fn() },
}));

vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: repository }));
vi.mock('../../../shared/security', () => ({ publicReadLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { agreementRouter, publicAgreementRouter } from '../agreements.routes';
import { myAgreements, publicAgreement, PUBLIC_AGREEMENT_KINDS } from '../agreements.service';

const ACTIVATED = new Date('2026-09-01T00:00:00.000Z');
const ACCEPTED = new Date('2026-09-10T00:00:00.000Z');
const template = (kind: string, version: number, over: Record<string, unknown> = {}) => ({
  id: `tpl_${kind}_${version}`,
  kind,
  version,
  title: `${kind} v${version}`,
  body: '# Terms',
  isActive: true,
  activatedAt: ACTIVATED,
  requiresReacceptance: false,
  createdByUserId: 'usr_admin',
  changeNote: 'secret desk note',
  acceptanceCount: 42,
  ...over,
});

function app() {
  const instance = express();
  const api = Router();
  api.use('/agreements', agreementRouter);
  api.use('/legal/agreements', publicAgreementRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.partiesOfUser.mockResolvedValue({ publisherId: 'pub_1', advertiserId: 'adv_1', agentId: null });
  repository.activeTemplate.mockImplementation(async (kind: string) =>
    kind === 'PLATFORM' ? template('PLATFORM', 3) : kind === 'ADVERTISER_PLATFORM' ? template('ADVERTISER_PLATFORM', 2, { requiresReacceptance: true }) : null,
  );
  repository.findPlatformAcceptance.mockImplementation(async (kind: string, party: Record<string, string>) => {
    if (kind === 'PLATFORM' && party['publisherId'] === 'pub_1') return { templateVersion: 2, acceptedAt: ACCEPTED };
    if (kind === 'ADVERTISER_PLATFORM' && party['advertiserId'] === 'adv_1') return { templateVersion: 2, acceptedAt: ACCEPTED };
    return null;
  });
});

describe('GET /agreements/mine', () => {
  it('answers each platform kind the account accepted, current or outdated', async () => {
    const mine = await myAgreements('usr_1');
    expect(mine).toEqual([
      expect.objectContaining({ kind: 'PLATFORM', templateVersion: 2, acceptedAt: ACCEPTED, currentVersion: 3, current: false, requiresReacceptance: false }),
      expect.objectContaining({ kind: 'ADVERTISER_PLATFORM', templateVersion: 2, acceptedAt: ACCEPTED, currentVersion: 2, current: true, requiresReacceptance: true }),
    ]);
    // Only the platform kinds of the parties held; no per-deal kind is looked up.
    const looked = repository.findPlatformAcceptance.mock.calls.map(([kind]) => kind);
    expect(looked).toEqual(expect.arrayContaining(['PLATFORM', 'PUBLISHER_LICENCE', 'ADVERTISER_PLATFORM']));
    expect(looked).not.toContain('LISTING');
    expect(looked).not.toContain('AGENT_PUBLISHER_PLATFORM');
  });

  it('an account with no party answers an empty list', async () => {
    repository.partiesOfUser.mockResolvedValue({ publisherId: null, advertiserId: null, agentId: null });
    await expect(myAgreements('usr_2')).resolves.toEqual([]);
  });

  it('is a signed-in read — any party, no admin permission', async () => {
    const res = await request(app()).get('/api/v1/agreements/mine').set('Authorization', `Bearer ${tokenFor(['PUBLISHER', 'ADVERTISER'], 'usr_1')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(repository.partiesOfUser).toHaveBeenCalledWith('usr_1');
    expect((await request(app()).get('/api/v1/agreements/mine')).status).toBe(401);
  });
});

describe('GET /legal/agreements/:kind', () => {
  it('answers the live text signed out, and nothing private', async () => {
    const res = await request(app()).get('/api/v1/legal/agreements/PLATFORM');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'tpl_PLATFORM_3', kind: 'PLATFORM', version: 3, title: 'PLATFORM v3', body: '# Terms', activatedAt: ACTIVATED.toISOString() });
  });

  it('only the party-facing platform kinds are public', async () => {
    expect([...PUBLIC_AGREEMENT_KINDS].sort()).toEqual(['ADVERTISER_PLATFORM', 'AGENT_ADVERTISER_PLATFORM', 'AGENT_PUBLISHER_PLATFORM', 'PLATFORM', 'PUBLISHER_LICENCE']);
    for (const kind of ['EMPLOYEE_APPOINTMENT', 'PRINT_PARTNER_SERVICE', 'LISTING', 'JOB_TERMS', 'nonsense']) {
      await expect(publicAgreement(kind)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(repository.activeTemplate).not.toHaveBeenCalled();
  });

  it('404 NO_ACTIVE_TEMPLATE when nothing is published', async () => {
    const res = await request(app()).get('/api/v1/legal/agreements/AGENT_PUBLISHER_PLATFORM');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_ACTIVE_TEMPLATE');
  });
});
