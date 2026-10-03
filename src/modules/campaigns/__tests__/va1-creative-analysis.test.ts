import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VA-1 — the vision pass over an artwork.
 *
 * Pinned: the model is shown the downsized picture with what the platform
 * knows about the campaign and held to a JSON answer; a flag outside the
 * vocabulary becomes OTHER rather than losing the answer; uniqueness is
 * arithmetic over the other creatives' hashes and the threshold is one
 * number; a video is refused before any vendor is called; "switched off"
 * is a 503 and a vendor failure a 502; and the run is kept as its own row
 * with an audit line, never as a decision on the creative.
 */

const { repository, ai, uploads, audit } = vi.hoisted(() => ({
  repository: {
    findCreative: vi.fn(),
    updateCreative: vi.fn(async () => ({})),
    listCreativeHashes: vi.fn(async (): Promise<{ id: string; perceptualHash: string | null }[]> => []),
    createCreativeAnalysis: vi.fn(),
    latestCreativeAnalysis: vi.fn(),
    listCreativesAwaitingAnalysis: vi.fn(async (): Promise<{ id: string }[]> => []),
  },
  ai: { complete: vi.fn() },
  uploads: {
    readImageForModel: vi.fn(async () => ({ base64: 'QUJD', mimeType: 'image/jpeg', perceptualHash: 'aaaaaaaaaaaaaaaa', width: 1024, height: 768 })),
    isModelReadableImage: (mime: string | null) => !!mime && mime.startsWith('image/'),
    hammingDistance: (a: string, b: string) => {
      let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
      let n = 0;
      while (x) {
        n += Number(x & 1n);
        x >>= 1n;
      }
      return n;
    },
  },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: audit.logActivity }));
vi.mock('../../../shared/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/ai')>();
  return { ...actual, complete: (...args: unknown[]) => ai.complete(...args) };
});

import { AiUnavailableError } from '../../../shared/ai';
import { ANALYSE_BATCH_LIMIT, ANALYSIS_FLAGS, UNIQUE_DISTANCE, analyseCreative, analyseCreatives, creativePrompt, nearestByHash, parseAnalysisAnswer } from '../creative-analysis.service';

const creative = (over: Record<string, unknown> = {}) => ({
  id: 'crt_1',
  campaignId: 'cmp_1',
  spotId: 'spt_1',
  fileUrl: 'http://api.test/api/v1/files/f1',
  mimeType: 'image/png',
  widthPx: 3000,
  heightPx: 1000,
  campaign: { id: 'cmp_1', name: 'Monsoon sale', industry: 'Retail', advertiser: { id: 'adv_1', name: 'Ravi', companyName: 'Sharma Textiles' } },
  spot: { id: 'spt_1', listingId: 'lst_1', listing: { id: 'lst_1', title: 'MG Road hoarding', city: 'Bengaluru', widthFt: '30', heightFt: '10' } },
  ...over,
});

const ANSWER = {
  appropriate: { verdict: 'PASS', reason: 'A sari on a mannequin.' },
  relevant: { verdict: 'PASS', reason: 'A textile shop advertising a sale.' },
  legal: { verdict: 'UNSURE', reason: '"Up to 70% off" with no terms visible.' },
  rating: 'PG',
  ratingReason: 'Nothing a child should not see.',
  flags: ['PRICE_CLAIM', 'MISSING_DISCLAIMER', 'SPARKLY'],
  summary: 'A clean retail creative; the discount claim wants a terms line.',
  confidence: 0.82,
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCreative.mockResolvedValue(creative());
  repository.listCreativeHashes.mockResolvedValue([]);
  repository.createCreativeAnalysis.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'ana_1', createdAt: new Date('2026-09-23T10:00:00Z'), raw: null, ...data }));
  ai.complete.mockResolvedValue({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``, provider: 'anthropic', model: 'claude-sonnet-5' });
});

