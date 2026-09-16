import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-1 — the QR engine's hold on a campaign's tracking codes.
 *
 * Pinned: when the engine hosts codes, paying for a campaign puts one
 * dynamic code in front of every QR code, named for the desk on the other
 * side, targeting ADX's own /t/ — and the hoarding's printed URL becomes
 * the engine's short URL; when it does not, the codes are issued exactly
 * as before and the hoarding carries /t/; an engine that fails at payment
 * time is logged, never fatal; the sync links only the codes not yet
 * hosted and throws the engine's own refusal; the analytics fold is over
 * the codes the engine answered for, counts the ones it did not, and is
 * null when nothing is hosted.
 */

const { repository, engine, logging } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    createTrackingCodes: vi.fn(),
    codeExists: vi.fn(),
    findTrackingCode: vi.fn(),
    recordTrackingEvent: vi.fn(),
    bumpTrackingCounter: vi.fn(),
    findLandingPage: vi.fn(async () => null),
    linkTrackingCodesToEngine: vi.fn(async () => undefined),
  },
  engine: {
    dynamicCodesAvailable: vi.fn(),
    registerDynamicCodes: vi.fn(),
    dynamicCodeAnalytics: vi.fn(),
  },
  logging: { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../../shared/qr-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/qr-engine')>();
  return { ...actual, ...engine };
});
vi.mock('../../../shared/logging', () => logging);

import { ApiError } from '../../../shared/errors';
import { issueTrackingCodes, linkCodesToEngine, printedUrl, trackingUrl } from '../tracking.service';
import { campaignEngineView } from '../analytics.service';
import type { TrackingMethod } from '../../../generated/prisma';

type Code = {
  id: string; campaignId: string; spotId: string | null; code: string; method: TrackingMethod; destination: string | null;
  vanityPath: string | null; promoCode: string | null; scans: number; clicks: number; redemptions: number;
  engineCodeId: string | null; shortUrl: string | null; engineLinkedAt: Date | null; createdAt: Date;
};

const code = (over: Partial<Code> = {}): Code => ({
  id: `tc_${over.code ?? 'X'}`,
  campaignId: 'cmp_1',
  spotId: null,
  code: 'AAAA2345',
  method: 'QR_OR_DEEPLINK',
  destination: null,
  vanityPath: null,
  promoCode: null,
  scans: 0,
  clicks: 0,
  redemptions: 0,
  engineCodeId: null,
  shortUrl: null,
  engineLinkedAt: null,
  createdAt: new Date('2026-09-16T00:00:00Z'),
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'CMP-2026-0042',
    trackingMethod: 'QR_OR_DEEPLINK',
    trackingConfig: { destinationUrl: 'https://anitascoffee.in/offer' },
    spots: [
      { id: 'spt_1', status: 'BOOKED', listing: { title: 'MG Road hoarding' } },
      { id: 'spt_2', status: 'BOOKED', listing: { title: 'Indiranagar bus shelter' } },
    ],
    codes: [],
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  repository.codeExists.mockResolvedValue(false);
  // The rows come back as the DB would hand them: ids and nulls filled in.
  repository.createTrackingCodes.mockImplementation(async (rows: Partial<Code>[]) => rows.map((row) => code(row)));
  engine.dynamicCodesAvailable.mockResolvedValue(false);
  engine.registerDynamicCodes.mockResolvedValue([]);
  engine.dynamicCodeAnalytics.mockResolvedValue(new Map());
});

describe('printedUrl', () => {
  it("is the engine's short URL when hosted, else /t/", () => {
    expect(printedUrl({ code: 'AAAA2345', shortUrl: 'https://go.adx.example/r/SC1' })).toBe('https://go.adx.example/r/SC1');
    expect(printedUrl({ code: 'AAAA2345', shortUrl: null })).toBe(trackingUrl('AAAA2345'));
  });
});

describe('issuing codes with no engine hosting them', () => {
  it('issues exactly as before and asks the engine for nothing', async () => {
    repository.findCampaign.mockResolvedValue(campaign());
    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(2);
    expect(codes.every((row) => row.engineCodeId === null && row.shortUrl === null)).toBe(true);
    expect(engine.registerDynamicCodes).not.toHaveBeenCalled();
    expect(repository.linkTrackingCodesToEngine).not.toHaveBeenCalled();
  });
});

