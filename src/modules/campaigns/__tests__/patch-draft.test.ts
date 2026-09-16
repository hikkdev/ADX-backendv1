import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Saving one screen of the seventeen.
 *
 * The case that matters here is the branch blocks. Each is asked in two moves —
 * choose a path, then fill its detail on the screen after it — and the wizard
 * lets an advertiser step back onto the choosing screen and save again, from
 * the review screen's "Change" in a single tap. A save that carries only the
 * discriminant must therefore leave the detail alone; only a change of branch
 * may clear it.
 */

const { repository, assertCityAllows } = vi.hoisted(() => ({
  assertCityAllows: vi.fn(),
  repository: {
    findCampaignBare: vi.fn(),
    updateCampaign: vi.fn(),
    replacePois: vi.fn(),
    findCampaign: vi.fn(),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
// Lot X-B: the key beside the market.
vi.mock('../../pricing', () => ({
  assertCityAllows,
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
}));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));

import { patchDraft } from '../campaigns.service';
import { ApiError } from '../../../shared/errors';

const ADMIN = { userId: 'usr_1', isAdmin: true, advertiserId: null, agentId: null };

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  status: 'DRAFT',
  advertiserId: 'adv_1',
  agentId: null,
  triggerType: 'NONE',
  triggerConfig: null,
  creativePath: null,
  creativeConfig: null,
  trackingMethod: 'NONE',
  trackingConfig: null,
  startDate: null,
  endDate: null,
  ...over,
});

/** The fields handed to the repository by the patch under test. */
const written = () => {
  const calls = repository.updateCampaign.mock.calls;
  return calls.length === 0 ? {} : calls[calls.length - 1]![1];
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCampaign.mockResolvedValue({ id: 'cmp_1' });
  assertCityAllows.mockResolvedValue(undefined);
});

describe('a branch save that carries its config', () => {
  it('writes the config beside the discriminant', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    const config = { destinationUrl: 'https://anitascoffee.in/offer' };

    await patchDraft(
      'cmp_1',
      { tracking: { trackingMethod: 'QR_OR_DEEPLINK', trackingConfig: config } },
      ADMIN,
    );

    expect(written()).toMatchObject({
      trackingMethod: 'QR_OR_DEEPLINK',
      trackingConfig: config,
    });
  });
});

