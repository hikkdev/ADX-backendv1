import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The simulator draws the DR 10 trace: base to net to publisher, one row a
 * step. What matters is that every row's running figure follows from the one
 * above it, that the revenue module — not this file — does the tax, and that
 * the things which need a person's sign-off say so.
 */

const { repository, effectiveCardEntry, activeSurge, revenueQuote, installationFeeFor } = vi.hoisted(() => ({
  installationFeeFor: vi.fn(),
  repository: {
    listDimensions: vi.fn(),
    findCategoryRule: vi.fn(),
    rulesInForce: vi.fn(),
    getSettings: vi.fn(),
    upsertSettings: vi.fn(),
    listingForSimulation: vi.fn(),
  },
  effectiveCardEntry: vi.fn(),
  activeSurge: vi.fn(),
  revenueQuote: vi.fn(),
}));

vi.mock('../prisma-price-model.repository', () => ({ prismaPriceModelRepository: repository }));
vi.mock('../../rate-cards', () => ({ effectiveCardEntry }));
vi.mock('../../pricing', () => ({ activeSurge }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../payouts', () => ({ installationFeeFor }));

import { simulate } from '../simulate.service';
import { durationDiscountFor, updateSettings } from '../settings.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road Billboard',
  city: 'Bengaluru',
  cityId: 'city_blr',
  latitude: 12.97,
  longitude: 77.6,
  mediaTypeId: 'mt_1',
  mediaTypeName: 'Billboard',
  areaSqFt: new Decimal('800'),
  rateGrade: 'A',
  ...over,
});

const card = () => ({
  card: {
    id: 'rc_1',
    name: 'Bengaluru Metro',
    version: 3,
    floorPct: new Decimal('0.8'),
    roundingRupees: 100,
  },
  entry: { ratePerDay: new Decimal('10000.00') },
});