describe('issuing codes with the engine hosting them', () => {
  beforeEach(() => {
    engine.dynamicCodesAvailable.mockResolvedValue(true);
    engine.registerDynamicCodes.mockImplementation(async (items: { name: string }[]) =>
      items.map((_, i) => ({ engineCodeId: `g${i}`, shortCode: `SC${i}`, shortUrl: `https://go.adx.example/r/SC${i}` })),
    );
  });

  it('puts one dynamic code in front of each QR code, named for the desk, targeting /t/, and records the link', async () => {
    // The codes are random; the second read (the link) sees what the first write created.
    let created: Code[] = [];
    repository.createTrackingCodes.mockImplementation(async (rows: Partial<Code>[]) => {
      created = rows.map((row) => code(row));
      return created;
    });
    repository.findCampaign.mockImplementation(async () => campaign({ codes: created }));
    const codes = await issueTrackingCodes('cmp_1');
    const [first, second] = created as [Code, Code];

    expect(engine.registerDynamicCodes).toHaveBeenCalledTimes(1);
    expect(engine.registerDynamicCodes.mock.calls[0]![0]).toEqual([
      { name: 'CMP-2026-0042 · MG Road hoarding', target: trackingUrl(first.code) },
      { name: 'CMP-2026-0042 · Indiranagar bus shelter', target: trackingUrl(second.code) },
    ]);
    expect(repository.linkTrackingCodesToEngine).toHaveBeenCalledWith(
      [
        { id: first.id, engineCodeId: 'g0', shortUrl: 'https://go.adx.example/r/SC0' },
        { id: second.id, engineCodeId: 'g1', shortUrl: 'https://go.adx.example/r/SC1' },
      ],
      expect.any(Date),
    );
    expect(codes.map((row) => [row.code, row.engineCodeId, printedUrl(row)])).toEqual([
      [first.code, 'g0', 'https://go.adx.example/r/SC0'],
      [second.code, 'g1', 'https://go.adx.example/r/SC1'],
    ]);
  });

  it('an engine that fails at payment time is logged, not fatal — the codes stand and the hoarding carries /t/', async () => {
    const issued = [code({ code: 'AAAA2345', spotId: 'spt_1' })];
    repository.findCampaign.mockResolvedValueOnce(campaign({ spots: [campaign().spots[0]] })).mockResolvedValueOnce(campaign({ codes: issued }));
    engine.registerDynamicCodes.mockRejectedValue(new ApiError(502, 'INTERNAL_ERROR', 'GenQR could not be reached: ECONNREFUSED'));

    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(1);
    expect(codes[0]!.engineCodeId).toBeNull();
    expect(printedUrl(codes[0]!)).toBe(trackingUrl(codes[0]!.code));
    expect(repository.linkTrackingCodesToEngine).not.toHaveBeenCalled();
    expect(logging.logger.warn).toHaveBeenCalledWith(expect.stringContaining('carries /t/'), expect.objectContaining({ campaignId: 'cmp_1' }));
  });

  it('a vanity / promo campaign has nothing for the engine', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ trackingMethod: 'VANITY_OR_PROMO', trackingConfig: { vanityUrl: 'https://anitascoffee.in/mg', promoCode: 'MG10' } }));
    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(1);
    expect(engine.registerDynamicCodes).not.toHaveBeenCalled();
  });
});

describe('linkCodesToEngine — the sync', () => {
  it('links only the QR codes not yet hosted, skipping linked and non-QR ones', async () => {
    engine.dynamicCodesAvailable.mockResolvedValue(true);
    engine.registerDynamicCodes.mockResolvedValue([{ engineCodeId: 'g9', shortCode: 'SC9', shortUrl: 'https://go.adx.example/r/SC9' }]);
    repository.findCampaign.mockResolvedValue(
      campaign({
        codes: [
          code({ code: 'AAAA2345', spotId: 'spt_1', engineCodeId: 'g0', shortUrl: 'https://go.adx.example/r/SC0' }),
          code({ code: 'BBBB2345', spotId: 'spt_2' }),
          code({ code: 'PROMO234', method: 'VANITY_OR_PROMO', promoCode: 'MG10' }),
        ],
      }),
    );
    const linked = await linkCodesToEngine('cmp_1');
    expect(linked.map((row) => row.code)).toEqual(['BBBB2345']);
    expect(engine.registerDynamicCodes.mock.calls[0]![0]).toEqual([{ name: 'CMP-2026-0042 · Indiranagar bus shelter', target: trackingUrl('BBBB2345') }]);
    expect(repository.linkTrackingCodesToEngine).toHaveBeenCalledWith([{ id: 'tc_BBBB2345', engineCodeId: 'g9', shortUrl: 'https://go.adx.example/r/SC9' }], expect.any(Date));
  });

  it('does nothing, quietly, when no engine hosts codes', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ codes: [code()] }));
    expect(await linkCodesToEngine('cmp_1')).toEqual([]);
    expect(engine.registerDynamicCodes).not.toHaveBeenCalled();
  });

  it("throws the engine's own refusal so a deliberate sync says what went wrong", async () => {
    engine.dynamicCodesAvailable.mockResolvedValue(true);
    engine.registerDynamicCodes.mockRejectedValue(new ApiError(409, 'CONFLICT', 'GenQR quota reached.'));
    repository.findCampaign.mockResolvedValue(campaign({ codes: [code()] }));
    await expect(linkCodesToEngine('cmp_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.linkTrackingCodesToEngine).not.toHaveBeenCalled();
  });
});

