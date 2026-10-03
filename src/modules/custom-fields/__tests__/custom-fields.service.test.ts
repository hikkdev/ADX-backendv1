import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CF-1 — the definitions and the values.
 *
 * A definition's key is made from the label and unique per entity; options
 * only where the kind chooses; the kind never changes; archive and restore.
 * A value write merges (named keys written, null clears, others stay),
 * refuses whole on any problem, and — for the owner — only the fields
 * marked editable and shown to them; the owner's record must be their own;
 * a lead has no owner. Every write is audited.
 */

const { repository, audit, publishers, advertisers, listings } = vi.hoisted(() => ({
  repository: {
    listDefs: vi.fn(),
    defById: vi.fn(),
    defByKey: vi.fn(),
    createDef: vi.fn(),
    updateDef: vi.fn(),
    entityExists: vi.fn(),
    valuesFor: vi.fn(),
    writeValues: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
  publishers: { findPublisherForUser: vi.fn() },
  advertisers: { getAdvertiserForUser: vi.fn() },
  listings: { getListingById: vi.fn() },
}));

vi.mock('../prisma-custom-fields.repository', () => ({ prismaCustomFieldsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: audit.logActivity }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../listings', () => listings);

import { archiveDef, assertOwner, createDef, listDefs, ownerDefs, parseEntity, restoreDef, setValues, updateDef, valuesFor } from '../custom-fields.service';

const NOW = new Date('2026-09-27T10:00:00Z');
const actor = { userId: 'usr_admin' };

const def = (over: Record<string, unknown> = {}) => ({
  id: 'cfd_1',
  entity: 'PUBLISHER',
  key: 'preferred_contact_time',
  label: 'Preferred contact time',
  kind: 'select',
  options: [{ value: 'am', label: 'Morning' }, { value: 'pm', label: 'Evening' }],
  hint: null,
  required: false,
  showOnDesk: true,
  showInApps: true,
  showOnWebsite: false,
  editableByOwner: true,
  sortOrder: 0,
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const gst = def({ id: 'cfd_2', key: 'gst_number', label: 'GST number', kind: 'text', options: null, showInApps: false, editableByOwner: false });
const must = def({ id: 'cfd_3', key: 'must', label: 'Must', kind: 'text', options: null, required: true, showOnWebsite: true });

beforeEach(() => {
  vi.clearAllMocks();
  repository.listDefs.mockResolvedValue([def(), gst, must]);
  repository.defById.mockResolvedValue(def());
  repository.defByKey.mockResolvedValue(null);
  repository.createDef.mockImplementation(async (data: Record<string, unknown>) => def({ ...data, id: 'cfd_new' }));
  repository.updateDef.mockImplementation(async (id: string, data: Record<string, unknown>) => def({ id, ...data }));
  repository.entityExists.mockResolvedValue(true);
  repository.valuesFor.mockResolvedValue([{ id: 'v1', defId: 'cfd_1', entity: 'PUBLISHER', entityId: 'pub_1', value: 'am', updatedByUserId: null, createdAt: NOW, updatedAt: NOW }]);
  repository.writeValues.mockResolvedValue(undefined);
});

describe('definitions', () => {
  it('reads an entity from the path either way, and 404s a stranger', () => {
    expect(parseEntity('listing')).toBe('LISTING');
    expect(() => parseEntity('ORDER')).toThrow(/No such record type/);
  });

  it('creates one with the key made from the label, options only for a choice, audited', async () => {
    const made = await createDef({ entity: 'PUBLISHER', label: ' Preferred contact time ', kind: 'select', options: [{ value: 'am', label: 'Morning' }], showInApps: true }, actor);
    expect(repository.createDef).toHaveBeenCalledWith(expect.objectContaining({ entity: 'PUBLISHER', key: 'preferred_contact_time', label: 'Preferred contact time', kind: 'select', showOnDesk: true, showInApps: true, editableByOwner: false, createdByUserId: 'usr_admin' }));
    expect(made).toMatchObject({ id: 'cfd_new', key: 'preferred_contact_time', kindLabel: 'Choose one' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CUSTOM_FIELD_CREATED', expect.objectContaining({ targetId: 'cfd_new' }));

    await expect(createDef({ entity: 'PUBLISHER', label: 'Choice', kind: 'select' }, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/needs options/) });
    await expect(createDef({ entity: 'PUBLISHER', label: 'Text', kind: 'text', options: [{ value: 'x', label: 'X' }] }, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/takes no options/) });
    await expect(createDef({ entity: 'PUBLISHER', label: 'Dup', kind: 'select', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }, actor)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createDef({ entity: 'PUBLISHER', key: 'Bad Key', label: 'x', kind: 'text' }, actor)).rejects.toMatchObject({ statusCode: 400 });
    repository.defByKey.mockResolvedValueOnce(def());
    await expect(createDef({ entity: 'PUBLISHER', label: 'Preferred contact time', kind: 'text' }, actor)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('patches what was sent and keeps the kind; archives and restores', async () => {
    await updateDef('cfd_1', { label: 'When to call', required: true, options: [{ value: 'am', label: 'AM' }] }, actor);
    expect(repository.updateDef).toHaveBeenCalledWith('cfd_1', { label: 'When to call', required: true, options: [{ value: 'am', label: 'AM' }] });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CUSTOM_FIELD_UPDATED', expect.objectContaining({ metadata: expect.objectContaining({ changed: ['label', 'required', 'options'] }) }));
    repository.defById.mockResolvedValueOnce(null);
    await expect(updateDef('ghost', { label: 'x' }, actor)).rejects.toMatchObject({ statusCode: 404 });

    await archiveDef('cfd_1', actor);
    expect(repository.updateDef).toHaveBeenLastCalledWith('cfd_1', { archivedAt: expect.any(Date) });
    repository.defById.mockResolvedValueOnce(def({ archivedAt: NOW }));
    await expect(archiveDef('cfd_1', actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.defById.mockResolvedValueOnce(def({ archivedAt: NOW }));
    await restoreDef('cfd_1', actor);
    expect(repository.updateDef).toHaveBeenLastCalledWith('cfd_1', { archivedAt: null });
    await expect(restoreDef('cfd_1', actor)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lists live definitions, or all, and the owner sees only what is shown to them', async () => {
    await listDefs({ entity: 'PUBLISHER' });
    expect(repository.listDefs).toHaveBeenCalledWith({ entity: 'PUBLISHER', includeArchived: false });
    await listDefs({ includeArchived: true });
    expect(repository.listDefs).toHaveBeenLastCalledWith({ entity: undefined, includeArchived: true });
    expect((await ownerDefs('PUBLISHER')).map((d) => d.key)).toEqual(['preferred_contact_time', 'must']);
    await expect(ownerDefs('LEAD')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('values', () => {
  it('reads the definitions with the record\'s answers beside them, 404 when the record is not there', async () => {
    const view = await valuesFor('PUBLISHER', 'pub_1', 'DESK');
    expect(view.values).toEqual({ preferred_contact_time: 'am', gst_number: null, must: null });
    expect(view.fields.map((f) => f.key)).toEqual(['preferred_contact_time', 'gst_number', 'must']);
    expect((await valuesFor('PUBLISHER', 'pub_1', 'OWNER')).fields.map((f) => f.key)).toEqual(['preferred_contact_time', 'must']);
    repository.entityExists.mockResolvedValueOnce(false);
    await expect(valuesFor('PUBLISHER', 'ghost', 'DESK')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the desk writes the keys named, clears with null, leaves the rest, audited', async () => {
    await setValues('PUBLISHER', 'pub_1', { preferred_contact_time: 'pm', gst_number: null }, 'DESK', actor);
    expect(repository.writeValues).toHaveBeenCalledWith('PUBLISHER', 'pub_1', [{ defId: 'cfd_1', value: 'pm' }], ['cfd_2'], 'usr_admin');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CUSTOM_FIELD_VALUES_SET', expect.objectContaining({ targetType: 'PUBLISHER', targetId: 'pub_1', metadata: expect.objectContaining({ written: 1, cleared: 1 }) }));
  });

  it('refuses whole, naming every problem', async () => {
    const err = (await setValues('PUBLISHER', 'pub_1', { preferred_contact_time: 'noon', ghost: 'x', must: '' }, 'DESK', actor).catch((e: unknown) => e)) as { statusCode: number; details: { issues: { key: string; message: string }[] } };
    expect(err.statusCode).toBe(400);
    expect(err.details.issues.map((i) => i.key)).toEqual(['preferred_contact_time', 'ghost', 'must']);
    expect(err.details.issues[2]!.message).toBe('Must is required');
    expect(repository.writeValues).not.toHaveBeenCalled();
  });

  it('the owner may write only what is editable and shown to them', async () => {
    const err = (await setValues('PUBLISHER', 'pub_1', { gst_number: '27AAA', preferred_contact_time: 'am' }, 'OWNER', actor).catch((e: unknown) => e)) as { details: { issues: { key: string; message: string }[] } };
    expect(err.details.issues).toEqual([{ key: 'gst_number', message: '"GST number" is not yours to change' }]);
    await setValues('PUBLISHER', 'pub_1', { preferred_contact_time: 'am' }, 'OWNER', { userId: 'usr_pub' });
    expect(repository.writeValues).toHaveBeenCalledWith('PUBLISHER', 'pub_1', [{ defId: 'cfd_1', value: 'am' }], [], 'usr_pub');
    // The owner's read never asks whether the record exists — the ownership check already did.
    expect(repository.entityExists).not.toHaveBeenCalled();
  });
});

describe('whose record it is', () => {
  beforeEach(() => {
    publishers.findPublisherForUser.mockImplementation(async (userId: string) => (userId === 'usr_pub' ? { id: 'pub_1' } : null));
    advertisers.getAdvertiserForUser.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? { id: 'adv_1' } : null));
    listings.getListingById.mockImplementation(async (id: string) => (id === 'lst_1' ? { id, publisherId: 'pub_1' } : id === 'lst_other' ? { id, publisherId: 'pub_9' } : null));
  });

  it('admits the publisher, their listing and the advertiser; refuses everyone else and every lead', async () => {
    await expect(assertOwner('PUBLISHER', 'pub_1', 'usr_pub')).resolves.toBeUndefined();
    await expect(assertOwner('PUBLISHER', 'pub_2', 'usr_pub')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertOwner('PUBLISHER', 'pub_1', 'usr_adv')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertOwner('LISTING', 'lst_1', 'usr_pub')).resolves.toBeUndefined();
    await expect(assertOwner('LISTING', 'lst_other', 'usr_pub')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertOwner('LISTING', 'lst_none', 'usr_pub')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertOwner('ADVERTISER', 'adv_1', 'usr_adv')).resolves.toBeUndefined();
    await expect(assertOwner('ADVERTISER', 'adv_1', 'usr_pub')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertOwner('LEAD', 'lead_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 403 });
  });
});
