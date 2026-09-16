import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q123/Q55): the click, recorded by this module for every transaction.
 *
 * What is held onto: a transaction accepts the version live at that moment
 * and once per version; a platform click is once per party per version; the
 * insertion order is rendered from the template and the campaign, never from
 * text a client sent; and re-acceptance is only demanded when the live
 * version says so.
 */

const { repository, state } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = {
    templates: [] as Row[],
    acceptances: [] as Row[],
    campaigns: [] as Row[],
    seq: 0,
    reset() {
      this.templates = [];
      this.acceptances = [];
      this.campaigns = [];
      this.seq = 0;
    },
  };
  const withCount = (t: Row) => ({ ...t, acceptanceCount: 0 });
  const newest = (rows: Row[]) =>
    [...rows].sort((a, b) => b.templateVersion - a.templateVersion)[0] ?? null;
  const anchorKeys = ['attemptId', 'campaignId', 'packageSaleId', 'orderId'];
  const repository = {
    activeTemplate: vi.fn(async (kind: string) => {
      const t = state.templates.find((row) => row.kind === kind && row.isActive);
      return t ? withCount(t) : null;
    }),
    findPlatformAcceptance: vi.fn(async (kind: string, party: Row) =>
      newest(
        state.acceptances.filter(
          (a) =>
            a.templateKind === kind &&
            anchorKeys.every((key) => !a[key]) &&
            Object.entries(party).every(([key, value]) => !value || a[key] === value),
        ),
      ),
    ),
    findAnchoredAcceptance: vi.fn(async (kind: string, anchor: Row) =>
      newest(
        state.acceptances.filter(
          (a) => a.templateKind === kind && Object.entries(anchor).every(([key, value]) => !value || a[key] === value),
        ),
      ),
    ),
    createAcceptance: vi.fn(async (data: Row) => {
      const row = { id: `acc_${++state.seq}`, acceptedAt: new Date(), ...data };
      state.acceptances.push(row);
      return row;
    }),
    partiesBehind: vi.fn(async (kind: string, current: number) => {
      const best = new Map<string, number>();
      for (const a of state.acceptances) {
        if (a.templateKind !== kind || anchorKeys.some((key) => a[key])) continue;
        const id = a.publisherId ?? a.advertiserId;
        best.set(id, Math.max(best.get(id) ?? 0, a.templateVersion));
      }
      return [...best.entries()]
        .filter(([, version]) => version < current)
        .map(([id, acceptedVersion]) => ({ type: 'advertiser', id, displayId: null, name: id, acceptedVersion }));
    }),
    campaignForInsertionOrder: vi.fn(async (id: string) => state.campaigns.find((c) => c.id === id) ?? null),
  };
  return { repository, state };
});

vi.mock('../prisma-agreements.repository', () => ({ prismaAgreementsRepository: repository }));

import {
  acceptInsertionOrder,
  isCurrentAcceptance,
  platformStanding,
  recordAcceptance,
  renderInsertionOrder,
  staleParties,
  transactionAcceptance,
} from '../agreements.service';

const template = (kind: string, version: number, over: Record<string, unknown> = {}) => {
  const row = {
    id: `tpl_${kind}_${version}`,
    kind,
    version,
    title: `${kind} v${version}`,
    body: `Terms v${version}`,
    isActive: true,
    requiresReacceptance: false,
    ...over,
  };
  for (const t of state.templates) if (t.kind === kind) t.isActive = false;
  state.templates.push(row);
  return row;
};

const ctx = { acceptedByUserId: 'usr_1', ipAddress: '10.0.0.1', userAgent: 'app/1.0' };

