import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * U9 — the owner's own record of who has had access to their account.
 *
 * Three sources, one answer: every scan of their door-to-door code (refusals
 * included, with who scanned and how far away they stood), every authority
 * that was opened on the account and when it ended, and every change an
 * agent made under one of those authorities. Composed here because this
 * module owns the authority; the party modules hand in their subject.
 */

const { repository, qr, audit } = vi.hoisted(() => ({
  repository: {
    listForSubject: vi.fn(),
  },
  qr: { listScansFor: vi.fn(), registerAccessGrantPort: vi.fn(), deactivateQr: vi.fn(), generateQr: vi.fn() },
  audit: { findActivityByMetadata: vi.fn(), logActivity: vi.fn() },
}));

vi.mock('../prisma-access-grants.repository', () => ({ prismaAccessGrantsRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));

import { accessLogFor } from '../access-grants.service';

const when = new Date('2026-09-10T08:44:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  qr.listScansFor.mockResolvedValue([
    {
      id: 'scan_1',
      createdAt: when,
      outcome: 'GRANTED',
      distanceM: 120,
      decidedAt: new Date('2026-09-10T08:45:00.000Z'),
      role: 'AGENT_PUBLISHER',
      scannedBy: { id: 'usr_agent', name: 'Rahul Kumar', mobile: '+919876543210', agentProfile: { displayId: 'AGT-1009-2601' } },
    },
    {
      id: 'scan_2',
      createdAt: new Date('2026-09-09T10:00:00.000Z'),
      outcome: 'EXPIRED',
      distanceM: null,
      decidedAt: null,
      role: 'AGENT_PUBLISHER',
      scannedBy: { id: 'usr_other', name: 'Meera S', mobile: '+919812340001', agentProfile: null },
    },
  ]);
  repository.listForSubject.mockResolvedValue([
    {
      id: 'grant_1',
      purpose: 'ONBOARDING',
      scope: 'PROFILE',
      status: 'ACTIVE',
      claimedAt: new Date('2026-09-10T08:45:00.000Z'),
      expiresAt: new Date('2026-09-12T08:45:00.000Z'),
      revokedAt: null,
      assignedAgentId: 'agt_1',
      listingIds: [],
    },
  ]);
  audit.findActivityByMetadata.mockResolvedValue([
    {
      id: 'act_1',
      action: 'PUBLISHER_UPDATED_UNDER_GRANT',
      createdAt: new Date('2026-09-10T09:02:00.000Z'),
      metadata: { publisherId: 'pub_1', grantId: 'grant_1', fields: ['name', 'address'] },
      user: { id: 'usr_agent', name: 'Rahul Kumar' },
    },
  ]);
});

describe('accessLogFor', () => {
  it('reads the three sources for the subject and names who did what, when', async () => {
    const log = await accessLogFor({ publisherId: 'pub_1' });

    expect(qr.listScansFor).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
    expect(repository.listForSubject).toHaveBeenCalledWith({ publisherId: 'pub_1' });
    expect(audit.findActivityByMetadata).toHaveBeenCalledWith(
      ['PUBLISHER_UPDATED_UNDER_GRANT', 'PUBLISHER_KYC_SUBMITTED_UNDER_GRANT'],
      'publisherId',
      'pub_1',
    );

    expect(log.scans).toEqual([
      {
        id: 'scan_1',
        at: when,
        outcome: 'GRANTED',
        distanceM: 120,
        decidedAt: new Date('2026-09-10T08:45:00.000Z'),
        agent: { name: 'Rahul Kumar', displayId: 'AGT-1009-2601', mobile: '+919876543210' },
      },
      {
        id: 'scan_2',
        at: new Date('2026-09-09T10:00:00.000Z'),
        outcome: 'EXPIRED',
        distanceM: null,
        decidedAt: null,
        agent: { name: 'Meera S', displayId: null, mobile: '+919812340001' },
      },
    ]);
    expect(log.grants).toEqual([
      {
        id: 'grant_1',
        purpose: 'ONBOARDING',
        scope: 'PROFILE',
        status: 'ACTIVE',
        from: new Date('2026-09-10T08:45:00.000Z'),
        until: new Date('2026-09-12T08:45:00.000Z'),
        revokedAt: null,
      },
    ]);
    expect(log.changes).toEqual([
      {
        id: 'act_1',
        at: new Date('2026-09-10T09:02:00.000Z'),
        action: 'PUBLISHER_UPDATED_UNDER_GRANT',
        fields: ['name', 'address'],
        grantId: 'grant_1',
        by: { name: 'Rahul Kumar' },
      },
    ]);
  });

  it('asks the demand side by its own code type and actions', async () => {
    await accessLogFor({ advertiserId: 'adv_1' });
    expect(qr.listScansFor).toHaveBeenCalledWith('ADVERTISER', 'adv_1');
    // The onboarding writes, and every write the attributed agent makes under
    // the grant afterwards (advertisers.policy) — all keyed on the grant.
    expect(audit.findActivityByMetadata).toHaveBeenCalledWith(
      expect.arrayContaining([
        'ADVERTISER_UPDATED_UNDER_GRANT',
        'ADVERTISER_KYC_SUBMITTED_UNDER_GRANT',
        'ADVERTISER_PROFILE_UPDATED',
        'ADVERTISER_AGREEMENT_ACCEPTED',
        'ADVERTISER_HOLD_PLACED',
      ]),
      'advertiserId',
      'adv_1',
    );
  });

  it('is three empty lists when nothing has happened', async () => {
    qr.listScansFor.mockResolvedValue([]);
    repository.listForSubject.mockResolvedValue([]);
    audit.findActivityByMetadata.mockResolvedValue([]);
    expect(await accessLogFor({ publisherId: 'pub_2' })).toEqual({ scans: [], grants: [], changes: [] });
  });
});
