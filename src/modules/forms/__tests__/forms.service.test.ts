import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FM-1 — the forms desk.
 *
 * A form is born with an empty draft v1; its key is unique and shaped; a
 * LEAD form names its side; one draft at a time, created or replaced;
 * nothing publishes empty; publishing retires the live one; a restore
 * publishes a copy as the newest; PUBLIC is refused while a version asks
 * for a file; the public view is null when archived or nothing is live;
 * every write is audited.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    byKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    newSubmissionCounts: vi.fn(),
    currentVersions: vi.fn(),
    live: vi.fn(),
    draft: vi.fn(),
    byNumber: vi.fn(),
    versions: vi.fn(),
    highestNumber: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    publishDraft: vi.fn(),
    publishCopy: vi.fn(),
    userNames: vi.fn(),
    citiesByIds: vi.fn(),
    createSubmission: vi.fn(),
    updateSubmission: vi.fn(),
    submission: vi.fn(),
    listSubmissions: vi.fn(),
    submissionsInBox: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
}));

vi.mock('../prisma-forms.repository', () => ({ prismaFormsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import { archiveForm, createForm, discardDraft, getForm, listForms, publishDraft, publishedFormView, restoreForm, restoreVersion, saveDraft, updateForm } from '../forms.service';
import { emptyDefinition } from '../form-schema';

const NOW = new Date('2026-09-27T10:00:00Z');
const actor = { userId: 'usr_admin' };

const form = (over: Record<string, unknown> = {}) => ({
  id: 'frm_1',
  key: 'event-signup',
  title: 'Event sign-up',
  description: null,
  destination: 'INBOX',
  leadSide: null,
  audience: 'PUBLIC',
  notifyEmails: [],
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const withFields = { ...emptyDefinition(), screens: [{ key: 'main', fields: [{ id: 'name', kind: 'text', label: 'Name', required: true }] }] };
const withFile = { ...emptyDefinition(), screens: [{ key: 'main', fields: [{ id: 'doc', kind: 'file', label: 'Doc' }] }] };

const version = (over: Record<string, unknown> = {}) => ({
  id: 'fv_1',
  formId: 'frm_1',
  number: 1,
  status: 'DRAFT',
  definition: withFields,
  changeNote: null,
  createdByUserId: 'usr_admin',
  publishedById: null,
  publishedAt: null,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.userNames.mockResolvedValue(new Map([['usr_admin', 'Asha Admin']]));
  repository.highestNumber.mockResolvedValue(0);
  repository.byKey.mockResolvedValue(form());
  repository.create.mockImplementation(async (data: Record<string, unknown>) => form(data));
  repository.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => form(data));
  repository.createDraft.mockImplementation(async (data: Record<string, unknown>) => version(data));
  repository.updateDraft.mockImplementation(async (id: string, data: Record<string, unknown>) => version({ id, ...data }));
  repository.versions.mockResolvedValue([]);
  repository.live.mockResolvedValue(null);
  repository.draft.mockResolvedValue(null);
});

describe('creating a form', () => {
  it('writes the plumbing and an empty draft v1, audited', async () => {
    repository.byKey.mockResolvedValueOnce(null);
    const made = await createForm({ key: 'Event-Signup', title: ' Event sign-up ', notifyEmails: ['ops@adx.in'] }, actor);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'event-signup', title: 'Event sign-up', destination: 'INBOX', leadSide: null, audience: 'PUBLIC', notifyEmails: ['ops@adx.in'], createdByUserId: 'usr_admin' }));
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({ formId: 'frm_1', number: 1 }));
    expect(made.draft).toMatchObject({ number: 1, status: 'DRAFT' });
    expect(made.draft!.definition.screens).toEqual([{ key: 'main', fields: [] }]);
    expect(made.live).toBeNull();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'FORM_CREATED', expect.objectContaining({ targetType: 'Form', targetId: 'frm_1' }));
  });

  it('refuses a badly shaped key, a taken key, and a lead form without a side', async () => {
    // The shape is checked before the key is looked up.
    await expect(createForm({ key: 'Bad Key!', title: 'x' }, actor)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.byKey).not.toHaveBeenCalled();
    await expect(createForm({ key: 'event-signup', title: 'x' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.byKey.mockResolvedValueOnce(null);
    await expect(createForm({ key: 'leads', title: 'x', destination: 'LEAD' }, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/names the side/) });
    repository.byKey.mockResolvedValueOnce(null);
    await createForm({ key: 'leads', title: 'x', destination: 'LEAD', leadSide: 'PUBLISHER' }, actor);
    expect(repository.create).toHaveBeenLastCalledWith(expect.objectContaining({ destination: 'LEAD', leadSide: 'PUBLISHER' }));
    expect(repository.createDraft).toHaveBeenCalledTimes(1);
  });
});

describe('the settings', () => {
  it('patches what was sent and drops the side when the destination is not LEAD', async () => {
    repository.byKey.mockResolvedValueOnce(form({ destination: 'LEAD', leadSide: 'ADVERTISER' }));
    await updateForm('event-signup', { destination: 'INBOX', title: 'New title' }, actor);
    expect(repository.update).toHaveBeenCalledWith('frm_1', expect.objectContaining({ title: 'New title', destination: 'INBOX', leadSide: null }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'FORM_UPDATED', expect.objectContaining({ metadata: { key: 'event-signup', changed: ['destination', 'title'] } }));
  });

  it('will not make a form public while a version asks for a file', async () => {
    repository.byKey.mockResolvedValueOnce(form({ audience: 'SIGNED_IN' }));
    repository.draft.mockResolvedValueOnce(version({ definition: withFile }));
    await expect(updateForm('event-signup', { audience: 'PUBLIC' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('archives and restores, refusing the repeat', async () => {
    await archiveForm('event-signup', actor);
    expect(repository.update).toHaveBeenCalledWith('frm_1', { archivedAt: expect.any(Date) });
    repository.byKey.mockResolvedValueOnce(form({ archivedAt: NOW }));
    await expect(archiveForm('event-signup', actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.byKey.mockResolvedValueOnce(form({ archivedAt: NOW }));
    await restoreForm('event-signup', actor);
    expect(repository.update).toHaveBeenLastCalledWith('frm_1', { archivedAt: null });
    expect(audit.logActivity.mock.calls.map((c) => c[1])).toEqual(['FORM_ARCHIVED', 'FORM_UNARCHIVED']);
  });
});

describe('the versions', () => {
  it('creates the next draft, then replaces it', async () => {
    repository.highestNumber.mockResolvedValue(3);
    const first = await saveDraft('event-signup', { definition: withFields, changeNote: 'Ask the name' }, actor);
    expect(first.number).toBe(4);
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({ number: 4, changeNote: 'Ask the name' }));
    repository.draft.mockResolvedValueOnce(version({ number: 4, changeNote: 'Ask the name' }));
    await saveDraft('event-signup', { definition: withFields }, actor);
    expect(repository.updateDraft).toHaveBeenCalledWith('fv_1', expect.objectContaining({ changeNote: 'Ask the name' }));
    expect(audit.logActivity.mock.calls.map((c) => c[1])).toEqual(['FORM_DRAFTED', 'FORM_DRAFTED']);
    expect(audit.logActivity.mock.calls[1]![2]).toMatchObject({ metadata: expect.objectContaining({ replaced: true }) });
  });

  it('checks the draft against the form audience — a file on a public form is refused', async () => {
    await expect(saveDraft('event-signup', { definition: withFile }, actor)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(saveDraft('event-signup', { definition: { ...withFields, screens: [{ key: 'm', fields: [{ id: 'aadhaar', kind: 'text', label: 'x' }] }] } }, actor)).rejects.toMatchObject({ code: 'FORBIDDEN_FIELD' });
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it('publishes the draft, re-checked, and refuses an empty one or none', async () => {
    repository.draft.mockResolvedValueOnce(null);
    await expect(publishDraft('event-signup', {}, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.draft.mockResolvedValueOnce(version({ definition: emptyDefinition() }));
    await expect(publishDraft('event-signup', {}, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/at least one field/) });
    repository.draft.mockResolvedValueOnce(version());
    repository.publishDraft.mockResolvedValueOnce(version({ status: 'PUBLISHED', publishedById: 'usr_admin', publishedAt: NOW }));
    const view = await publishDraft('event-signup', { changeNote: 'Go' }, actor);
    expect(repository.publishDraft).toHaveBeenCalledWith('fv_1', 'frm_1', 'usr_admin', expect.any(Date), 'Go');
    expect(view.publishedBy).toEqual({ id: 'usr_admin', name: 'Asha Admin' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'FORM_PUBLISHED', expect.anything());
  });

  it('restores an old version as the newest, refusing the live one and the draft', async () => {
    repository.byNumber.mockResolvedValueOnce(version({ number: 2, status: 'RETIRED' }));
    repository.highestNumber.mockResolvedValue(6);
    repository.publishCopy.mockImplementation(async (data: Record<string, unknown>) => version({ ...data, status: 'PUBLISHED' }));
    const view = await restoreVersion('event-signup', 2, actor);
    expect(view).toMatchObject({ number: 7, status: 'PUBLISHED', changeNote: 'Restored from version 2' });
    repository.byNumber.mockResolvedValueOnce(version({ status: 'PUBLISHED' }));
    await expect(restoreVersion('event-signup', 1, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.byNumber.mockResolvedValueOnce(version({ status: 'DRAFT' }));
    await expect(restoreVersion('event-signup', 3, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.byNumber.mockResolvedValueOnce(null);
    await expect(restoreVersion('event-signup', 9, actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('discards the draft, or 404s when there is none', async () => {
    repository.draft.mockResolvedValueOnce(version());
    await discardDraft('event-signup', actor);
    expect(repository.deleteDraft).toHaveBeenCalledWith('fv_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'FORM_DRAFT_DISCARDED', expect.anything());
    await expect(discardDraft('event-signup', actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('reading', () => {
  it('lists every form with what is live, what waits and how many answers are unread', async () => {
    repository.list.mockResolvedValue([form(), form({ id: 'frm_2', key: 'other', title: 'Other' })]);
    repository.currentVersions.mockResolvedValue([version({ status: 'PUBLISHED', number: 2, publishedAt: NOW }), version({ id: 'fv_3', status: 'DRAFT', number: 3 })]);
    repository.newSubmissionCounts.mockResolvedValue(new Map([['frm_1', 5]]));
    const list = await listForms();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ key: 'event-signup', live: { number: 2, publishedAt: NOW }, draft: { number: 3, updatedAt: NOW }, submissionsNew: 5 });
    expect(list[1]).toMatchObject({ key: 'other', live: null, draft: null, submissionsNew: 0 });
  });

  it('reads one form with its live, draft and history — and 404s a stranger', async () => {
    repository.live.mockResolvedValueOnce(version({ status: 'PUBLISHED', number: 1 }));
    repository.draft.mockResolvedValueOnce(version({ id: 'fv_2', status: 'DRAFT', number: 2 }));
    repository.versions.mockResolvedValueOnce([version({ id: 'fv_2', number: 2 }), version({ status: 'PUBLISHED' })]);
    const read = await getForm('event-signup');
    expect(read.live!.number).toBe(1);
    expect(read.draft!.number).toBe(2);
    expect(read.versions.map((v) => v.number)).toEqual([2, 1]);
    repository.byKey.mockResolvedValueOnce(null);
    await expect(getForm('ghost')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers the public view only for a live, unarchived form', async () => {
    expect(await publishedFormView('event-signup')).toBeNull();
    repository.live.mockResolvedValueOnce(version({ status: 'PUBLISHED', number: 3 }));
    expect(await publishedFormView('Event-Signup')).toMatchObject({ key: 'event-signup', title: 'Event sign-up', audience: 'PUBLIC', version: 3, definition: withFields });
    repository.byKey.mockResolvedValueOnce(form({ archivedAt: NOW }));
    repository.live.mockResolvedValueOnce(version({ status: 'PUBLISHED' }));
    expect(await publishedFormView('event-signup')).toBeNull();
  });
});
