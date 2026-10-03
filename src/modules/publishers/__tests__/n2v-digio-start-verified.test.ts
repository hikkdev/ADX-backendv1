import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2 verifier — a Digio start for a VERIFIED publisher (their own
 * `POST /publishers/me/kyc/digio`, the agent's
 * `POST /publishers/:publisherId/kyc/digio/initiate`) is 409
 * `KYC_ALREADY_VERIFIED` before Digio is asked, like every other submit
 * path (N2-B). The guard sits in `initiateDigioKyc` itself so every caller
 * is covered; the desk's request and restart already refused it upstream.
 *
 * Phase D (the owner, 1 Oct 2026): the start picks the Digio workflow from
 * the publisher's legal form — 409 `ENTITY_TYPE_REQUIRED` (nothing stored,
 * Digio not asked) when none is known and none was sent; the sent one is
 * stored and audited before the request; a political publisher runs the
 * "Other entities" workflow; a verified individual may verify again as a
 * business (the upgrade: the record and the mirror back to PENDING once
 * Digio has the request). And the webhook: a late or unknown status never
 * un-decides a record; unknown statuses are kept raw, not dropped.
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio, audit, env } = vi.hoisted(() => ({
  repository: {
    upsertDigioKyc: vi.fn<AnyFn>(),
    setEntityType: vi.fn<AnyFn>(),
    restartForUpgrade: vi.fn<AnyFn>(),
    findByRequestId: vi.fn<AnyFn>(),
    findByPublisherId: vi.fn<AnyFn>(),
    applyWebhook: vi.fn<AnyFn>(),
    findPublisherAgent: vi.fn<AnyFn>(),
  },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
  audit: { logActivity: vi.fn<AnyFn>(), auditDiff: (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after }) },
  env: { DIGIO_WEBHOOK_SECRET: 'digio-test-secret' } as Record<string, string>,
}));

vi.mock('../kyc/prisma-digio.repository', () => ({ prismaDigioRepository: repository }));
vi.mock('../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../../shared/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../config', () => ({ env }));
vi.mock('../publishers.service', () => ({ assertOwnedPublisher: vi.fn() }));

import { handleDigioWebhook, initiateDigioKyc, type DigioPublisher } from '../kyc/digio.service';
import { digioWebhookHandler } from '../kyc/digio.controller';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const individual: DigioPublisher = { id: 'pub_1', name: 'Asha Rao', email: null, mobile: '+919876543210', type: 'INDIVIDUAL', entityType: null, kycStatus: 'PENDING' };
const business: DigioPublisher = { ...individual, type: 'BUSINESS' };
const by = { byUserId: 'usr_1' };

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'kyc_1', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://digio/#kyc_1?token=tok', mock: false });
  repository.upsertDigioKyc.mockResolvedValue({ id: 'pkyc_1' });
  repository.findByPublisherId.mockResolvedValue(null);
});

describe('starting Digio on a verified publisher', () => {
  it('is 409 KYC_ALREADY_VERIFIED before Digio is asked or the row touched', async () => {
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'VERIFIED', method: 'MANUAL' });
    await expect(initiateDigioKyc(individual, by)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    // The mirror alone says so too (a legacy row with no record).
    repository.findByPublisherId.mockResolvedValue(null);
    await expect(initiateDigioKyc({ ...individual, kycStatus: 'VERIFIED' }, by)).rejects.toMatchObject({ code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.upsertDigioKyc).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
  });

  it('still opens a session with no row, or a row that is not verified', async () => {
    await expect(initiateDigioKyc(individual, by, NOW)).resolves.toMatchObject({ kycId: 'kyc_1' });
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'PENDING', method: 'DIGIO' });
    await expect(initiateDigioKyc(individual, by, NOW)).resolves.toMatchObject({ kycId: 'kyc_1' });
    expect(repository.upsertDigioKyc).toHaveBeenCalledTimes(2);
    expect(repository.upsertDigioKyc).toHaveBeenLastCalledWith('pub_1', { method: 'DIGIO', digioRequestId: 'kyc_1', digioReferenceId: `adx-pub_1-${NOW.getTime()}`, digioStatus: 'pending', submittedAt: NOW });
  });
});

