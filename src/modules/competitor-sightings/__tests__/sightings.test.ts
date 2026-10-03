import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VA-2 — competitors' hoardings, filed by agents.
 *
 * Pinned: a sighting is the agent's own stamped photo, and where and when
 * default to the stamp so a blank form still files a placed, dated row;
 * somebody else's photo is refused; the desk's vision pass fills the row
 * without overwriting what the agent read off the hoarding; and the corpus
 * export carries the agent's reading beside the model's, CSV-safe.
 */

const { repository, agents, uploads, ai, audit } = vi.hoisted(() => ({
  repository: { create: vi.fn(), findById: vi.fn(), list: vi.fn(), listAll: vi.fn(), recordAnalysis: vi.fn(), brands: vi.fn() },
  agents: { requireAgentProfile: vi.fn(async () => ({ id: 'agt_1', city: 'Bengaluru', cityId: 'city_blr' })) },
  uploads: {
    findUploadedFile: vi.fn(),
    isModelReadableImage: (mime: string | null) => !!mime && mime.startsWith('image/'),
    readImageForModel: vi.fn(async () => ({ base64: 'QUJD', mimeType: 'image/jpeg', perceptualHash: 'abcdef0123456789', width: 1024, height: 768 })),
  },
  ai: { complete: vi.fn() },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-competitor-sightings.repository', () => ({ prismaCompetitorSightingsRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../uploads', () => uploads);
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: audit.logActivity }));
vi.mock('../../../shared/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/ai')>();
  return { ...actual, complete: (...args: unknown[]) => ai.complete(...args) };
});

import { analyseSighting, logSighting, parseSightingAnalysis, sightingsToCsv, toSightingView } from '../competitor-sightings.service';

