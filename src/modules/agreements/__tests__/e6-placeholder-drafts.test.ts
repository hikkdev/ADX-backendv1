import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: a fresh database has no template of any kind. `ensureAgreementDrafts`
 * seeds version 1 of each missing kind as a DRAFT with a clearly marked
 * placeholder body — never live, never overwriting a kind that has a row.
 */

const { repository, state } = vi.hoisted(() => {
  const state = { templates: [] as Record<string, any>[], seq: 0 };
  const repository = {
    highestVersion: vi.fn(async (kind: string) => Math.max(0, ...state.templates.filter((t) => t.kind === kind).map((t) => t.version))),
    createTemplate: vi.fn(async (data: Record<string, unknown>) => {
      const row = { id: `tpl_${++state.seq}`, isActive: false, activatedAt: null, retiredAt: null, acceptanceCount: 0, ...data };
      state.templates.push(row);
      return row;
    }),
    activeTemplate: vi.fn(async (kind: string) => state.templates.find((t) => t.kind === kind && t.isActive) ?? null),
  };
  return { repository, state };
});

vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: repository }));

import { PLACEHOLDER_MARKER, SEEDED_KINDS, currentTemplate, ensureAgreementDrafts, placeholderDraft } from '../agreements.service';

beforeEach(() => {
  vi.clearAllMocks();
  state.templates = [];
  state.seq = 0;
});

describe('ensureAgreementDrafts', () => {
  it('seeds version 1 of each of the ten kinds as a marked DRAFT on an empty database', async () => {
    const created = await ensureAgreementDrafts();
    expect(created).toEqual(['PLATFORM', 'ADVERTISER_PLATFORM', 'INSERTION_ORDER', 'PACKAGE_SALE', 'JOB_TERMS', 'AGENT_PUBLISHER_PLATFORM', 'AGENT_ADVERTISER_PLATFORM', 'EMPLOYEE_APPOINTMENT', 'PRINT_PARTNER_SERVICE', 'PUBLISHER_LICENCE']);
    expect(SEEDED_KINDS).not.toContain('LISTING');
    expect(state.templates).toHaveLength(10);
    for (const row of state.templates) {
      expect(row.version).toBe(1);
      expect(row.isActive).toBe(false);
      expect(row.body).toContain(PLACEHOLDER_MARKER);
      expect(row.createdByUserId).toBeNull();
    }
    // The variables each kind renders are in the body, so ops see where the schedule lands.
    expect(placeholderDraft('INSERTION_ORDER').body).toContain('{{spots}}');
    expect(placeholderDraft('PACKAGE_SALE').body).toContain('{{sale}}');
    // LT-1: the agent's terms carry the location-sharing clause the app's consent line points at; nobody else's do.
    expect(placeholderDraft('AGENT_PUBLISHER_PLATFORM').body).toContain('## Location sharing');
    expect(placeholderDraft('AGENT_ADVERTISER_PLATFORM').body).toContain('shares your position');
    expect(placeholderDraft('PACKAGE_SALE').body).not.toContain('Location sharing');
    expect(placeholderDraft('JOB_TERMS').body).not.toContain('Location sharing');
    expect(placeholderDraft('JOB_TERMS').body).not.toContain('{{');
  });

  it('is idempotent and never touches a kind that already has a row — draft, live or superseded', async () => {
    state.templates.push({ id: 'tpl_live', kind: 'PLATFORM', version: 3, isActive: true, body: 'The real words' });
    state.templates.push({ id: 'tpl_old', kind: 'INSERTION_ORDER', version: 1, isActive: false, retiredAt: new Date(), body: 'Retired' });
    const first = await ensureAgreementDrafts();
    expect(first).toEqual(['ADVERTISER_PLATFORM', 'PACKAGE_SALE', 'JOB_TERMS', 'AGENT_PUBLISHER_PLATFORM', 'AGENT_ADVERTISER_PLATFORM', 'EMPLOYEE_APPOINTMENT', 'PRINT_PARTNER_SERVICE', 'PUBLISHER_LICENCE']);
    expect(state.templates.find((t) => t.id === 'tpl_live')!.body).toBe('The real words');
    expect(state.templates.filter((t) => t.kind === 'INSERTION_ORDER')).toHaveLength(1);

    const second = await ensureAgreementDrafts();
    expect(second).toEqual([]);
    expect(repository.createTemplate).toHaveBeenCalledTimes(8);
  });

  it('a seeded draft satisfies no gate: the kind still answers NO_ACTIVE_TEMPLATE', async () => {
    await ensureAgreementDrafts();
    await expect(currentTemplate('JOB_TERMS')).rejects.toMatchObject({ code: 'NO_ACTIVE_TEMPLATE' });
    expect(repository.activeTemplate).toHaveBeenCalledWith('JOB_TERMS');
  });
});