const campaign = {
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-482913',
  name: 'Anita coffee, April',
  advertiserId: 'adv_1',
  advertiserName: "Anita's Coffee",
  startDate: new Date('2026-04-01T00:00:00Z'),
  endDate: new Date('2026-04-14T00:00:00Z'),
  spots: [
    { id: 'spt_1', title: 'MG Road Billboard', city: 'Bengaluru', ratePerDay: '2000.00', days: 14, quantity: 1, lineTotal: '28000.00' },
    { id: 'spt_2', title: 'Airport Road Gantry', city: null, ratePerDay: '5000.00', days: 14, quantity: 2, lineTotal: '140000.00' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.reset();
});

describe('recordAcceptance', () => {
  it('refuses with NO_ACTIVE_TEMPLATE when nothing of the kind is published', async () => {
    await expect(
      recordAcceptance({ kind: 'PACKAGE_SALE', party: { advertiserId: 'adv_1' }, anchor: { packageSaleId: 'sale_1' }, ctx }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'NO_ACTIVE_TEMPLATE' });
  });

  it('records a transaction kind once per anchor per version, with the click context', async () => {
    template('PACKAGE_SALE', 1);
    const first = await recordAcceptance({ kind: 'PACKAGE_SALE', party: { advertiserId: 'adv_1' }, anchor: { packageSaleId: 'sale_1' }, ctx });
    const again = await recordAcceptance({ kind: 'PACKAGE_SALE', party: { advertiserId: 'adv_1' }, anchor: { packageSaleId: 'sale_1' }, ctx });
    expect(again.id).toBe(first.id);
    expect(repository.createAcceptance).toHaveBeenCalledTimes(1);
    expect(repository.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKind: 'PACKAGE_SALE',
        templateVersion: 1,
        advertiserId: 'adv_1',
        packageSaleId: 'sale_1',
        ipAddress: '10.0.0.1',
        userAgent: 'app/1.0',
      }),
    );
  });

  it('a new version live since the click is a new row, not the old one', async () => {
    template('JOB_TERMS', 1);
    await recordAcceptance({ kind: 'JOB_TERMS', party: { agentId: 'agt_1' }, anchor: { orderId: 'ord_1' }, ctx });
    template('JOB_TERMS', 2);
    const second = await recordAcceptance({ kind: 'JOB_TERMS', party: { agentId: 'agt_1' }, anchor: { orderId: 'ord_1' }, ctx });
    expect(second.templateVersion).toBe(2);
    expect(state.acceptances).toHaveLength(2);
  });

  it('binds the party the kind names and nobody else', async () => {
    template('JOB_TERMS', 1);
    await expect(
      recordAcceptance({ kind: 'JOB_TERMS', party: { advertiserId: 'adv_1' }, anchor: { orderId: 'ord_1' }, ctx }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      recordAcceptance({ kind: 'JOB_TERMS', party: { agentId: 'agt_1', advertiserId: 'adv_1' }, anchor: { orderId: 'ord_1' }, ctx }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a transaction kind needs its anchor', async () => {
    template('PACKAGE_SALE', 1);
    await expect(
      recordAcceptance({ kind: 'PACKAGE_SALE', party: { advertiserId: 'adv_1' }, ctx }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a platform kind is once per party per version', async () => {
    template('ADVERTISER_PLATFORM', 3);
    await recordAcceptance({ kind: 'ADVERTISER_PLATFORM', party: { advertiserId: 'adv_1' }, ctx });
    await recordAcceptance({ kind: 'ADVERTISER_PLATFORM', party: { advertiserId: 'adv_1' }, ctx });
    expect(state.acceptances).toHaveLength(1);
  });
});

describe('transactionAcceptance', () => {
  it('is current only on the version live now', async () => {
    template('INSERTION_ORDER', 1);
    await recordAcceptance({ kind: 'INSERTION_ORDER', party: { advertiserId: 'adv_1' }, anchor: { campaignId: 'cmp_1' }, ctx, renderedDocument: 'doc' });
    expect(await transactionAcceptance('INSERTION_ORDER', { campaignId: 'cmp_1' })).toMatchObject({
      accepted: true,
      templateVersion: 1,
      currentVersion: 1,
      current: true,
    });
    template('INSERTION_ORDER', 2);
    expect(await transactionAcceptance('INSERTION_ORDER', { campaignId: 'cmp_1' })).toMatchObject({
      accepted: true,
      templateVersion: 1,
      currentVersion: 2,
      current: false,
    });
  });

  it('reports nothing accepted, and no version live, honestly', async () => {
    expect(await transactionAcceptance('PACKAGE_SALE', { packageSaleId: 'sale_9' })).toEqual({
      kind: 'PACKAGE_SALE',
      accepted: false,
      templateVersion: null,
      currentVersion: null,
      current: false,
    });
  });
});

describe('re-acceptance (Q55)', () => {
  it('any acceptance satisfies a version that does not demand re-acceptance', () => {
    expect(isCurrentAcceptance({ templateVersion: 1 }, { version: 3, requiresReacceptance: false })).toBe(true);
    expect(isCurrentAcceptance({ templateVersion: 1 }, null)).toBe(true);
    expect(isCurrentAcceptance(null, { version: 3, requiresReacceptance: false })).toBe(false);
  });

  it('only the live version or later satisfies one that does', () => {
    expect(isCurrentAcceptance({ templateVersion: 2 }, { version: 3, requiresReacceptance: true })).toBe(false);
    expect(isCurrentAcceptance({ templateVersion: 3 }, { version: 3, requiresReacceptance: true })).toBe(true);
  });

  it('platformStanding says outdated and, when enforced, unsatisfied', async () => {
    template('ADVERTISER_PLATFORM', 1);
    await recordAcceptance({ kind: 'ADVERTISER_PLATFORM', party: { advertiserId: 'adv_1' }, ctx });
    template('ADVERTISER_PLATFORM', 2);
    expect(await platformStanding('ADVERTISER_PLATFORM', { advertiserId: 'adv_1' })).toMatchObject({
      currentVersion: 2,
      satisfied: true,
      outdated: true,
      requiresReacceptance: false,
    });
    template('ADVERTISER_PLATFORM', 3, { requiresReacceptance: true });
    expect(await platformStanding('ADVERTISER_PLATFORM', { advertiserId: 'adv_1' })).toMatchObject({
      currentVersion: 3,
      satisfied: false,
      outdated: true,
      requiresReacceptance: true,
    });
  });

  it('the stale report lists who is behind and whether that blocks them', async () => {
    template('ADVERTISER_PLATFORM', 1);
    await recordAcceptance({ kind: 'ADVERTISER_PLATFORM', party: { advertiserId: 'adv_old' }, ctx });
    template('ADVERTISER_PLATFORM', 2, { requiresReacceptance: true });
    await recordAcceptance({ kind: 'ADVERTISER_PLATFORM', party: { advertiserId: 'adv_new' }, ctx });
    const report = await staleParties('ADVERTISER_PLATFORM');
    expect(report).toMatchObject({ currentVersion: 2, enforced: true });
    expect(report.parties.map((p) => p.id)).toEqual(['adv_old']);
  });

  it('only the platform kinds can be stale', async () => {
    await expect(staleParties('INSERTION_ORDER')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('the insertion order', () => {
  it('renders the template with every site, rate and total — and fills {{spots}} when the body has it', () => {
    const appended = renderInsertionOrder('Body', campaign);
    expect(appended).toContain('## Sites covered by this insertion order');
    expect(appended).toContain('1. MG Road Billboard, Bengaluru — ₹2000.00/day × 14 days × 1 = ₹28000.00');
    expect(appended).toContain('2. Airport Road Gantry — ₹5000.00/day × 14 days × 2 = ₹140000.00');
    expect(appended).toContain('Flight: 2026-04-01 to 2026-04-14');

    const filled = renderInsertionOrder('Before\n{{spots}}\nAfter', campaign);
    expect(filled.startsWith('Before\nCampaign ADX-CMP-2026-482913')).toBe(true);
    expect(filled.endsWith('\nAfter')).toBe(true);
  });

  it('is rendered server-side and stored as accepted', async () => {
    template('INSERTION_ORDER', 1, { body: 'IO terms' });
    state.campaigns.push(campaign);
    const result = await acceptInsertionOrder('cmp_1', 'adv_1', ctx);
    expect(result).toMatchObject({ accepted: true, templateVersion: 1 });
    expect(repository.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKind: 'INSERTION_ORDER',
        campaignId: 'cmp_1',
        advertiserId: 'adv_1',
        renderedDocument: expect.stringContaining('IO terms'),
      }),
    );
    expect(repository.createAcceptance.mock.calls[0]![0].renderedDocument).toContain('MG Road Billboard');
  });

  it("refuses a campaign that is not the advertiser's", async () => {
    template('INSERTION_ORDER', 1);
    state.campaigns.push(campaign);
    await expect(acceptInsertionOrder('cmp_1', 'adv_other', ctx)).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });

  it('404s an unknown campaign and 503s a missing template', async () => {
    await expect(acceptInsertionOrder('cmp_9', 'adv_1', ctx)).rejects.toMatchObject({ statusCode: 404 });
    state.campaigns.push(campaign);
    await expect(acceptInsertionOrder('cmp_1', 'adv_1', ctx)).rejects.toMatchObject({ code: 'NO_ACTIVE_TEMPLATE' });
  });

  it('is idempotent per campaign per version', async () => {
    template('INSERTION_ORDER', 1);
    state.campaigns.push(campaign);
    const first = await acceptInsertionOrder('cmp_1', 'adv_1', ctx);
    const second = await acceptInsertionOrder('cmp_1', 'adv_1', ctx);
    expect(second.acceptanceId).toBe(first.acceptanceId);
  });
});
