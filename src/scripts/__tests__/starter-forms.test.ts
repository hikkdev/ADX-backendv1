import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FM-2 — the four starter forms (`npm run seed:starter-forms`).
 *
 * Pinned: each definition passes the builder's own check, with a phone on
 * every LEAD form; each placement lands after its section and passes the
 * layout desk's own check; a first run makes four draft forms and three
 * draft pages through the real services and publishes nothing; a second run
 * writes nothing; a form whose key exists is never touched; a page with a
 * draft is left alone, a page with a live version is drafted from it (SEO
 * and all), and a form the page already carries is not placed twice;
 * `--check` writes nothing.
 *
 * The services are the real ones; only their Prisma repositories are
 * replaced, by an in-memory store.
 */

type Row = Record<string, unknown> & { id: string };

const { db, formsRepository, layoutsRepository, audit, media } = vi.hoisted(() => {
  const db = { forms: [] as Row[], formVersions: [] as Row[], layoutVersions: [] as Row[], seq: 0 };
  const NOW = new Date('2026-09-28T09:00:00Z');
  const next = (prefix: string) => `${prefix}_${++db.seq}`;
  const byStatus = (rows: Row[], status: string) => rows.filter((row) => row.status === status).sort((a, b) => Number(b.number) - Number(a.number))[0] ?? null;
  const ofForm = (formId: string) => db.formVersions.filter((row) => row.formId === formId);
  const ofSurface = (key: { surface?: string }) => db.layoutVersions.filter((row) => row.surface === key.surface);
  const highest = (rows: Row[]) => rows.reduce((max, row) => Math.max(max, Number(row.number)), 0);
  const patch = (rows: Row[], id: string, data: Record<string, unknown>) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    Object.assign(row, data, { updatedAt: NOW });
    return row;
  };

  const formsRepository = {
    list: async () => [...db.forms],
    byKey: async (key: string) => db.forms.find((form) => form.key === key) ?? null,
    create: async (data: Record<string, unknown>) => {
      const row = { id: next('frm'), ...data, archivedAt: null, createdAt: NOW, updatedAt: NOW };
      db.forms.push(row);
      return row;
    },
    update: async (id: string, data: Record<string, unknown>) => patch(db.forms, id, data),
    newSubmissionCounts: async () => new Map(),
    currentVersions: async () => db.formVersions.filter((row) => row.status !== 'RETIRED'),
    live: async (formId: string) => byStatus(ofForm(formId), 'PUBLISHED'),
    draft: async (formId: string) => byStatus(ofForm(formId), 'DRAFT'),
    versions: async (formId: string) => ofForm(formId),
    highestNumber: async (formId: string) => highest(ofForm(formId)),
    createDraft: vi.fn(async (data: Record<string, unknown>) => {
      const row = { id: next('fv'), status: 'DRAFT', publishedById: null, publishedAt: null, retiredAt: null, createdAt: NOW, updatedAt: NOW, ...data };
      db.formVersions.push(row);
      return row;
    }),
    updateDraft: vi.fn(async (id: string, data: Record<string, unknown>) => patch(db.formVersions, id, data)),
    publishDraft: vi.fn(),
    publishCopy: vi.fn(),
    userNames: async () => new Map(),
  };

  const layoutsRepository = {
    currentRows: async () => db.layoutVersions.filter((row) => row.status !== 'RETIRED'),
    live: async (key: { surface?: string }) => byStatus(ofSurface(key), 'PUBLISHED'),
    draft: async (key: { surface?: string }) => byStatus(ofSurface(key), 'DRAFT'),
    versions: async (key: { surface?: string }) => ofSurface(key),
    highestNumber: async (key: { surface?: string }) => highest(ofSurface(key)),
    createDraft: vi.fn(async (data: Record<string, unknown> & { key: { surface?: string } }) => {
      const { key, ...rest } = data;
      const row = { id: next('lv'), surface: key.surface, pageId: null, status: 'DRAFT', publishedById: null, publishedAt: null, retiredAt: null, createdAt: NOW, updatedAt: NOW, ...rest };
      db.layoutVersions.push(row);
      return row;
    }),
    updateDraft: vi.fn(async (id: string, data: Record<string, unknown>) => patch(db.layoutVersions, id, data)),
    publishDraft: vi.fn(),
    publishCopy: vi.fn(),
    userNames: async () => new Map(),
  };

  return {
    db,
    formsRepository,
    layoutsRepository,
    audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
    media: { findMediaByIds: vi.fn(async () => []) },
  };
});