describe('a branch save that carries only the discriminant', () => {
  /*
   * The regression this file exists for: pressing Back to "How will you track?"
   * and saving the same method again used to replace the typed destination URL
   * with null, and the review screen's "Change" lands on exactly that screen.
   */
  it('leaves the stored config alone when the branch has not changed', async () => {
    repository.findCampaignBare.mockResolvedValue(
      stored({
        trackingMethod: 'QR_OR_DEEPLINK',
        trackingConfig: { destinationUrl: 'https://anitascoffee.in/offer' },
      }),
    );

    await patchDraft('cmp_1', { tracking: { trackingMethod: 'QR_OR_DEEPLINK' } }, ADMIN);

    expect(written()).toEqual({ trackingMethod: 'QR_OR_DEEPLINK' });
    expect(written()).not.toHaveProperty('trackingConfig');
  });

  it('keeps a creative brief across a re-save of the same path', async () => {
    const brief = { objective: 'Footfall', keyMessage: 'Half price Fridays', style: 'CLEAN_AND_MINIMAL' };
    repository.findCampaignBare.mockResolvedValue(
      stored({ creativePath: 'ADX_DESIGN_AGENCY', creativeConfig: brief }),
    );

    await patchDraft('cmp_1', { creative: { creativePath: 'ADX_DESIGN_AGENCY' } }, ADMIN);

    expect(written()).toEqual({ creativePath: 'ADX_DESIGN_AGENCY' });
  });

  /*
   * Clearing on a real change is the other half of the rule: a QR destination
   * means nothing once the method is VANITY_OR_PROMO.
   */
  it('clears the stored config when the branch changes', async () => {
    repository.findCampaignBare.mockResolvedValue(
      stored({
        trackingMethod: 'QR_OR_DEEPLINK',
        trackingConfig: { destinationUrl: 'https://anitascoffee.in/offer' },
      }),
    );

    await patchDraft('cmp_1', { tracking: { trackingMethod: 'VANITY_OR_PROMO' } }, ADMIN);

    expect(written()).toEqual({ trackingMethod: 'VANITY_OR_PROMO', trackingConfig: null });
  });

  /*
   * The arms that carry no config at all need no special case: reaching one is
   * always a change of discriminant, so the clear above covers them.
   */
  it('clears a weather trigger when the advertiser drops back to no trigger', async () => {
    repository.findCampaignBare.mockResolvedValue(
      stored({ triggerType: 'WEATHER', triggerConfig: { conditions: ['RAIN_OR_DRIZZLE'] } }),
    );

    await patchDraft('cmp_1', { trigger: { triggerType: 'NONE' } }, ADMIN);

    expect(written()).toEqual({ triggerType: 'NONE', triggerConfig: null });
  });

  it('leaves nothing behind under a path that has no config of its own', async () => {
    repository.findCampaignBare.mockResolvedValue(
      stored({ creativePath: 'DYNAMIC_HTML5', creativeConfig: { endpointUrl: 'https://a.in/feed' } }),
    );

    await patchDraft('cmp_1', { creative: { creativePath: 'STATIC_IMAGES' } }, ADMIN);
    expect(written()).toEqual({ creativePath: 'STATIC_IMAGES', creativeConfig: null });

    // And a second save of the same path keeps that null rather than resurrecting it.
    repository.findCampaignBare.mockResolvedValue(
      stored({ creativePath: 'STATIC_IMAGES', creativeConfig: null }),
    );
    await patchDraft('cmp_1', { creative: { creativePath: 'STATIC_IMAGES' } }, ADMIN);
    expect(written()).toEqual({ creativePath: 'STATIC_IMAGES' });
  });
});

describe('the rest of the patch', () => {
  it('still refuses a flight that ends before it starts', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    await expect(
      patchDraft(
        'cmp_1',
        { startDate: new Date('2026-04-10T00:00:00Z'), endDate: new Date('2026-04-01T00:00:00Z') },
        ADMIN,
      ),
    ).rejects.toThrow(/cannot end before it starts/);
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });

  it('does not write a row at all when the patch is only POIs', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    await patchDraft('cmp_1', { pois: [{ label: 'Cubbon Park' }] }, ADMIN);

    expect(repository.updateCampaign).not.toHaveBeenCalled();
    expect(repository.replacePois).toHaveBeenCalledWith('cmp_1', [
      { label: 'Cubbon Park', address: null, latitude: null, longitude: null },
    ]);
  });
});

/**
 * Lot A (Q31): a campaign may not target a geography ADX has closed.
 *
 * Checked only when the patch actually names the market, so a later screen's
 * save is not refused for a market chosen before ops closed it — and, as
 * everywhere else, a market with no City row at all passes.
 */
describe('the market a campaign targets', () => {
  it('asks the city table only when the patch names it', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    await patchDraft('cmp_1', { targetMarket: 'Bengaluru' } as never, ADMIN);
    expect(assertCityAllows).toHaveBeenCalledWith('Bengaluru', 'demand');

    assertCityAllows.mockClear();
    await patchDraft('cmp_1', { step: 4 } as never, ADMIN);
    expect(assertCityAllows).not.toHaveBeenCalled();
  });

  it('refuses a closed one before anything is written', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    assertCityAllows.mockRejectedValueOnce(
      new ApiError(400, 'CITY_NOT_OPEN', 'ADX is not open for campaigns in Kochi (planned).'),
    );
    await expect(patchDraft('cmp_1', { targetMarket: 'Kochi' } as never, ADMIN)).rejects.toMatchObject({
      code: 'CITY_NOT_OPEN',
    });
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });

  it('lets a market being cleared through — nothing is being targeted', async () => {
    repository.findCampaignBare.mockResolvedValue(stored());
    await patchDraft('cmp_1', { targetMarket: null } as never, ADMIN);
    expect(assertCityAllows).not.toHaveBeenCalled();
  });
});
