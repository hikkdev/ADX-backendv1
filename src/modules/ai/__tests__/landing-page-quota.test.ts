import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-2 (Lot E addendum 2) — the advertiser's side of the quota.
 *
 * A campaign's landing page is redrafted under the same two numbers a
 * listing description is: three free, ten with a plan ACTIVE. The bucket is
 * the campaign, the owner column is `advertiserId`, the kind LANDING_PAGE,
 * and `publisherId` is null on the row.
 */

const { repository, getEffectiveAiConfig } = vi.hoisted(() => ({
  repository: {
    countGenerations: vi.fn(),
    countAdvertiserGenerations: vi.fn(),
    recordGeneration: vi.fn(),
    hasActiveSubscription: vi.fn(),
    hasActivePlan: vi.fn(),
    findPublisherIdByUserId: vi.fn(),
    listingBelongsTo: vi.fn(),
    findTranslations: vi.fn(),
    saveTranslation: vi.fn(),
    findUserLanguage: vi.fn(),
  },
  getEffectiveAiConfig: vi.fn(),
}));

vi.mock('../prisma-ai.repository', () => ({ prismaAiRepository: repository }));
vi.mock('../../../shared/integrations', () => ({ getEffectiveAiConfig: () => getEffectiveAiConfig() }));

import { assertLandingPageQuota, landingPageQuota, recordLandingPageGeneration } from '../ai.service';

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveAiConfig.mockResolvedValue({ enabled: true, freeQuota: 3, paidQuota: 10, translateOnRead: false });
  repository.hasActivePlan.mockResolvedValue(false);
  repository.countAdvertiserGenerations.mockResolvedValue(0);
  repository.recordGeneration.mockResolvedValue(undefined);
});

describe('the landing-page quota', () => {
  it('counts the campaign bucket against three free, ten with a plan', async () => {
    repository.countAdvertiserGenerations.mockResolvedValue(2);
    expect(await landingPageQuota('adv_1', 'cmp_1')).toEqual({ used: 2, quota: 3, paid: false });
    expect(repository.countAdvertiserGenerations).toHaveBeenCalledWith('adv_1', 'cmp_1');

    repository.hasActivePlan.mockResolvedValue(true);
    expect(await landingPageQuota('adv_1', 'cmp_1')).toEqual({ used: 2, quota: 10, paid: true });
  });

  it('refuses 429 QUOTA_EXHAUSTED once the page has had its drafts, and lets the next one through below it', async () => {
    repository.countAdvertiserGenerations.mockResolvedValue(3);
    await expect(assertLandingPageQuota('adv_1', 'cmp_1')).rejects.toMatchObject({ statusCode: 429, code: 'QUOTA_EXHAUSTED' });
    repository.countAdvertiserGenerations.mockResolvedValue(2);
    await expect(assertLandingPageQuota('adv_1', 'cmp_1')).resolves.toEqual({ used: 2, quota: 3, paid: false });
  });

  it('records the row against the advertiser, the campaign as the subject, kind LANDING_PAGE, no publisher', async () => {
    await recordLandingPageGeneration({ advertiserId: 'adv_1', campaignId: 'cmp_1', provider: 'anthropic', model: 'claude-sonnet-5', output: '{"hero":{}}' });
    expect(repository.recordGeneration).toHaveBeenCalledWith({
      publisherId: null,
      advertiserId: 'adv_1',
      subjectKey: 'cmp_1',
      kind: 'LANDING_PAGE',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      output: '{"hero":{}}',
    });
  });
});
