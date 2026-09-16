import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-3: what every KYC case read carries — the age against the review SLA
 * and the people on the case by name, through the user-label port bootstrap
 * fills. Unregistered, every person is `{ id, name: null }`.
 */

vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));

import { kycCaseExtras, registerKycUserLabelPort, resetKycUserLabelPort } from '../case-read';

const now = new Date('2026-09-12T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600_000);

afterEach(() => resetKycUserLabelPort());

describe('kycCaseExtras', () => {
  it('ages a pending row against the SLA and names the three people through the port', async () => {
    const port = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id, name: `name of ${id}` }])));
    registerKycUserLabelPort(port);

    const extras = await kycCaseExtras(
      { status: 'PENDING', submittedAt: hoursAgo(50), reviewedById: null, assignedToId: 'usr_a', recordedById: 'usr_r' },
      now,
    );

    expect(extras).toEqual({
      ageHours: 50,
      slaBreached: true,
      slaHours: 48,
      reviewedBy: null,
      assignedTo: { id: 'usr_a', name: 'name of usr_a' },
      recordedBy: { id: 'usr_r', name: 'name of usr_r' },
      requestedBy: null,
      escalatedTo: null,
      escalatedBy: null,
    });
    expect(port).toHaveBeenCalledWith(['usr_a', 'usr_r']);
  });

  it('stops the clock on a decided row, and answers names null without a port or when the port fails', async () => {
    expect(await kycCaseExtras({ status: 'VERIFIED', submittedAt: hoursAgo(500), reviewedById: 'usr_ops' }, now)).toMatchObject({
      ageHours: null,
      slaBreached: false,
      reviewedBy: { id: 'usr_ops', name: null },
      assignedTo: null,
      recordedBy: null,
    });

    registerKycUserLabelPort(async () => {
      throw new Error('users down');
    });
    expect(await kycCaseExtras({ status: 'PENDING', submittedAt: hoursAgo(1), reviewedById: 'usr_ops' }, now)).toMatchObject({
      ageHours: 1,
      reviewedBy: { id: 'usr_ops', name: null },
    });
  });

  it('has no age and nobody on it for a party with no KYC row yet', async () => {
    expect(await kycCaseExtras(null, now)).toEqual({
      ageHours: null,
      slaBreached: false,
      slaHours: 48,
      reviewedBy: null,
      assignedTo: null,
      recordedBy: null,
      requestedBy: null,
      escalatedTo: null,
      escalatedBy: null,
    });
  });
});
