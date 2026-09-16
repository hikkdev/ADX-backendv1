import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevenueRepository } from '../revenue.repository';

const repository = vi.hoisted(
  () =>
    ({
      pricingInputs: vi.fn(),
      listCommissionRates: vi.fn(),
      upsertCommissionRate: vi.fn(),
      listSubscriptions: vi.fn(),
      createSubscription: vi.fn(),
      endSubscription: vi.fn(),
      findSubscription: vi.fn(),
      findRunningSubscription: vi.fn(),
      findRunningSubscriptions: vi.fn(),
      findLapsedSubscription: vi.fn(),
      findLapsedSubscriptions: vi.fn(),
      listOverrides: vi.fn(),
      createOverride: vi.fn(),
      listFees: vi.fn(),
      findFee: vi.fn(),
      createFee: vi.fn(),
      updateFee: vi.fn(),
      getTaxSettings: vi.fn(),
      updateTaxSettings: vi.fn(),
      upsertPriceLock: vi.fn(),
      findPriceLock: vi.fn(),
      consumePriceLock: vi.fn(),
      listingForQuote: vi.fn(),
    }) satisfies Record<keyof RevenueRepository, ReturnType<typeof vi.fn>>
);

vi.mock('../prisma-revenue.repository', () => ({ prismaRevenueRepository: repository }));

import {
    commissionForListing,
    grantCommissionOverride,
    heldRate,
    lockDuration,
    lockPrice,
    quote,
    resolveCommission,
    setCommissionRate,
} from '../revenue.service';

const LISTING = {
    id: 'lst_1',
    publisherId: 'pub_1',
    category: 'OUTDOOR' as const,
    ratePerDay: '1000.00',
    title: 'Andheri East hoarding',
    mediaTypeId: 'mt_hoarding',
};

const inputs = (overrides: Record<string, unknown> = {}) => ({
    defaultCommission: { ratePct: '0.20' },
    categoryCommission: null,
    mediaTypeCommission: null,
    mediaTypeSlabCommission: null,
    subscription: null,
    override: null,
    fees: [],
    tax: { mediaGstPct: '0.18' },
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    repository.listingForQuote.mockResolvedValue(LISTING);
    repository.pricingInputs.mockResolvedValue(inputs());
});

describe('commission resolution', () => {
    /**
     * Most specific wins, and the override beats the subscription deliberately:
     * it exists to win one particular publisher, usually at a worse rate for ADX
     * than any tier, so losing that negotiation to a tier they also hold would
     * defeat the point of having made it.
     */
    it('prefers a promotional override over everything', () => {
        expect(
            resolveCommission(
                inputs({
                    override: { ratePct: '0.05' },
                    subscription: { ratePct: '0.10' },
                    categoryCommission: { ratePct: '0.15' },
                }) as never
            )
        ).toEqual({ ratePct: '0.05', source: 'PROMOTIONAL_OVERRIDE' });
    });

    it('prefers a subscription over the category rate', () => {
        expect(
            resolveCommission(
                inputs({ subscription: { ratePct: '0.10' }, categoryCommission: { ratePct: '0.15' } }) as never
            )
        ).toEqual({ ratePct: '0.1', source: 'SUBSCRIPTION' });
    });

    it('prefers the category rate over the platform default', () => {
        expect(
            resolveCommission(inputs({ categoryCommission: { ratePct: '0.15' } }) as never)
        ).toEqual({ ratePct: '0.15', source: 'CATEGORY_RATE' });
    });

    /**
     * Lot B (Q10/Q38): the pricing engine's own "ad type" sits between the
     * subscription and the category — override, subscription, media-type
     * slab, media type, category, default. A slab row (a rental band on the
     * per-day media value) beats the plain media-type row because it is the
     * more specific claim about the same spot.
     */
    it('prefers a media-type slab over the plain media-type rate', () => {
        expect(
            resolveCommission(
                inputs({
                    mediaTypeSlabCommission: { ratePct: '0.12' },
                    mediaTypeCommission: { ratePct: '0.14' },
                    categoryCommission: { ratePct: '0.15' },
                }) as never
            )
        ).toEqual({ ratePct: '0.12', source: 'MEDIA_TYPE_SLAB' });
    });

    it('prefers the media-type rate over the category rate', () => {
        expect(
            resolveCommission(
                inputs({ mediaTypeCommission: { ratePct: '0.14' }, categoryCommission: { ratePct: '0.15' } }) as never
            )
        ).toEqual({ ratePct: '0.14', source: 'MEDIA_TYPE' });
    });

    it('lets a subscription beat every media-type row', () => {
        expect(
            resolveCommission(
                inputs({ subscription: { ratePct: '0.10' }, mediaTypeSlabCommission: { ratePct: '0.12' } }) as never
            )
        ).toEqual({ ratePct: '0.1', source: 'SUBSCRIPTION' });
    });

    /**
     * There is no guess any more. The seed writes the platform default and
     * the console cannot retire it without replacing it; a quote that finds
     * no row refuses with a code the console can name, rather than pricing
     * the marketplace at a number nobody chose.
     */
    it('refuses to price when the platform default is missing', () => {
        expect(() => resolveCommission(inputs({ defaultCommission: null }) as never)).toThrow(
            expect.objectContaining({ statusCode: 409, code: 'COMMISSION_DEFAULT_MISSING' })
        );
    });
});