describe('Phase D: the legal form at the start', () => {
  it('runs the workflow the legacy type settles, storing nothing', async () => {
    await initiateDigioKyc(individual, by, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ party: 'PUBLISHER', workflowKey: 'PUBLISHER.INDIVIDUAL', customerName: 'Asha Rao', customerEmail: '', customerMobile: '+919876543210' }));
    expect(repository.setEntityType).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('is 409 ENTITY_TYPE_REQUIRED with the options when the form is unknown and none was sent — nothing stored, Digio not asked', async () => {
    await expect(initiateDigioKyc(business, by, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ENTITY_TYPE_REQUIRED',
      details: { party: 'PUBLISHER', options: expect.arrayContaining([{ value: 'COMPANY', label: 'Company' }, { value: 'POLITICAL', label: 'Political party or candidate' }]) },
    });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
    expect(repository.upsertDigioKyc).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('stores the sent form and audits it, then asks Digio on that workflow', async () => {
    await initiateDigioKyc(business, { byUserId: 'usr_agent', entityType: 'COMPANY' }, NOW);
    expect(repository.setEntityType).toHaveBeenCalledWith('pub_1', 'COMPANY');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_agent', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({
      targetType: 'Publisher',
      targetId: 'pub_1',
      diff: { before: { entityType: null }, after: { entityType: 'COMPANY' } },
    }));
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PUBLISHER.COMPANY' }));
    expect(repository.setEntityType.mock.invocationCallOrder[0]!).toBeLessThan(digio.requestDigioKyc.mock.invocationCallOrder[0]!);
  });

  it('runs a political publisher on the publisher "Other entities" workflow', async () => {
    await initiateDigioKyc({ ...individual, type: 'POLITICAL' }, by, NOW);
    expect(digio.requestDigioKyc).toHaveBeenLastCalledWith(expect.objectContaining({ workflowKey: 'PUBLISHER.OTHER_ENTITY' }));
    await initiateDigioKyc(business, { ...by, entityType: 'POLITICAL' }, NOW);
    expect(digio.requestDigioKyc).toHaveBeenLastCalledWith(expect.objectContaining({ workflowKey: 'PUBLISHER.OTHER_ENTITY' }));
  });

  it('the upgrade: a verified individual verifying as a sole proprietor reopens the record on the new request', async () => {
    const decided = { id: 'pkyc_1', publisherId: 'pub_1', status: 'VERIFIED', method: 'DIGIO', digioRequestId: 'kyc_old', digioPayload: { id: 'kyc_old', status: 'approved', kyc_documents: [{ type: 'PAN', status: 'approved', name: 'Asha Rao', id_number: 'ABCDE1234F' }] } };
    repository.findByPublisherId.mockResolvedValue(decided);
    await initiateDigioKyc({ ...individual, kycStatus: 'VERIFIED' }, { byUserId: 'usr_1', entityType: 'SOLE_PROPRIETOR' }, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PUBLISHER.SOLE_PROPRIETOR' }));
    expect(repository.restartForUpgrade).toHaveBeenCalledWith('pub_1', 'SOLE_PROPRIETOR', expect.objectContaining({ digioRequestId: 'kyc_1', digioStatus: 'pending', submittedAt: NOW }));
    expect(repository.upsertDigioKyc).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
    const [, action, options] = audit.logActivity.mock.calls[0] as [string, string, { diff: { before: Record<string, unknown>; after: Record<string, unknown> } }];
    expect(action).toBe('KYC_ENTITY_UPGRADED');
    expect(options.diff.before).toMatchObject({ entityType: 'INDIVIDUAL', status: 'VERIFIED', digioRequestId: 'kyc_old' });
    expect(options.diff.after).toMatchObject({ entityType: 'SOLE_PROPRIETOR', status: 'PENDING', digioRequestId: 'kyc_1', digioPayload: null });
    // The old payload rides in the audit trimmed to the decision — no names, no numbers.
    expect(options.diff.before['digioPayload']).toMatchObject({ id: 'kyc_old', status: 'approved', trimmed: true });
    expect(JSON.stringify(options.diff)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(options.diff)).not.toContain('Asha');
  });

  it('a refused upgrade leaves the verified individual as they were', async () => {
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'VERIFIED' });
    digio.requestDigioKyc.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE' }));
    await expect(initiateDigioKyc({ ...individual, kycStatus: 'VERIFIED' }, { ...by, entityType: 'COMPANY' }, NOW)).rejects.toMatchObject({ statusCode: 503 });
    expect(repository.restartForUpgrade).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
  });

  it('any other change on a verified publisher stays 409', async () => {
    repository.findByPublisherId.mockResolvedValue({ id: 'pkyc_1', publisherId: 'pub_1', status: 'VERIFIED' });
    await expect(initiateDigioKyc({ ...business, entityType: 'COMPANY', kycStatus: 'VERIFIED' }, { ...by, entityType: 'LLP_PARTNERSHIP' })).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    await expect(initiateDigioKyc({ ...individual, kycStatus: 'VERIFIED' }, { ...by, entityType: 'INDIVIDUAL' })).rejects.toMatchObject({ statusCode: 409 });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });
});