/** The revenue module, answering with whatever media value it was handed. */
function billFor(input: { ratePerDay?: string; days: number; spots?: number; rateDiscount?: string }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const taxable = media.minus(input.rateDiscount ?? 0);
  const gst = taxable.times('0.18');
  const gross = taxable.plus(1500).plus(gst).plus(270);
  return {
    lines: [
      { kind: 'MEDIA', label: 'Media', taxableValue: taxable.toFixed(2) },
      { kind: 'INSTALLATION', label: 'Installation', taxableValue: '1500.00' },
    ],
    netValue: taxable.plus(1500).toFixed(2),
    gstAmount: gst.plus(270).toFixed(2),
    grossTotal: gross.toFixed(2),
    payable: gross.toFixed(2),
    publisher: {
      commissionPct: '0.12',
      commissionSource: 'PLATFORM_DEFAULT',
      commissionAmount: taxable.times('0.12').toFixed(2),
      netEarnings: taxable.times('0.88').toFixed(2),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.listingForSimulation.mockResolvedValue(listing());
  repository.listDimensions.mockResolvedValue([]);
  repository.findCategoryRule.mockResolvedValue(null);
  repository.rulesInForce.mockResolvedValue([]);
  repository.getSettings.mockResolvedValue(null);
  effectiveCardEntry.mockResolvedValue(card());
  activeSurge.mockResolvedValue(null);
  revenueQuote.mockImplementation(async (input) => billFor(input));
  installationFeeFor.mockResolvedValue('1450.00');
});

describe('the trace', () => {
  it('starts at the card and ends at net to publisher', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows[0]).toMatchObject({
      step: 'Base rate',
      rule: 'Bengaluru Metro v3',
      running: '10000.00',
    });
    expect(sim.rows[sim.rows.length - 1]).toMatchObject({ step: 'Net to publisher', emphasis: true });
    expect(sim.netToPublisher).toBe(new Decimal(70000).times('0.88').toFixed(2));
  });

  it('draws the frame rows in the frame order', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows.map((row) => row.step)).toEqual([
      'Base rate',
      'Locality grade',
      'Seasonality',
      'Duration',
      'Subtotal (7 days)',
      'Installation',
      'Agent installation fee (cost)',
      'Installation margin',
      'Taxable value',
      'GST',
      'Gross payable',
      'Platform commission 12%',
      'Net to publisher',
    ]);
  });

  /* The commission row is where the trace stops describing the advertiser's
     invoice and starts describing the publisher's payment. A running column
     that shows the commission itself reads as though the total collapsed. */
  it('drops the running figure by the commission, not to it', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    const commission = sim.rows.find((row) => row.step.startsWith('Platform commission'));
    const net = new Decimal(70000).times('0.88').toFixed(2);
    expect(commission).toMatchObject({ factor: `−${new Decimal(70000).times('0.12').toFixed(2)}`, running: net });
    expect(sim.rows[sim.rows.length - 1]!.running).toBe(net);
  });

  it('hands the revenue module the traced rate, not the listing rate', async () => {
    await simulate({ listingId: 'lst_1', days: 7 });
    expect(revenueQuote).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'lst_1', ratePerDay: '10000.00', days: 7 })
    );
  });

  it('refuses a site no approved card prices', async () => {
    effectiveCardEntry.mockResolvedValue(null);
    await expect(simulate({ listingId: 'lst_1', days: 7 })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the factors', () => {
  it('applies the size band the area falls in', async () => {
    repository.listDimensions.mockResolvedValue([
      {
        id: 'd_size',
        name: 'Size band',
        values: [
          { id: 'v_s', label: 'Small', multiplier: new Decimal('0.9'), minAreaSqFt: null, maxAreaSqFt: new Decimal('400'), isActive: true },
          { id: 'v_l', label: 'Large', multiplier: new Decimal('1.25'), minAreaSqFt: new Decimal('401'), maxAreaSqFt: null, isActive: true },
        ],
      },
    ]);
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows[1]).toMatchObject({
      step: 'Size band',
      rule: 'Large · 800 sq ft',
      factor: '1.25×',
      running: '12500.00',
    });
  });

  it('applies the dimension values the operator picked', async () => {
    repository.listDimensions.mockResolvedValue([
      {
        id: 'd_ill',
        name: 'Illumination',
        values: [{ id: 'v_bl', label: 'Backlit', multiplier: new Decimal('1.2'), minAreaSqFt: null, maxAreaSqFt: null, isActive: true }],
      },
    ]);
    const sim = await simulate({ listingId: 'lst_1', days: 7, dimensionValueIds: ['v_bl'] });
    expect(sim.rows.find((row) => row.step === 'Illumination')).toMatchObject({
      rule: 'Backlit',
      running: '12000.00',
    });
  });

  it('multiplies by the sector rule and blocks a blocked sector', async () => {
    repository.findCategoryRule.mockResolvedValue({ sector: 'Alcohol', effect: 'MULTIPLIER', multiplier: new Decimal('1.5') });
    const sim = await simulate({ listingId: 'lst_1', days: 7, sector: 'Alcohol' });
    expect(sim.rows.find((row) => row.step === 'Category')).toMatchObject({ factor: '1.5×', running: '15000.00' });

    repository.findCategoryRule.mockResolvedValue({ sector: 'Tobacco', effect: 'BLOCKED', multiplier: null });
    await expect(simulate({ listingId: 'lst_1', days: 7, sector: 'Tobacco' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('turns a surge uplift into a factor', async () => {
    activeSurge.mockResolvedValue({ id: 's1', name: 'Diwali', upliftPct: '25', endsAt: new Date() });
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows.find((row) => row.step === 'Seasonality')).toMatchObject({
      rule: 'Diwali',
      factor: '1.25×',
      running: '12500.00',
    });
  });

  it('applies the duration tier a long flight earns', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 30 });
    // 28+ days is the 4% tier on the default ladder.
    expect(sim.rows.find((row) => row.step === 'Duration')).toMatchObject({ factor: '−4%', running: '9600.00' });
  });

  it('lets an override rule replace the running rate', async () => {
    repository.rulesInForce.mockResolvedValue([
      { id: 'r1', name: 'Fixed for pilots', priority: 1, matchAny: false, adjustment: 'OVERRIDE', value: new Decimal('5000'), conditions: [] },
    ]);
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows.find((row) => row.step === 'Override')).toMatchObject({ running: '5000.00' });
  });

  it('tries an unsaved rule alongside the live ones', async () => {
    const sim = await simulate({
      listingId: 'lst_1',
      days: 7,
      previewRule: {
        name: 'Trial',
        matchAny: true,
        adjustment: 'MULTIPLIER',
        value: '1.1',
        conditions: [
          { field: 'grade', operator: 'eq', value: 'A' },
          { field: 'city', operator: 'eq', value: 'Pune' },
        ],
      },
    });
    expect(sim.rows.find((row) => row.rule === 'Trial (unsaved)')).toMatchObject({ running: '11000.00' });
  });
});