describe('what the quote asks the repository for', () => {
    /**
     * The slab is keyed on the per-day media value the advertiser is billed
     * for — after the rate discount, before the campaign discount and fees —
     * per unit, so a quantity of three does not push one ₹1,000 spot into the
     * ₹3,000 band.
     */
    it('passes the listing media type and the discounted per-day value per unit', async () => {
        await quote({ listingId: 'lst_1', days: 10, spots: 2, rateDiscount: '2000' });
        expect(repository.pricingInputs).toHaveBeenCalledWith(
            expect.objectContaining({
                publisherId: 'pub_1',
                category: 'OUTDOOR',
                mediaTypeId: 'mt_hoarding',
                perDayMediaValue: '900.00',
            })
        );
    });

    it('names the source on the quote', async () => {
        repository.pricingInputs.mockResolvedValue(inputs({ mediaTypeCommission: { ratePct: '0.14' } }));
        const result = await quote({ listingId: 'lst_1', days: 10 });
        expect(result.publisher.commissionSource).toBe('MEDIA_TYPE');
        expect(result.publisher.commissionPct).toBe('0.14');
    });

    /** The accrual's late resolution for spots authorised before the stamp existed. */
    it('resolves a commission for a listing on its own, at a date', async () => {
        repository.pricingInputs.mockResolvedValue(inputs({ mediaTypeSlabCommission: { ratePct: '0.12' } }));
        const at = new Date('2026-09-01T00:00:00Z');
        const result = await commissionForListing({ listingId: 'lst_1', ratePerDay: '1000.00', at });
        expect(result).toEqual({ ratePct: '0.12', source: 'MEDIA_TYPE_SLAB' });
        expect(repository.pricingInputs).toHaveBeenCalledWith(
            expect.objectContaining({ mediaTypeId: 'mt_hoarding', perDayMediaValue: '1000.00', at })
        );
    });

    it('refuses to resolve a commission for a listing that does not exist', async () => {
        repository.listingForQuote.mockResolvedValue(null);
        await expect(
            commissionForListing({ listingId: 'lst_missing', ratePerDay: '1000.00', at: new Date() })
        ).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('the quote', () => {
    it('prices the media line and splits the two sides', async () => {
        const result = await quote({ listingId: 'lst_1', days: 10 });
        expect(result.netValue).toBe('10000.00');
        expect(result.gstAmount).toBe('1800.00');
        expect(result.grossTotal).toBe('11800.00');
        // Commission comes out of the publisher, never added to the advertiser.
        expect(result.publisher.commissionAmount).toBe('2000.00');
        expect(result.publisher.netEarnings).toBe('8000.00');
        expect(result.payable).toBe('11800.00');
    });

    it('multiplies by spots as well as days', async () => {
        const result = await quote({ listingId: 'lst_1', days: 10, spots: 3 });
        expect(result.netValue).toBe('30000.00');
    });

    /**
     * The two reductions are not interchangeable, and collapsing them into one
     * "discount" field is a tax error rather than a rounding one.
     */
    it('takes a rate discount off the taxable value, before GST', async () => {
        const result = await quote({ listingId: 'lst_1', days: 10, rateDiscount: '1000' });
        expect(result.netValue).toBe('9000.00');
        expect(result.gstAmount).toBe('1620.00');
        expect(result.grossTotal).toBe('10620.00');
        // The publisher earns on the discounted value, and so does commission.
        expect(result.publisher.grossEarnings).toBe('9000.00');
        expect(result.publisher.commissionAmount).toBe('1800.00');
    });

    it('applies goodwill to the gross, after GST, as a payment', async () => {
        const result = await quote({ listingId: 'lst_1', days: 10, goodwill: '1000' });
        // Unchanged: goodwill is not a price cut, so it must not reduce the tax.
        expect(result.netValue).toBe('10000.00');
        expect(result.gstAmount).toBe('1800.00');
        expect(result.grossTotal).toBe('11800.00');
        expect(result.payable).toBe('10800.00');
    });

    it('never lets goodwill exceed what is owed', async () => {
        const result = await quote({ listingId: 'lst_1', days: 1, goodwill: '999999' });
        expect(result.payable).toBe('0.00');
        expect(result.goodwillApplied).toBe('1180.00');
    });

    it('refuses a discount larger than the media value', async () => {
        await expect(
            quote({ listingId: 'lst_1', days: 1, rateDiscount: '5000' })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('taxes each line at its own rate rather than averaging', async () => {
        repository.pricingInputs.mockResolvedValue(
            inputs({
                fees: [
                    {
                        kind: 'PLATFORM',
                        name: 'Platform fee',
                        percentPct: '0.005',
                        flatAmount: null,
                        gstPct: '0.18',
                        amountShownInCart: false,
                        perSpot: false,
                    },
                    {
                        kind: 'PRINTING',
                        name: 'Printing',
                        percentPct: null,
                        flatAmount: '2000',
                        gstPct: '0.05',
                        amountShownInCart: false,
                        perSpot: true,
                    },
                ],
            })
        );
        const result = await quote({ listingId: 'lst_1', days: 10 });
        const printing = result.lines.find((line) => line.kind === 'PRINTING');
        expect(printing?.gstAmount).toBe('100.00');
        expect(result.lines.find((line) => line.kind === 'PLATFORM')?.taxableValue).toBe('50.00');
        expect(result.netValue).toBe('12050.00');
    });

    /**
     * A percentage fee is charged on the discounted media value. Computing it on
     * the undiscounted figure would quietly claw back part of the discount.
     */
    it('charges a percentage fee on what the advertiser actually buys', async () => {
        repository.pricingInputs.mockResolvedValue(
            inputs({
                fees: [
                    {
                        kind: 'PLATFORM',
                        name: 'Platform fee',
                        percentPct: '0.10',
                        flatAmount: null,
                        gstPct: '0.18',
                        amountShownInCart: false,
                        perSpot: false,
                    },
                ],
            })
        );
        const result = await quote({ listingId: 'lst_1', days: 10, rateDiscount: '2000' });
        expect(result.lines.find((line) => line.kind === 'PLATFORM')?.taxableValue).toBe('800.00');
    });

    it('charges a per-spot fee once per spot', async () => {
        repository.pricingInputs.mockResolvedValue(
            inputs({
                fees: [
                    {
                        kind: 'INSTALLATION',
                        name: 'Installation',
                        percentPct: null,
                        flatAmount: '500',
                        gstPct: '0.18',
                        amountShownInCart: false,
                        perSpot: true,
                    },
                ],
            })
        );
        const result = await quote({ listingId: 'lst_1', days: 1, spots: 4 });
        expect(result.lines.find((line) => line.kind === 'INSTALLATION')?.taxableValue).toBe(
            '2000.00'
        );
    });

    /**
     * The cart shows the media total and names every mandatory fee it is not
     * yet totalling. A cart implying the media rate is the price, revealing
     * charges only at checkout, is the drip-pricing pattern the CCPA guidelines
     * name — naming them costs the clean cart nothing.
     */
    it('names withheld fees in the cart even without their amounts', async () => {
        repository.pricingInputs.mockResolvedValue(
            inputs({
                fees: [
                    {
                        kind: 'PLATFORM',
                        name: 'Platform fee',
                        percentPct: '0.005',
                        flatAmount: null,
                        gstPct: '0.18',
                        amountShownInCart: false,
                        perSpot: false,
                    },
                    {
                        kind: 'DESIGN',
                        name: 'Creative design',
                        percentPct: null,
                        flatAmount: '3000',
                        gstPct: '0.18',
                        amountShownInCart: true,
                        perSpot: false,
                    },
                ],
            })
        );
        const result = await quote({ listingId: 'lst_1', days: 10 });
        expect(result.hasUndisclosedFees).toBe(true);
        expect(result.disclosedFeeNames).toEqual(['Platform fee']);
        // Design is priced into the cart total; the platform fee is not.
        expect(result.cartTotal).toBe('15340.00');
    });

    it('refuses to quote a listing with no rate', async () => {
        repository.listingForQuote.mockResolvedValue({ ...LISTING, ratePerDay: null });
        await expect(quote({ listingId: 'lst_1', days: 1 })).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    it('prices against a held rate when one is supplied', async () => {
        const result = await quote({ listingId: 'lst_1', days: 1, ratePerDay: '800' });
        expect(result.netValue).toBe('800.00');
    });
});

describe('price locks', () => {
    it('holds an ordinary cart for thirty minutes and a bulk cart for a day', () => {
        expect(lockDuration(1)).toBe(30);
        expect(lockDuration(5)).toBe(30);
        expect(lockDuration(6)).toBe(60 * 24);
    });

    it('locks the rate as it stands', async () => {
        repository.upsertPriceLock.mockImplementation(async (data: { ratePerDay: string }) => ({
            ...data,
            expiresAt: new Date('2026-09-08T10:30:00Z'),
        }));
        const result = await lockPrice({
            advertiserId: 'adv_1',
            listingId: 'lst_1',
            spotsInCart: 1,
            at: new Date('2026-09-08T10:00:00Z'),
        });
        expect(result.ratePerDay).toBe('1000.00');
        expect(repository.upsertPriceLock).toHaveBeenCalledWith(
            expect.objectContaining({ expiresAt: new Date('2026-09-08T10:30:00Z') })
        );
    });

    /**
     * Expiry is by timestamp rather than by a sweeper, so there is no window in
     * which a stale lock is still honoured because a job has not run.
     */
    it('stops resolving once it expires', async () => {
        repository.findPriceLock.mockResolvedValue({
            ratePerDay: '900',
            expiresAt: new Date('2026-09-08T10:00:00Z'),
            consumedAt: null,
        });
        expect(await heldRate('adv_1', 'lst_1', new Date('2026-09-08T09:59:00Z'))).toBe('900.00');
        expect(await heldRate('adv_1', 'lst_1', new Date('2026-09-08T10:00:01Z'))).toBeNull();
    });

    it('stops resolving once it has been used', async () => {
        repository.findPriceLock.mockResolvedValue({
            ratePerDay: '900',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
            consumedAt: new Date('2026-09-08T09:00:00Z'),
        });
        expect(await heldRate('adv_1', 'lst_1', new Date('2026-09-08T09:59:00Z'))).toBeNull();
    });
});

describe('guards on configuration', () => {
    /**
     * 15 instead of 0.15 would hand a publisher fifteen times their earnings.
     * The column has a CHECK for the same reason; this makes it a 400 with a
     * sentence rather than a constraint violation rendered as a 500.
     */
    it('refuses a rate written as a whole percentage', async () => {
        await expect(
            setCommissionRate({ category: null, ratePct: '15', note: null, userId: 'usr_1' })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses a slab whose floor is above its ceiling', async () => {
        await expect(
            setCommissionRate({
                category: null,
                mediaTypeId: 'mt_hoarding',
                minMediaValue: '5000',
                maxMediaValue: '1000',
                ratePct: '0.12',
                note: null,
                userId: 'usr_1',
            })
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(repository.upsertCommissionRate).not.toHaveBeenCalled();
    });

    it('refuses a slab without a media type — a rental band needs a subject', async () => {
        await expect(
            setCommissionRate({
                category: null,
                mediaTypeId: null,
                minMediaValue: '1000',
                maxMediaValue: null,
                ratePct: '0.12',
                note: null,
                userId: 'usr_1',
            })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses a row keyed on both a category and a media type', async () => {
        await expect(
            setCommissionRate({
                category: 'OUTDOOR',
                mediaTypeId: 'mt_hoarding',
                minMediaValue: null,
                maxMediaValue: null,
                ratePct: '0.12',
                note: null,
                userId: 'usr_1',
            })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('writes a media-type slab as money strings', async () => {
        repository.upsertCommissionRate.mockResolvedValue({ id: 'cr_1' });
        await setCommissionRate({
            category: null,
            mediaTypeId: 'mt_hoarding',
            minMediaValue: '1000',
            maxMediaValue: '5000.5',
            ratePct: '0.12',
            note: 'Mid band',
            userId: 'usr_1',
        });
        expect(repository.upsertCommissionRate).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaTypeId: 'mt_hoarding',
                minMediaValue: '1000.00',
                maxMediaValue: '5000.50',
                ratePct: '0.12',
            })
        );
    });

    it('requires a reason for giving up ADX revenue', async () => {
        await expect(
            grantCommissionOverride({
                publisherId: 'pub_1',
                ratePct: '0.05',
                reason: ' ',
                approvedById: 'usr_1',
                startsAt: new Date(),
                endsAt: null,
            })
        ).rejects.toMatchObject({ statusCode: 400 });
    });
});