describe('the answer', () => {
  it('is read out of whatever prose and fences the model wrapped it in, and a flag outside the vocabulary becomes OTHER', () => {
    const parsed = parseAnalysisAnswer(`Sure.\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`\nAnything else?`);
    expect(parsed.appropriate.verdict).toBe('PASS');
    expect(parsed.flags).toEqual(['PRICE_CLAIM', 'MISSING_DISCLAIMER', 'OTHER']);
    expect(ANALYSIS_FLAGS).toContain('OTHER');
  });

  it('is refused when the shape is wrong', () => {
    expect(() => parseAnalysisAnswer('I cannot see an image.')).toThrow(/no JSON object/);
    expect(() => parseAnalysisAnswer('{"appropriate":{"verdict":"MAYBE"}}')).toThrow();
  });
});

describe('the prompt', () => {
  it('tells the model who the advertiser is, what they do, and where the artwork hangs', () => {
    const prompt = creativePrompt(creative() as never);
    expect(prompt).toContain('Advertiser: Sharma Textiles');
    expect(prompt).toContain("Advertiser's industry: Retail");
    expect(prompt).toContain('Placement: MG Road hoarding, Bengaluru');
    expect(prompt).toContain('Spot size: 30 × 10 ft');
    expect(prompt).toContain('Artwork: 3000 × 1000 px');
  });
});

describe('uniqueness', () => {
  it('is the nearest other hash, and the threshold is one number', () => {
    const others = [
      { id: 'crt_far', perceptualHash: 'ffffffffffffffff' },
      { id: 'crt_near', perceptualHash: 'aaaaaaaaaaaaaaab' },
      { id: 'crt_none', perceptualHash: null },
    ];
    expect(nearestByHash('aaaaaaaaaaaaaaaa', others)).toEqual({ creativeId: 'crt_near', distance: 1 });
    expect(nearestByHash('aaaaaaaaaaaaaaaa', [])).toBeNull();
    expect(UNIQUE_DISTANCE).toBe(10);
  });
});

describe('analysing a creative', () => {
  it('shows the model the downsized picture with the campaign, keeps the run as a row, and says whether it is unique', async () => {
    repository.listCreativeHashes.mockResolvedValue([{ id: 'crt_old', perceptualHash: 'aaaaaaaaaaaaaaab' }]);
    const view = await analyseCreative('crt_1', { userId: 'usr_admin' });

    const request = ai.complete.mock.calls[0]![0] as { images: { mimeType: string; base64: string }[]; prompt: string; temperature: number };
    expect(request.images).toEqual([{ mimeType: 'image/jpeg', base64: 'QUJD' }]);
    expect(request.prompt).toContain('Sharma Textiles');
    expect(request.temperature).toBeLessThanOrEqual(0.2);

    // The hash is kept on the creative for the next comparison.
    expect(repository.updateCreative).toHaveBeenCalledWith('crt_1', { perceptualHash: 'aaaaaaaaaaaaaaaa' });
    // One bit from an older creative: the same picture.
    expect(view.unique).toBe(false);
    expect(view.nearest).toEqual({ creativeId: 'crt_old', distance: 1 });

    expect(view).toMatchObject({
      appropriate: { verdict: 'PASS', reason: 'A sari on a mannequin.' },
      legal: { verdict: 'UNSURE' },
      rating: 'PG',
      flags: ['PRICE_CLAIM', 'MISSING_DISCLAIMER', 'OTHER'],
      confidence: 0.82,
      provider: 'anthropic',
    });
    expect(repository.createCreativeAnalysis).toHaveBeenCalledWith(expect.objectContaining({ creativeId: 'crt_1', requestedByUserId: 'usr_admin', unique: false, nearestCreativeId: 'crt_old' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CREATIVE_ANALYSED', expect.objectContaining({ targetId: 'crt_1' }));
    // Never a decision: the creative's own status and checks are untouched.
    expect(repository.updateCreative).toHaveBeenCalledTimes(1);
  });

  it('is unique with nothing to compare against', async () => {
    const view = await analyseCreative('crt_1', { userId: 'usr_admin' });
    expect(view.unique).toBe(true);
    expect(view.nearest).toBeNull();
  });

  it('refuses a video before any vendor is called, and a creative with nothing uploaded', async () => {
    repository.findCreative.mockResolvedValue(creative({ mimeType: 'video/mp4' }));
    await expect(analyseCreative('crt_1', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409, code: 'ANALYSIS_UNSUPPORTED' });
    repository.findCreative.mockResolvedValue(creative({ fileUrl: null }));
    await expect(analyseCreative('crt_1', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409, code: 'NO_FILE' });
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('tells "switched off" from a vendor that fell over, and from an answer in the wrong shape', async () => {
    ai.complete.mockRejectedValueOnce(new AiUnavailableError('AI features are turned off for this deployment.'));
    await expect(analyseCreative('crt_1', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 503, code: 'AI_UNAVAILABLE' });
    ai.complete.mockRejectedValueOnce(new Error('The AI provider could not be reached.'));
    await expect(analyseCreative('crt_1', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 502, code: 'AI_FAILED' });
    ai.complete.mockResolvedValueOnce({ text: 'I see a poster.', provider: 'openai', model: 'gpt-4o-mini' });
    await expect(analyseCreative('crt_1', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 502, code: 'AI_FAILED' });
    expect(repository.createCreativeAnalysis).not.toHaveBeenCalled();
  });
});

describe('the batch (VA-4)', () => {
  it('runs the named artworks one by one, skipping what the model cannot be given', async () => {
    repository.findCreative.mockImplementation(async (id: string) => (id === 'crt_video' ? creative({ id: 'crt_video', mimeType: 'video/mp4' }) : creative({ id })));
    const result = await analyseCreatives({ userId: 'usr_admin' }, ['crt_1', 'crt_video', 'crt_2']);
    expect(result.analysed).toEqual(['crt_1', 'crt_2']);
    expect(result.skipped).toEqual([{ creativeId: 'crt_video', reason: expect.stringMatching(/still image/) }]);
    expect(result.failed).toEqual([]);
    expect(ai.complete).toHaveBeenCalledTimes(2);
    expect(repository.listCreativesAwaitingAnalysis).not.toHaveBeenCalled();
  });

  it('with nothing named, takes everything pending with no reading, oldest first, up to the limit', async () => {
    repository.listCreativesAwaitingAnalysis.mockResolvedValue([{ id: 'crt_a' }, { id: 'crt_b' }]);
    repository.findCreative.mockImplementation(async (id: string) => creative({ id }));
    const result = await analyseCreatives({ userId: 'usr_admin' });
    expect(repository.listCreativesAwaitingAnalysis).toHaveBeenCalledWith(ANALYSE_BATCH_LIMIT);
    expect(result.analysed).toEqual(['crt_a', 'crt_b']);
    expect(ANALYSE_BATCH_LIMIT).toBe(50);
  });

  it('records a vendor failure against the one artwork and goes on, but stops at once when AI is switched off', async () => {
    repository.findCreative.mockImplementation(async (id: string) => creative({ id }));
    ai.complete.mockRejectedValueOnce(new Error('The AI provider could not be reached.'));
    const result = await analyseCreatives({ userId: 'usr_admin' }, ['crt_1', 'crt_2']);
    expect(result.failed).toEqual([{ creativeId: 'crt_1', reason: 'The AI provider could not be reached.' }]);
    expect(result.analysed).toEqual(['crt_2']);

    ai.complete.mockRejectedValueOnce(new AiUnavailableError('AI features are turned off for this deployment.'));
    await expect(analyseCreatives({ userId: 'usr_admin' }, ['crt_1', 'crt_2', 'crt_3'])).rejects.toMatchObject({ statusCode: 503, code: 'AI_UNAVAILABLE' });
    // One call for the run that was refused; nothing after it.
    expect(ai.complete).toHaveBeenCalledTimes(3);
  });
});