const file = (over: Record<string, unknown> = {}) => ({
  id: 'file_9',
  userId: 'usr_agent',
  url: 'http://api.test/api/v1/files/file_9',
  mimeType: 'image/jpeg',
  latitude: 12.9716,
  longitude: 77.5946,
  takenAt: new Date('2026-09-23T08:35:00Z'),
  geoStamped: true,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cs_1',
  agentId: 'agt_1',
  photoFileId: 'file_9',
  photoUrl: 'http://api.test/api/v1/files/file_9',
  brand: null,
  category: null,
  format: null,
  note: null,
  latitude: 12.9716,
  longitude: 77.5946,
  address: null,
  city: 'Bengaluru',
  cityId: 'city_blr',
  capturedAt: new Date('2026-09-23T08:35:00Z'),
  analysis: null,
  analysedAt: null,
  createdAt: new Date('2026-09-23T08:36:00Z'),
  agent: { id: 'agt_1', displayId: 'AGT-0007', user: { name: 'Meena' } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  uploads.findUploadedFile.mockResolvedValue(file());
  repository.create.mockImplementation(async (data: Record<string, unknown>) => row(data));
  repository.findById.mockResolvedValue(row({ brand: 'Zomato' }));
  repository.recordAnalysis.mockImplementation(async (_id: string, analysis: unknown, at: Date) => row({ brand: 'Zomato', analysis, analysedAt: at }));
});

describe('filing a sighting', () => {
  it('takes where and when from the stamped photo when the agent typed nothing but the brand', async () => {
    const view = await logSighting('usr_agent', { photoFileId: 'file_9', brand: 'Zomato' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', photoFileId: 'file_9', brand: 'Zomato', latitude: 12.9716, longitude: 77.5946, capturedAt: new Date('2026-09-23T08:35:00Z'), city: 'Bengaluru', cityId: 'city_blr' }),
    );
    expect(view.agent).toEqual({ id: 'agt_1', displayId: 'AGT-0007', name: 'Meena' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_agent', 'COMPETITOR_SIGHTING_LOGGED', expect.objectContaining({ metadata: expect.objectContaining({ stamped: true }) }));
  });

  it('prefers what the agent typed over the stamp, and refuses a photo that is not theirs', async () => {
    await logSighting('usr_agent', { photoFileId: 'file_9', latitude: 13.0, longitude: 77.6, capturedAt: new Date('2026-09-22T10:00:00Z'), format: 'BUS_SHELTER' });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ latitude: 13.0, longitude: 77.6, capturedAt: new Date('2026-09-22T10:00:00Z'), format: 'BUS_SHELTER' }));

    uploads.findUploadedFile.mockResolvedValue(file({ userId: 'usr_someone_else' }));
    await expect(logSighting('usr_agent', { photoFileId: 'file_9' })).rejects.toMatchObject({ statusCode: 404 });
    uploads.findUploadedFile.mockResolvedValue(file({ mimeType: 'application/pdf' }));
    await expect(logSighting('usr_agent', { photoFileId: 'file_9' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('the vision pass', () => {
  it('shows the model the photo with what the agent read, and keeps the answer on the row', async () => {
    ai.complete.mockResolvedValue({
      text: '{"brand":"Zomato","category":"Food delivery","format":"HOARDING","estimatedSize":"40 x 20 ft","illuminated":true,"condition":"GOOD","text":"Order now, 10 minutes","summary":"A lit Zomato hoarding over a junction.","confidence":0.9}',
      provider: 'google',
      model: 'gemini-2.0-flash',
    });
    const view = await analyseSighting('cs_1', { userId: 'usr_admin' });
    const request = ai.complete.mock.calls[0]![0] as { prompt: string; images: unknown[] };
    expect(request.prompt).toContain('The agent read the brand as: Zomato');
    expect(request.images).toHaveLength(1);
    expect(view.analysis).toMatchObject({ brand: 'Zomato', format: 'HOARDING', condition: 'GOOD', provider: 'google', perceptualHash: 'abcdef0123456789' });
    expect(view.analysedAt).not.toBeNull();
    // The agent's own reading stands: the row's brand column was not rewritten by the model.
    expect(repository.recordAnalysis).toHaveBeenCalledWith('cs_1', expect.objectContaining({ brand: 'Zomato' }), expect.any(Date));
  });

  it('reads the answer out of prose and holds it to the shape', () => {
    expect(parseSightingAnalysis('Sure: {"summary":"A wall.","confidence":0.5}')).toMatchObject({ summary: 'A wall.', brand: null, condition: 'UNKNOWN' });
    expect(() => parseSightingAnalysis('nothing here')).toThrow(/no JSON object/);
  });
});

describe('the corpus', () => {
  it('writes one CSV row per sighting with the agent’s reading beside the model’s, and quotes what needs quoting', () => {
    const rows = [
      toSightingView(row({ brand: 'Zomato', note: 'Corner, "big" one', address: '5th Cross, Koramangala', analysis: { brand: 'Zomato', category: 'Food delivery', format: 'HOARDING', estimatedSize: '40 x 20 ft', condition: 'GOOD', text: 'Order now', confidence: 0.9 } }) as never),
      toSightingView(row({ id: 'cs_2', brand: null }) as never),
    ];
    const csv = sightingsToCsv(rows);
    const [header, first, second] = csv.trim().split('\n');
    expect(header).toBe('id,capturedAt,agentDisplayId,brand,category,format,latitude,longitude,address,city,photoUrl,note,aiBrand,aiCategory,aiFormat,aiEstimatedSize,aiCondition,aiText,aiConfidence');
    expect(first).toContain('"Corner, ""big"" one"');
    expect(first).toContain(',"5th Cross, Koramangala",');
    expect(first).toContain(',Zomato,Food delivery,HOARDING,40 x 20 ft,GOOD,Order now,0.9');
    expect(second).toContain('cs_2,2026-09-23T08:35:00.000Z,AGT-0007,,,,12.9716,77.5946,,Bengaluru,');
  });
});