describe('the sign-offs', () => {
  it('flags a discount at the approval threshold', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7, discountPct: '10' });
    expect(sim.needsApproval).toBe(true);
    expect(sim.rows.find((row) => row.step === 'Negotiated discount')).toMatchObject({
      rule: 'Needs approval',
      factor: '−10%',
    });
    expect(revenueQuote).toHaveBeenCalledWith(expect.objectContaining({ rateDiscount: '7000.00' }));
  });

  it('flags a discount that takes the rate under the floor', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7, discountPct: '25' });
    expect(sim.belowFloor).toBe(true);
    expect(sim.floorPerDay).toBe('8000.00');
  });

  it('leaves a small discount alone', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7, discountPct: '5' });
    expect(sim.needsApproval).toBe(false);
    expect(sim.belowFloor).toBe(false);
  });
});

describe('settings', () => {
  it('picks the highest tier the flight reaches', () => {
    const tiers = [
      { minDays: 14, pct: 2 },
      { minDays: 28, pct: 4 },
      { minDays: 84, pct: 10 },
    ];
    expect(durationDiscountFor(7, tiers)).toBeNull();
    expect(durationDiscountFor(14, tiers)?.pct).toBe(2);
    expect(durationDiscountFor(60, tiers)?.pct).toBe(4);
    expect(durationDiscountFor(100, tiers)?.pct).toBe(10);
  });

  it('sorts the ladder before saving it', async () => {
    repository.upsertSettings.mockImplementation(async (patch) => ({
      roundingRupees: 100,
      minimumRatePerDay: new Decimal(0),
      minimumBookingDays: 7,
      floorProtection: true,
      approvalThresholdPct: new Decimal(10),
      discountCeilingPct: new Decimal(15),
      maxStackedUplift: new Decimal('2.2'),
      blockBelowFloor: true,
      ...patch,
    }));
    const saved = await updateSettings(
      { durationDiscounts: [{ minDays: 56, pct: 7 }, { minDays: 14, pct: 2 }] },
      'usr_1'
    );
    expect(saved.durationDiscounts.map((tier) => tier.minDays)).toEqual([14, 56]);
    expect(repository.upsertSettings).toHaveBeenCalledWith(expect.objectContaining({ updatedById: 'usr_1' }));
  });
});

/* Lot B (Q134): the agent's installation fee, as a cost line beside the advertiser's. */
describe('the agent installation fee', () => {
  it('prints the flat rate × spots beside the installation line, with the margin, and never adds it to the bill', async () => {
    const sim = await simulate({ listingId: 'lst_1', days: 7, spots: 2 });
    const rows = sim.rows.map((row) => row.step);
    const at = rows.indexOf('Installation');
    expect(rows[at + 1]).toBe('Agent installation fee (cost)');
    expect(rows[at + 2]).toBe('Installation margin');
    // The running figure does not move across the two read-only lines.
    expect(sim.rows[at + 1]!.running).toBe(sim.rows[at]!.running);
    expect(sim.rows[at + 2]!.running).toBe(sim.rows[at]!.running);
    expect(sim.rows[at + 1]!.factor).toBe('(2900.00)');
    expect(sim.installation).toEqual({ fee: '1500.00', agentCost: '2900.00', margin: '-1400.00' });
    expect(installationFeeFor).toHaveBeenCalledWith({ agentFeeAmount: null }, '*', expect.any(Date));
  });

  it('prints nothing when no agent rate is configured', async () => {
    installationFeeFor.mockResolvedValue(null);
    const sim = await simulate({ listingId: 'lst_1', days: 7 });
    expect(sim.rows.map((row) => row.step)).not.toContain('Agent installation fee (cost)');
    expect(sim.installation).toBeNull();
  });
});