describe('campaignEngineView — the analytics fold', () => {
  const answer = (id: string, over: Record<string, unknown> = {}) => ({
    engineCodeId: id,
    days: 30,
    totalScans: 10,
    scansInWindow: 4,
    scansByDay: [{ date: '2026-09-15', count: 1 }, { date: '2026-09-16', count: 3 }],
    hourlyBreakdown: [{ hour: 9, count: 1 }, { hour: 18, count: 3 }],
    deviceBreakdown: [{ label: 'mobile', count: 4 }],
    browserBreakdown: [{ label: 'Chrome', count: 3 }, { label: 'Safari', count: 1 }],
    osBreakdown: [{ label: 'Android', count: 3 }, { label: 'iOS', count: 1 }],
    countryBreakdown: [{ label: 'India', code: 'IN', count: 4 }],
    cityBreakdown: [{ label: 'Bengaluru', count: 4 }],
    ...over,
  });

  it('is null when nothing is hosted, and asks the engine for nothing', async () => {
    expect(await campaignEngineView([code()], 30)).toBeNull();
    expect(engine.dynamicCodeAnalytics).not.toHaveBeenCalled();
  });

  it('folds across the hosted codes, sums the breakdowns most-first, and counts the codes the engine did not answer for', async () => {
    engine.dynamicCodeAnalytics.mockResolvedValue(
      new Map([
        ['g0', answer('g0')],
        ['g1', answer('g1', { totalScans: 5, scansInWindow: 2, scansByDay: [{ date: '2026-09-16', count: 2 }], hourlyBreakdown: [{ hour: 18, count: 2 }], deviceBreakdown: [{ label: 'desktop', count: 2 }], cityBreakdown: [{ label: 'Mysuru', count: 2 }] })],
      ]),
    );
    const view = await campaignEngineView(
      [
        code({ code: 'A', engineCodeId: 'g0' }),
        code({ code: 'B', engineCodeId: 'g1' }),
        code({ code: 'C', engineCodeId: 'g2' }),
        code({ code: 'D' }),
        code({ code: 'P', method: 'VANITY_OR_PROMO', engineCodeId: null }),
      ],
      30,
    );
    expect(engine.dynamicCodeAnalytics).toHaveBeenCalledWith(['g0', 'g1', 'g2'], 30);
    expect(view).toMatchObject({
      provenance: 'ENGINE',
      engine: 'GENQR',
      codesLinked: 3,
      codesTotal: 4,
      codesUnanswered: 1,
      days: 30,
      totalScans: 15,
      scansInWindow: 6,
      scansByDay: [{ date: '2026-09-15', count: 1 }, { date: '2026-09-16', count: 5 }],
      deviceBreakdown: [{ label: 'mobile', count: 4 }, { label: 'desktop', count: 2 }],
      cityBreakdown: [{ label: 'Bengaluru', count: 4 }, { label: 'Mysuru', count: 2 }],
      countryBreakdown: [{ label: 'India', code: 'IN', count: 8 }],
    });
    expect(view!.hourlyBreakdown).toHaveLength(24);
    expect(view!.hourlyBreakdown[18]).toEqual({ hour: 18, count: 5 });
    expect(view!.hourlyBreakdown[9]).toEqual({ hour: 9, count: 1 });
    expect(view!.basis).toContain('3 hosted codes');
  });
});
