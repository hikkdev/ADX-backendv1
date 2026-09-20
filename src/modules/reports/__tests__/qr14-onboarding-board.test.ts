import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-14 — the team onboarding board.
 *
 * Pinned: the report kind ranks people by what they onboarded (self-signups
 * as "organic", unranked) and prints the doors and the milestones; the
 * on-screen read answers the same rows for a preset or a from/to window,
 * refuses a window that is neither, and takes the door and the role as
 * cuts; and the actor's role label is the console role's name, "Super
 * admin" for one, "Agent" for the agent roles.
 */

const { data, standing } = vi.hoisted(() => ({
  data: { onboardingBoard: vi.fn() },
  standing: { findMembership: vi.fn() },
}));

vi.mock('../prisma-reports.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-reports.repository')>();
  return { ...actual, prismaReportData: { ...actual.prismaReportData, onboardingBoard: data.onboardingBoard } };
});
vi.mock('../../access-control/prisma-access-control.repository', () => ({ prismaRoleConfigRepository: standing }));

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { tokenFor } from '../../../shared/testing';
import { authenticate, requireRole } from '../../../shared/auth';
import { buildCatalogue } from '../catalogue';
import { onboardingBoardHandler } from '../reports.controller';
import { actorLabelFor } from '../../access-control';

const rows = [
  { actorId: 'usr_ops', actorName: 'Asha Rao', actorRole: 'Ops manager', via: { SELF: 0, AGENT: 0, QR: 0, DESK: 7, IMPORT: 2 }, publishers: 8, advertisers: 1, onboarded: 9, completed: 6, liveWithin7d: 3, verified: 2, firstBooking: 1 },
  { actorId: 'usr_agent', actorName: 'Ravi Agent', actorRole: 'Agent', via: { SELF: 0, AGENT: 2, QR: 3, DESK: 0, IMPORT: 0 }, publishers: 5, advertisers: 0, onboarded: 5, completed: 4, liveWithin7d: 2, verified: 3, firstBooking: 0 },
  { actorId: null, actorName: null, actorRole: null, via: { SELF: 4, AGENT: 0, QR: 0, DESK: 0, IMPORT: 0 }, publishers: 3, advertisers: 1, onboarded: 4, completed: 2, liveWithin7d: 1, verified: 0, firstBooking: 0 },
];

function appWith() {
  const app = express();
  app.get('/api/v1/reports/boards/onboarding', authenticate, requireRole('ADMIN'), asyncHandler(onboardingBoardHandler));
  app.use(errorHandler);
  return app;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');

beforeEach(() => {
  vi.clearAllMocks();
  data.onboardingBoard.mockResolvedValue(rows);
});

describe('the report kind', () => {
  it('ranks the people, leaves organic unranked, and prints the doors and the milestones', async () => {
    const kind = buildCatalogue({ onboardingBoard: data.onboardingBoard } as never).find((k) => k.kind === 'onboarding-board')!;
    expect(kind.filters.map((f) => f.key)).toEqual(['via', 'role']);
    const out = await kind.query({ via: 'DESK' }, { start: new Date(), end: new Date(), from: '2026-09-01', to: '2026-09-17', label: 'x' } as never);
    expect(data.onboardingBoard).toHaveBeenCalledWith(expect.anything(), { via: 'DESK', role: undefined });
    expect(out.map((r) => [r['rank'], r['actorName'], r['desk'], r['qr'], r['completedPct']])).toEqual([
      [1, 'Asha Rao', 7, 0, '66.7%'],
      [2, 'Ravi Agent', 0, 3, '80.0%'],
      [null, 'Organic (self-serve)', 0, 0, '50.0%'],
    ]);
  });
});

describe('the on-screen read', () => {
  it('answers the ranked rows for a preset window', async () => {
    const res = await request(appWith()).get('/api/v1/reports/boards/onboarding?preset=last30&role=Agent').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(data.onboardingBoard).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }), { via: undefined, role: 'Agent' });
    expect(res.body.data.window.label).toBeTruthy();
    expect(res.body.data.rows.map((r: { rank: number | null; actorName: string | null }) => [r.rank, r.actorName])).toEqual([
      [1, 'Asha Rao'],
      [2, 'Ravi Agent'],
      [null, null],
    ]);
  });

  it('takes a from/to window, and refuses neither', async () => {
    const ok = await request(appWith()).get('/api/v1/reports/boards/onboarding?from=2026-09-01&to=2026-09-17&via=QR').set('Authorization', `Bearer ${admin}`);
    expect(ok.status).toBe(200);
    expect(data.onboardingBoard).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-09-01', to: '2026-09-17' }), { via: 'QR', role: undefined });
    const bad = await request(appWith()).get('/api/v1/reports/boards/onboarding').set('Authorization', `Bearer ${admin}`);
    expect(bad.status).toBe(400);
  });
});

describe('the actor label', () => {
  it('is the console role for an admin, Super admin for one, Agent for the agent roles', async () => {
    standing.findMembership.mockResolvedValue({ roleConfig: { id: 'r1', name: 'Ops manager', isSystem: false } });
    expect(await actorLabelFor('usr_1', ['ADMIN'])).toBe('Ops manager');
    standing.findMembership.mockResolvedValue({ roleConfig: { id: 'r0', name: 'Super admin', isSystem: true } });
    expect(await actorLabelFor('usr_1', ['ADMIN'])).toBe('Super admin');
    standing.findMembership.mockResolvedValue(null);
    expect(await actorLabelFor('usr_1', ['ADMIN'])).toBe('Super admin');
    expect(await actorLabelFor('usr_2', ['AGENT_PUBLISHER'])).toBe('Agent');
    expect(await actorLabelFor('usr_3', ['PUBLISHER'])).toBe('Publisher');
  });
});
