import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read documents: versioned like agreements, seeded with placeholders
 * until Legal supplies the text, public to read.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    active: vi.fn(),
    activeAll: vi.fn(),
    highestVersion: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    activate: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('../prisma-legal.repository', () => ({ prismaLegalRepository: repository }));

import {
  activateDocument,
  createDocument,
  currentDocument,
  documentState,
  ensurePlaceholders,
  PLACEHOLDER_NOTE,
  publicIndex,
  resetSeedCache,
  updateDocument,
} from '../legal.service';
import { LEGAL_KINDS } from '../legal.types';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'doc_1',
  kind: 'PRIVACY_POLICY',
  version: 1,
  title: 'Privacy policy',
  summary: null,
  body: '# Privacy',
  meta: null,
  isActive: false,
  effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
  activatedAt: null,
  retiredAt: null,
  createdByUserId: 'usr_admin',
  changeNote: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSeedCache();
  repository.count.mockResolvedValue(1);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => row({ id: 'doc_new', ...data }));
  repository.activate.mockImplementation(async (id: string) => row({ id, isActive: true, activatedAt: new Date() }));
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => row({ id, ...patch }));
  repository.highestVersion.mockResolvedValue(2);
});

describe('a version’s state', () => {
  it('is a draft until activated, live while it is, superseded after', () => {
    expect(documentState(row())).toBe('DRAFT');
    expect(documentState(row({ isActive: true, activatedAt: new Date() }))).toBe('ACTIVE');
    expect(documentState(row({ activatedAt: new Date(), retiredAt: new Date() }))).toBe('SUPERSEDED');
  });
});

describe('the placeholders', () => {
  it('seed one active, clearly marked version of every kind on the first read of an empty table', async () => {
    repository.count.mockResolvedValue(0);
    repository.activeAll.mockResolvedValue([]);
    await publicIndex();
    expect(repository.create).toHaveBeenCalledTimes(LEGAL_KINDS.length);
    expect(repository.activate).toHaveBeenCalledTimes(LEGAL_KINDS.length);
    const contact = repository.create.mock.calls.map((call) => call[0]).find((data) => data.kind === 'CONTACT_INFO');
    expect(contact.title).toContain('placeholder');
    expect(contact.changeNote).toBe(PLACEHOLDER_NOTE);
    expect((contact.meta as { placeholder: boolean; safetyLine: { phone: string } }).placeholder).toBe(true);
    const faq = repository.create.mock.calls.map((call) => call[0]).find((data) => data.kind === 'FAQ');
    expect((faq.meta as { items: unknown[] }).items).toHaveLength(5);
  });

  it('do nothing once the table has rows, and seed once per process', async () => {
    repository.count.mockResolvedValue(3);
    await ensurePlaceholders();
    await ensurePlaceholders();
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.count).toHaveBeenCalledTimes(1);
  });
});

describe('the public reads', () => {
  it('the index carries every live kind without bodies; a kind with nothing live is 404', async () => {
    repository.activeAll.mockResolvedValue([row({ isActive: true, activatedAt: new Date() }), row({ id: 'doc_2', kind: 'FAQ', isActive: true, activatedAt: new Date(), meta: { items: [] } })]);
    const index = await publicIndex();
    expect(index.map((entry) => entry.kind)).toEqual(['PRIVACY_POLICY', 'FAQ']);
    expect(index[0]).toMatchObject({ label: 'Privacy policy', blurb: 'How we collect and use your data', version: 1 });
    expect('body' in index[0]!).toBe(false);

    repository.active.mockResolvedValueOnce(row({ isActive: true, activatedAt: new Date() }));
    expect(await currentDocument('PRIVACY_POLICY')).toMatchObject({ kind: 'PRIVACY_POLICY', body: '# Privacy' });
    repository.active.mockResolvedValueOnce(null);
    await expect(currentDocument('REFUND_POLICY')).rejects.toMatchObject({ statusCode: 404, code: 'NO_ACTIVE_DOCUMENT' });
  });
});

describe('the desk', () => {
  it('numbers a new version after the highest, saves it as a draft, or live when asked', async () => {
    const draft = await createDocument({ kind: 'PRIVACY_POLICY', title: 'Privacy policy 2026', body: '# v3', createdByUserId: 'usr_admin' });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ version: 3, meta: null, createdByUserId: 'usr_admin' }));
    expect(draft.state).toBe('DRAFT');
    expect(repository.activate).not.toHaveBeenCalled();

    repository.findById.mockResolvedValue(row({ id: 'doc_new', version: 3 }));
    const live = await createDocument({ kind: 'PRIVACY_POLICY', title: 'Privacy policy 2026', body: '# v3', activate: true, createdByUserId: 'usr_admin' });
    expect(repository.activate).toHaveBeenCalledWith('doc_new', 'PRIVACY_POLICY', expect.any(Date));
    expect(live.state).toBe('ACTIVE');
  });

  it('a version that has been live cannot be edited; activating the live one is a no-op', async () => {
    repository.findById.mockResolvedValue(row({ isActive: true, activatedAt: new Date() }));
    await expect(updateDocument('doc_1', { body: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    expect(await activateDocument('doc_1')).toMatchObject({ state: 'ACTIVE' });
    expect(repository.activate).not.toHaveBeenCalled();

    repository.findById.mockResolvedValue(row());
    expect(await updateDocument('doc_1', { body: 'y', meta: { items: [] } })).toMatchObject({ body: 'y' });
  });

  it('a second writer racing for the same number loses cleanly', async () => {
    repository.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(createDocument({ kind: 'FAQ', title: 'FAQs', body: '#', createdByUserId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