describe('Phase D: the webhook', () => {
  const pendingRow = { id: 'pkyc_1', publisherId: 'pub_1', status: 'PENDING' };

  it('applies an approval to the record (the repository mirrors Publisher.kycStatus in the same transaction)', async () => {
    repository.findByRequestId.mockResolvedValue(pendingRow);
    await expect(handleDigioWebhook({ id: 'kyc_1', status: 'approved', completed_at: NOW.toISOString() })).resolves.toBe(true);
    expect(repository.applyWebhook).toHaveBeenCalledWith(pendingRow, expect.objectContaining({ status: 'VERIFIED', digioStatus: 'approved', digioVerifiedAt: NOW }));
  });

  it('never moves a VERIFIED or REJECTED record back on a pending or unknown status — logged and acknowledged', async () => {
    for (const status of ['VERIFIED', 'REJECTED']) {
      repository.findByRequestId.mockResolvedValue({ ...pendingRow, status });
      for (const sent of ['pending', 'cancelled', 'approval_pending']) {
        await expect(handleDigioWebhook({ id: 'kyc_1', status: sent })).resolves.toBe(true);
      }
    }
    expect(repository.applyWebhook).not.toHaveBeenCalled();
  });

  it('keeps an unknown status raw on a PENDING record, read as PENDING', async () => {
    repository.findByRequestId.mockResolvedValue(pendingRow);
    await handleDigioWebhook({ id: 'kyc_1', status: 'approval_pending' });
    expect(repository.applyWebhook).toHaveBeenCalledWith(pendingRow, expect.objectContaining({ digioStatus: 'approval_pending', status: 'PENDING' }));
  });

  it('takes an unknown status off the wire rather than dropping it as unparseable', async () => {
    repository.findByRequestId.mockResolvedValue(pendingRow);
    const body = { id: 'kyc_1', status: 'approval_pending', kyc_documents: [{ type: 'PAN', status: 'requested' }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac('sha256', env.DIGIO_WEBHOOK_SECRET!).update(rawBody).digest('hex');
    const res = { json: vi.fn() };
    await digioWebhookHandler({ headers: { 'x-digio-signature': signature }, rawBody, body } as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(repository.applyWebhook).toHaveBeenCalledWith(pendingRow, expect.objectContaining({ digioStatus: 'approval_pending', status: 'PENDING' }));
  });
});