vi.mock('../../modules/forms/prisma-forms.repository', () => ({ prismaFormsRepository: formsRepository }));
vi.mock('../../modules/layouts/prisma-layouts.repository', () => ({ prismaLayoutsRepository: layoutsRepository }));
vi.mock('../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../shared/audit')>()), logActivity: audit.logActivity }));
vi.mock('../../modules/media', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../modules/media')>()), findMediaByIds: media.findMediaByIds }));

import { seedStarterForms } from '../seedStarterForms';
import { STARTER_FORMS, STARTER_PLACEMENTS, placeStarterForms, starterFormBlock } from '../data/starter-forms';
import { FORM_KEY } from '../../modules/forms/forms.service';
import { validateDefinition, flattenFields } from '../../modules/forms/form-schema';
import { defaultBlocks, validateBlocks, type Block } from '../../modules/layouts/block-registry';

const actor = { userId: 'usr_system' };
const NOW = new Date('2026-09-28T09:00:00Z');

const formRow = (key: string) => db.forms.find((form) => form.key === key);
const formDraft = (key: string) => db.formVersions.find((row) => row.formId === formRow(key)?.id && row.status === 'DRAFT');
const pageDraft = (surface: string) => db.layoutVersions.find((row) => row.surface === surface && row.status === 'DRAFT');
const types = (blocks: unknown) => (blocks as Block[]).map((block) => (block.type === 'form' ? `form:${(block.props as { formKey: string }).formKey}` : block.type));
const writes = () => [formsRepository.createDraft, formsRepository.updateDraft, layoutsRepository.createDraft, layoutsRepository.updateDraft].reduce((sum, fn) => sum + fn.mock.calls.length, 0);

beforeEach(() => {
  db.forms = [];
  db.formVersions = [];
  db.layoutVersions = [];
  db.seq = 0;
  vi.clearAllMocks();
});

describe('the four definitions', () => {
  it('pass the builder’s own check as they stand, keyed as the desk keys a form', () => {
    expect(STARTER_FORMS.map((form) => form.key)).toEqual(['contact-adx', 'advertise-with-us', 'list-your-space', 'promote-your-event']);
    for (const form of STARTER_FORMS) {
      expect(FORM_KEY.test(form.key), form.key).toBe(true);
      expect(validateDefinition(form.definition, form.audience), form.key).toEqual(form.definition);
      expect(form.audience).toBe('PUBLIC');
      expect(flattenFields(form.definition).some((field) => field.kind === 'file'), form.key).toBe(false);
    }
  });

  it('ask what the owner agreed, in the kinds agreed', () => {
    const kinds = (key: string) => Object.fromEntries(flattenFields(STARTER_FORMS.find((form) => form.key === key)!.definition).map((field) => [field.id, `${field.kind}${field.required ? '!' : ''}`]));
    expect(kinds('contact-adx')).toEqual({ name: 'text!', email: 'email!', phone: 'phone', topic: 'select', message: 'textarea!' });
    expect(kinds('advertise-with-us')).toEqual({ name: 'text', company: 'text', email: 'email', phone: 'phone!', city: 'city', budget: 'select', when: 'date', message: 'textarea' });
    expect(kinds('list-your-space')).toEqual({ name: 'text', phone: 'phone!', email: 'email', city: 'city!', category: 'category', location: 'location', message: 'textarea' });
    expect(kinds('promote-your-event')).toEqual({ event_name: 'text', organiser: 'text', email: 'email', phone: 'phone!', event_date: 'date', city: 'city', venue: 'location', promotion: 'textarea' });

    const contact = STARTER_FORMS[0]!;
    expect(contact).toMatchObject({ destination: 'SUPPORT', leadSide: null });
    expect(contact.definition.successMessage).toBe('Thanks — the ADX team will write back within one working day.');
    expect(contact.definition.contactMap).toEqual({ name: 'name', email: 'email', phone: 'phone' });
    expect(flattenFields(contact.definition).find((field) => field.id === 'topic')!.options!.map((option) => option.label)).toEqual(['A booking', 'Payments', 'My listing', 'My account', 'Something else']);
    expect(STARTER_FORMS.find((form) => form.key === 'advertise-with-us')!.definition.screens[0]!.fields.find((field) => field.id === 'budget')!.options!.every((option) => option.label.includes('₹') || option.value === 'not_sure')).toBe(true);
  });

  it('make every LEAD form name its side and map a required phone — the lead door needs one', () => {
    const leads = STARTER_FORMS.filter((form) => form.destination === 'LEAD');
    expect(leads.map((form) => `${form.key}:${form.leadSide}`)).toEqual(['advertise-with-us:ADVERTISER', 'list-your-space:PUBLISHER', 'promote-your-event:ADVERTISER']);
    for (const form of leads) {
      const phone = form.definition.contactMap?.phone;
      expect(flattenFields(form.definition).find((field) => field.id === phone), form.key).toMatchObject({ kind: 'phone', required: true });
    }
  });
});

describe('the placements', () => {
  it('land after their sections on each page’s defaults and pass the layout desk’s own check', () => {
    const placed = Object.fromEntries(STARTER_PLACEMENTS.map(({ surface, blocks }) => [surface, placeStarterForms(surface, defaultBlocks(surface), blocks)]));
    expect(types(placed['WEB_HELP']!.blocks)).toEqual(['help_hero', 'help_topics', 'help_contact', 'form:contact-adx', 'help_faq']);
    expect(types(placed['WEB_ADVERTISE']!.blocks)).toEqual(['advertise_hero', 'form:advertise-with-us', 'display_ads_section', 'sponsored_listings_section', 'form:promote-your-event']);
    expect(types(placed['WEB_PUBLISHERS']!.blocks)).toEqual(['publishers_hero', 'publishers_steps', 'form:list-your-space', 'publishers_forms', 'publishers_faq']);
    for (const { surface } of STARTER_PLACEMENTS) expect(validateBlocks(surface, placed[surface]!.blocks).issues, surface).toEqual([]);
    expect(placed['WEB_HELP']!.blocks[3]).toEqual(starterFormBlock('WEB_HELP', { formKey: 'contact-adx', heading: 'Write to us', after: 'help_contact' }));
    expect(placed['WEB_HELP']!.blocks[3]!.props).toEqual({ formKey: 'contact-adx', heading: 'Write to us' });
  });

  it('go to the end when the page no longer has the section, and are never placed twice', () => {
    const base = defaultBlocks('WEB_PUBLISHERS').filter((block) => block.type !== 'publishers_steps');
    const once = placeStarterForms('WEB_PUBLISHERS', base, STARTER_PLACEMENTS[2]!.blocks);
    expect(types(once.blocks)).toEqual(['publishers_hero', 'publishers_forms', 'publishers_faq', 'form:list-your-space']);
    expect(once.added).toEqual([{ formKey: 'list-your-space', after: null, anchorMissing: true }]);
    const twice = placeStarterForms('WEB_PUBLISHERS', once.blocks, STARTER_PLACEMENTS[2]!.blocks);
    expect(twice.blocks).toEqual(once.blocks);
    expect(twice).toMatchObject({ added: [], present: ['list-your-space'] });
  });
});

describe('the run', () => {
  it('makes four draft forms and three draft pages through the services, publishing nothing', async () => {
    const report = await seedStarterForms({ check: false, actor });

    expect(report.forms.map((form) => `${form.key}:${form.outcome}`)).toEqual(['contact-adx:created', 'advertise-with-us:created', 'list-your-space:created', 'promote-your-event:created']);
    for (const starter of STARTER_FORMS) {
      expect(formRow(starter.key)).toMatchObject({ title: starter.title, destination: starter.destination, leadSide: starter.leadSide, audience: 'PUBLIC', createdByUserId: 'usr_system' });
      // The empty v1 createForm makes is replaced by the questions — one version, a draft.
      expect(db.formVersions.filter((row) => row.formId === formRow(starter.key)!.id)).toHaveLength(1);
      expect(formDraft(starter.key)).toMatchObject({ number: 1, status: 'DRAFT', definition: starter.definition });
    }

    expect(report.pages.map((page) => `${page.surface}:${page.outcome}`)).toEqual(['WEB_HELP:drafted', 'WEB_ADVERTISE:drafted', 'WEB_PUBLISHERS:drafted']);
    expect(types(pageDraft('WEB_HELP')!.blocks)).toEqual(['help_hero', 'help_topics', 'help_contact', 'form:contact-adx', 'help_faq']);
    expect(types(pageDraft('WEB_ADVERTISE')!.blocks)).toEqual(['advertise_hero', 'form:advertise-with-us', 'display_ads_section', 'sponsored_listings_section', 'form:promote-your-event']);
    expect(types(pageDraft('WEB_PUBLISHERS')!.blocks)).toEqual(['publishers_hero', 'publishers_steps', 'form:list-your-space', 'publishers_forms', 'publishers_faq']);
    expect(pageDraft('WEB_HELP')).toMatchObject({ number: 1, meta: null });

    expect(formsRepository.publishDraft).not.toHaveBeenCalled();
    expect(formsRepository.publishCopy).not.toHaveBeenCalled();
    expect(layoutsRepository.publishDraft).not.toHaveBeenCalled();
    expect(layoutsRepository.publishCopy).not.toHaveBeenCalled();
    expect(db.formVersions.every((row) => row.status === 'DRAFT') && db.layoutVersions.every((row) => row.status === 'DRAFT')).toBe(true);

    const actions = audit.logActivity.mock.calls.map((call) => call[1]);
    expect(actions.filter((action) => action === 'FORM_CREATED')).toHaveLength(4);
    expect(actions.filter((action) => action === 'FORM_DRAFTED')).toHaveLength(4);
    expect(actions.filter((action) => action === 'LAYOUT_DRAFTED')).toHaveLength(3);
    expect(actions.some((action) => String(action).endsWith('PUBLISHED'))).toBe(false);
  });

  it('writes nothing the second time', async () => {
    await seedStarterForms({ check: false, actor });
    const before = JSON.stringify({ forms: db.forms, formVersions: db.formVersions, layoutVersions: db.layoutVersions });
    vi.clearAllMocks();

    const again = await seedStarterForms({ check: false, actor });
    expect(again.forms.every((form) => form.outcome === 'exists')).toBe(true);
    expect(again.pages.every((page) => page.outcome === 'has-draft')).toBe(true);
    expect(writes()).toBe(0);
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(JSON.stringify({ forms: db.forms, formVersions: db.formVersions, layoutVersions: db.layoutVersions })).toBe(before);
  });

  it('never touches a form whose key exists — the owner’s edits stand', async () => {
    const edited = { screens: [{ key: 'main', fields: [{ id: 'note', kind: 'textarea', label: 'Owner’s own question' }] }], successMessage: 'Owner’s thanks', consentText: 'Owner’s consent' };
    db.forms.push({ id: 'frm_owner', key: 'contact-adx', title: 'Owner’s contact form', destination: 'INBOX', leadSide: null, audience: 'PUBLIC', notifyEmails: [], archivedAt: new Date('2026-09-27T00:00:00Z'), createdAt: NOW, updatedAt: NOW });
    db.formVersions.push({ id: 'fv_owner', formId: 'frm_owner', number: 3, status: 'DRAFT', definition: edited, changeNote: 'mine', createdAt: NOW, updatedAt: NOW });

    const report = await seedStarterForms({ check: false, actor });
    expect(report.forms[0]).toMatchObject({ key: 'contact-adx', outcome: 'exists' });
    expect(report.forms.slice(1).every((form) => form.outcome === 'created')).toBe(true);
    expect(formRow('contact-adx')).toMatchObject({ id: 'frm_owner', title: 'Owner’s contact form', destination: 'INBOX' });
    expect(db.formVersions.filter((row) => row.formId === 'frm_owner')).toEqual([expect.objectContaining({ id: 'fv_owner', number: 3, definition: edited, changeNote: 'mine' })]);
    expect(formsRepository.updateDraft.mock.calls.some((call) => call[0] === 'fv_owner')).toBe(false);
  });

  it('leaves a page with a draft alone, drafts from what is live, and never places a form twice', async () => {
    const helpDraft = [...defaultBlocks('WEB_HELP')].reverse();
    db.layoutVersions.push({ id: 'lv_help', surface: 'WEB_HELP', number: 4, status: 'DRAFT', blocks: helpDraft, meta: null, changeNote: 'owner at work', createdAt: NOW, updatedAt: NOW });

    const publishersLive: Block[] = [
      ...defaultBlocks('WEB_PUBLISHERS').filter((block) => block.type !== 'publishers_steps'),
      { id: 'owner-text', type: 'rich_text', props: { markdown: 'Why list with ADX' } },
    ];
    db.layoutVersions.push({ id: 'lv_pub', surface: 'WEB_PUBLISHERS', number: 2, status: 'PUBLISHED', blocks: publishersLive, meta: { seoTitle: 'List your space on ADX' }, changeNote: null, publishedAt: NOW, createdAt: NOW, updatedAt: NOW });

    const advertiseLive: Block[] = [{ id: 'owner-form', type: 'form', props: { formKey: 'advertise-with-us', heading: 'Talk to sales' } }, ...defaultBlocks('WEB_ADVERTISE')];
    db.layoutVersions.push({ id: 'lv_adv', surface: 'WEB_ADVERTISE', number: 5, status: 'PUBLISHED', blocks: advertiseLive, meta: null, changeNote: null, publishedAt: NOW, createdAt: NOW, updatedAt: NOW });

    const report = await seedStarterForms({ check: false, actor });

    expect(report.pages.map((page) => `${page.surface}:${page.outcome}`)).toEqual(['WEB_HELP:has-draft', 'WEB_ADVERTISE:drafted', 'WEB_PUBLISHERS:drafted']);
    expect(pageDraft('WEB_HELP')).toMatchObject({ id: 'lv_help', number: 4, blocks: helpDraft, changeNote: 'owner at work' });

    // From live v5: the owner's own block stays where it is; only the missing form is added.
    expect(pageDraft('WEB_ADVERTISE')).toMatchObject({ number: 6 });
    expect(types(pageDraft('WEB_ADVERTISE')!.blocks)).toEqual(['form:advertise-with-us', 'advertise_hero', 'display_ads_section', 'sponsored_listings_section', 'form:promote-your-event']);
    expect((pageDraft('WEB_ADVERTISE')!.blocks as Block[])[0]).toEqual(advertiseLive[0]);

    // From live v2, which has no steps section: the form goes to the end, and the live SEO comes along.
    expect(pageDraft('WEB_PUBLISHERS')).toMatchObject({ number: 3, meta: { seoTitle: 'List your space on ADX' } });
    expect(types(pageDraft('WEB_PUBLISHERS')!.blocks)).toEqual(['publishers_hero', 'publishers_forms', 'publishers_faq', 'rich_text', 'form:list-your-space']);
    expect(report.pages[2]!.line).toContain('at the end (live v2 has no publishers_steps)');

    // The live versions are untouched.
    expect(db.layoutVersions.find((row) => row.id === 'lv_pub')).toMatchObject({ status: 'PUBLISHED', blocks: publishersLive });
    expect(db.layoutVersions.find((row) => row.id === 'lv_adv')).toMatchObject({ status: 'PUBLISHED', blocks: advertiseLive });
  });

  it('says a page is left alone when what is live already carries every form', async () => {
    const live = placeStarterForms('WEB_HELP', defaultBlocks('WEB_HELP'), STARTER_PLACEMENTS[0]!.blocks).blocks;
    db.layoutVersions.push({ id: 'lv_help', surface: 'WEB_HELP', number: 1, status: 'PUBLISHED', blocks: live, meta: null, changeNote: null, publishedAt: NOW, createdAt: NOW, updatedAt: NOW });
    const report = await seedStarterForms({ check: false, actor });
    expect(report.pages[0]).toMatchObject({ surface: 'WEB_HELP', outcome: 'already-placed' });
    expect(pageDraft('WEB_HELP')).toBeUndefined();
  });

  it('with --check, says what it would do and writes nothing', async () => {
    const report = await seedStarterForms({ check: true, actor });
    expect(report.forms.every((form) => form.outcome === 'would-create')).toBe(true);
    expect(report.pages.every((page) => page.outcome === 'would-draft')).toBe(true);
    expect(report.forms[0]!.line).toBe('contact-adx "Contact ADX": would create — SUPPORT, PUBLIC, 5 fields, as draft v1');
    expect(report.pages[1]!.line).toBe('WEB_ADVERTISE: would save a draft from the defaults — advertise-with-us after advertise_hero; promote-your-event at the end');
    expect(db.forms).toEqual([]);
    expect(db.formVersions).toEqual([]);
    expect(db.layoutVersions).toEqual([]);
    expect(writes()).toBe(0);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});
