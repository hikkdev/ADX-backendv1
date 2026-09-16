import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/errors';
// `vi.mock` is hoisted above these, so the module under test loads against the
// doubles below rather than the real repository.
import { AiUnavailableError } from '../../../shared/ai';
import { generateDescription } from '../ai.service';

/**
 * The two rules that decide whether this feature costs money or destroys work.
 *
 * Everything else in the AI module is a request to somebody else's server. What
 * is genuinely ours is the refusal to overwrite a publisher's own words, and the
 * count of how many drafts they have had — and neither has a visible symptom
 * when it goes wrong. An overwrite looks like a successful generation; a
 * miscounted quota looks like a working button.
 */

// `vi.hoisted` because the `vi.mock` factories below are lifted above every
// other statement in the file, so anything they close over has to be lifted too.
const { repository, complete, getEffectiveAiConfig } = vi.hoisted(() => ({
  repository: {
    countGenerations: vi.fn(),
    recordGeneration: vi.fn(),
    hasActiveSubscription: vi.fn(),
    findPublisherIdByUserId: vi.fn(),
    listingBelongsTo: vi.fn(),
    findTranslations: vi.fn(),
    saveTranslation: vi.fn(),
    findUserLanguage: vi.fn(),
  },
  complete: vi.fn(),
  getEffectiveAiConfig: vi.fn(),
}));

vi.mock('../prisma-ai.repository', () => ({ prismaAiRepository: repository }));
vi.mock('../../../shared/ai', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/ai')>('../../../shared/ai');
  return { ...actual, complete: (...args: unknown[]) => complete(...args) };
});
vi.mock('../../../shared/integrations', () => ({
  getEffectiveAiConfig: () => getEffectiveAiConfig(),
}));

const draft = (over: Record<string, unknown> = {}) => ({
  userId: 'usr_1',
  draftKey: 'draft-abc12345',
  current: '',
  context: { title: 'Atrium LED wall', city: 'Bengaluru' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPublisherIdByUserId.mockResolvedValue('pub_1');
  repository.hasActiveSubscription.mockResolvedValue(false);
  repository.countGenerations.mockResolvedValue(0);
  repository.recordGeneration.mockResolvedValue(undefined);
  repository.listingBelongsTo.mockResolvedValue(true);
  getEffectiveAiConfig.mockResolvedValue({
    enabled: true,
    freeQuota: 3,
    paidQuota: 10,
    translateOnRead: false,
  });
  complete.mockResolvedValue({
    text: 'A four line description.',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  });
});

describe('the blank-field rule', () => {
  it('drafts into an empty field', async () => {
    const result = await generateDescription(draft());
    expect(result.text).toBe('A four line description.');
    expect(complete).toHaveBeenCalledOnce();
  });

  /**
   * The one way this feature can destroy work. An undo in the client is not a
   * defence: the request is already paid for and the words are already gone.
   */
  it('refuses to write over words the publisher already has', async () => {
    await expect(generateDescription(draft({ current: 'My own description.' }))).rejects.toThrow(
      ApiError
    );
    expect(complete).not.toHaveBeenCalled();
  });

  /** Whitespace is not writing. A field of spaces is a blank field. */
  it('treats a field of whitespace as blank', async () => {
    await expect(generateDescription(draft({ current: '   \n  ' }))).resolves.toMatchObject({
      used: 1,
    });
  });

  it('reports it as its own code, because the app clears the field on it', async () => {
    await expect(generateDescription(draft({ current: 'x' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'FIELD_NOT_EMPTY',
    });
  });
});

describe('the quota', () => {
  it('gives three drafts without a subscription', async () => {
    repository.countGenerations.mockResolvedValue(2);
    await expect(generateDescription(draft())).resolves.toMatchObject({ used: 3, quota: 3 });
  });

  it('refuses the fourth', async () => {
    repository.countGenerations.mockResolvedValue(3);
    await expect(generateDescription(draft())).rejects.toMatchObject({
      statusCode: 429,
      code: 'QUOTA_EXHAUSTED',
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('gives ten with a subscription running', async () => {
    repository.hasActiveSubscription.mockResolvedValue(true);
    repository.countGenerations.mockResolvedValue(9);
    await expect(generateDescription(draft())).resolves.toMatchObject({ used: 10, quota: 10 });
  });

  it('refuses the eleventh', async () => {
    repository.hasActiveSubscription.mockResolvedValue(true);
    repository.countGenerations.mockResolvedValue(10);
    await expect(generateDescription(draft())).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  });

  /** Free tier is told there is a way up; paid tier is not, having taken it. */
  it('offers the upgrade only to the tier that has one', async () => {
    repository.countGenerations.mockResolvedValue(3);
    await expect(generateDescription(draft())).rejects.toThrow(/subscription raises this to 10/);

    repository.hasActiveSubscription.mockResolvedValue(true);
    repository.countGenerations.mockResolvedValue(10);
    const paid = await generateDescription(draft()).catch((cause: Error) => cause);
    expect((paid as Error).message).not.toMatch(/subscription/);
  });

  /**
   * A vendor outage must not spend a draft. The record is written after the
   * model answers, so a publisher whose third attempt 502s still has a third.
   */
  it('does not spend a draft when the provider fails', async () => {
    complete.mockRejectedValue(new Error('upstream exploded'));
    await expect(generateDescription(draft())).rejects.toMatchObject({ code: 'AI_FAILED' });
    expect(repository.recordGeneration).not.toHaveBeenCalled();
  });

  /**
   * The bucket carries the publisher id even when the client names the draft.
   * A draft key is not a secret, and without the owner in the key one publisher
   * could spend another's allowance by guessing one.
   */
  it('scopes a draft bucket to the publisher who owns it', async () => {
    await generateDescription(draft());
    expect(repository.countGenerations).toHaveBeenCalledWith('pub_1', 'draft:pub_1:draft-abc12345');
  });

  it('uses the listing itself as the bucket once there is one', async () => {
    await generateDescription(draft({ draftKey: undefined, listingId: 'lst_9' }));
    expect(repository.countGenerations).toHaveBeenCalledWith('pub_1', 'listing:lst_9');
  });

  /** Asking about somebody else's listing must not reveal that it exists. */
  it('answers not-found for a listing this publisher does not own', async () => {
    repository.listingBelongsTo.mockResolvedValue(false);
    await expect(
      generateDescription(draft({ draftKey: undefined, listingId: 'lst_other' }))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('when the feature is not configured', () => {
  it('says so rather than reporting a failed generation', async () => {
    complete.mockRejectedValue(new AiUnavailableError('AI features are turned off.'));
    await expect(generateDescription(draft())).rejects.toMatchObject({
      statusCode: 503,
      code: 'AI_UNAVAILABLE',
    });
  });

  it('refuses a caller who is not a publisher', async () => {
    repository.findPublisherIdByUserId.mockResolvedValue(null);
    await expect(generateDescription(draft())).rejects.toMatchObject({ statusCode: 403 });
  });
});
