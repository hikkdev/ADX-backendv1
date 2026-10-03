import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FM-1 — an answer arrives.
 *
 * Consent is required; every answer is checked against the published
 * version and a city must be in the catalogue; the contact and place
 * fields are lifted into columns; the address is hashed; a LEAD form goes
 * through the inbound door (needs a phone; an existing account's number
 * makes no lead and does not fail the submit); a SUPPORT form raises a
 * ticket under the caller or the system user; INBOX stores only; the
 * notification emails go out fire-and-forget; the desk lists, exports,
 * maps and files the answers.
 */

const { repository, audit, leads, support, users, email } = vi.hoisted(() => ({
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
    citiesByIdsOrNames: vi.fn(),
    createSubmission: vi.fn(),
    updateSubmission: vi.fn(),
    submission: vi.fn(),
    listSubmissions: vi.fn(),
    submissionsInBox: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
  leads: { inboundLead: vi.fn() },
  support: { createTicket: vi.fn() },
  users: { systemUserId: vi.fn() },
  email: { sendEmail: vi.fn() },
}));

vi.mock('../prisma-forms.repository', () => ({ prismaFormsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: audit.logActivity }));
vi.mock('../../../shared/email', () => email);
vi.mock('../../leads', () => leads);
vi.mock('../../support', () => support);
vi.mock('../../users', () => users);
vi.mock('../../listings', () => ({ LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] }));

import { hashIp, listSubmissions, loadPublishedForm, setSubmissionStatus, submissionsCsv, submissionsInBox, submit, type PublishedForm } from '../submissions.service';
import { emptyDefinition, validateDefinition } from '../form-schema';

const NOW = new Date('2026-09-27T10:00:00Z');

const definition = validateDefinition(
  {
    ...emptyDefinition(),
    successMessage: 'Got it',
    screens: [
      {
        key: 'main',
        fields: [
          { id: 'name', kind: 'text', label: 'Name', required: true },
          { id: 'phone', kind: 'phone', label: 'Phone' },
          { id: 'email', kind: 'email', label: 'Email' },
          { id: 'city', kind: 'city', label: 'City' },
          { id: 'where', kind: 'location', label: 'Where' },
          { id: 'note', kind: 'textarea', label: 'Note' },
          { id: 'photo', kind: 'file', label: 'Photo' },
        ],
      },
    ],
    contactMap: { name: 'name', phone: 'phone', email: 'email' },
  },
  'SIGNED_IN',
);

const form = (over: Record<string, unknown> = {}) => ({
  id: 'frm_1',
  key: 'ask',
  title: 'Ask us',
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

const version = (over: Record<string, unknown> = {}) => ({
  id: 'fv_1',
  formId: 'frm_1',
  number: 2,
  status: 'PUBLISHED',
  definition,
  changeNote: null,
  createdByUserId: 'usr_admin',
  publishedById: 'usr_admin',
  publishedAt: NOW,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const published = (over: Record<string, unknown> = {}): PublishedForm => ({ form: form(over) as PublishedForm['form'], version: version() as PublishedForm['version'], definition });

const ctx = { userId: null, ip: '203.0.113.9', userAgent: 'vitest', now: NOW };
const answers = { name: 'Asha', phone: '9876543210', email: 'asha@example.com', city: 'city_pune', where: { latitude: 18.5, longitude: 73.8, address: 'FC Road' }, note: 'Hello' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.byKey.mockResolvedValue(form());
  repository.live.mockResolvedValue(version());
  repository.citiesByIds.mockImplementation(async (ids: string[]) => ids.filter((id) => id === 'city_pune').map((id) => ({ id, name: 'Pune' })));
  repository.citiesByIdsOrNames.mockImplementation(async (values: string[]) => (values.some((v) => v === 'city_pune' || v.toLowerCase() === 'pune') ? [{ id: 'city_pune', name: 'Pune' }] : []));
  repository.createSubmission.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'sub_1', createdAt: NOW, updatedAt: NOW, leadId: null, ticketId: null, ...data }));
  repository.updateSubmission.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  users.systemUserId.mockResolvedValue('usr_system');
  email.sendEmail.mockResolvedValue({ provider: 'SMTP', configured: false, messageId: null, response: null, previewUrl: null });
});

describe('loadPublishedForm', () => {
  it('answers the live form and 404s an unknown, archived or unpublished one', async () => {
    expect((await loadPublishedForm('ASK')).definition).toEqual(definition);
    repository.byKey.mockResolvedValueOnce(null);
    await expect(loadPublishedForm('ghost')).rejects.toMatchObject({ statusCode: 404 });
    repository.byKey.mockResolvedValueOnce(form({ archivedAt: NOW }));
    await expect(loadPublishedForm('ask')).rejects.toMatchObject({ statusCode: 404 });
    repository.live.mockResolvedValueOnce(null);
    await expect(loadPublishedForm('ask')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('submit', () => {
  it('requires consent, and names every bad answer', async () => {
    await expect(submit(published(), { answers, consent: false }, ctx)).rejects.toMatchObject({ statusCode: 400, message: 'Consent is required' });
    const err = (await submit(published(), { answers: { ...answers, name: '', city: 'city_mars' }, consent: true }, ctx).catch((e: unknown) => e)) as { statusCode: number; details: { issues: { fieldId: string }[] } };
    expect(err.statusCode).toBe(400);
    expect(err.details.issues.map((i) => i.fieldId)).toEqual(['name', 'city']);
    expect(repository.createSubmission).not.toHaveBeenCalled();
  });

  it('stores the answer with the contacts and the place lifted, the address hashed, and says the success message', async () => {
    const out = await submit(published(), { answers, consent: true, source: 'page:events' }, ctx);
    expect(out).toEqual({ id: 'sub_1', message: 'Got it' });
    expect(repository.createSubmission).toHaveBeenCalledWith({
      formId: 'frm_1',
      formVersion: 2,
      answers: { name: 'Asha', phone: '9876543210', email: 'asha@example.com', city: 'city_pune', where: { latitude: 18.5, longitude: 73.8, address: 'FC Road' }, note: 'Hello' },
      contactName: 'Asha',
      contactEmail: 'asha@example.com',
      contactPhone: '9876543210',
      latitude: 18.5,
      longitude: 73.8,
      address: 'FC Road',
      cityId: null,
      userId: null,
      status: 'NEW',
      source: 'page:events',
      ipHash: hashIp('203.0.113.9'),
      userAgent: 'vitest',
      consentAt: NOW,
    });
    expect(hashIp('203.0.113.9')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp(undefined)).toBeNull();
    expect(leads.inboundLead).not.toHaveBeenCalled();
    expect(support.createTicket).not.toHaveBeenCalled();
    expect(repository.updateSubmission).not.toHaveBeenCalled();
  });

  it('takes the city column from the first city when no location was answered', async () => {
    const { where: _where, ...noLocation } = answers;
    await submit(published(), { answers: noLocation, consent: true }, ctx);
    expect(repository.createSubmission).toHaveBeenCalledWith(expect.objectContaining({ cityId: 'city_pune', latitude: null, longitude: null, address: null }));
  });

  it('a LEAD form goes through the inbound door with the answers as the message, and links the lead', async () => {
    leads.inboundLead.mockResolvedValueOnce({ leadId: 'lead_1', displayId: 'LED-1', created: true, assignedAgentId: null });
    const { where: _where, ...noLocation } = answers;
    await submit(published({ destination: 'LEAD', leadSide: 'ADVERTISER' }), { answers: noLocation, consent: true }, ctx);
    expect(leads.inboundLead).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'ADVERTISER', businessName: 'Asha', contactName: 'Asha', phone: '9876543210', email: 'asha@example.com', city: 'Pune', channel: 'LINK', message: 'Name: Asha\nPhone: 9876543210\nEmail: asha@example.com\nCity: Pune\nNote: Hello' }),
      { sourceKey: 'form:ask', sourceKind: 'INBOUND', note: 'Answered the form "Ask us"' },
    );
    expect(repository.updateSubmission).toHaveBeenCalledWith('sub_1', { leadId: 'lead_1', ticketId: null });
  });

  it('a LEAD form without a phone, or whose number has an account, still stores the answer and makes no lead', async () => {
    const { phone: _phone, ...noPhone } = answers;
    await submit(published({ destination: 'LEAD', leadSide: 'PUBLISHER' }), { answers: noPhone, consent: true }, ctx);
    expect(leads.inboundLead).not.toHaveBeenCalled();
    leads.inboundLead.mockRejectedValueOnce(Object.assign(new Error('That number already has an ADX account'), { statusCode: 409 }));
    const out = await submit(published({ destination: 'LEAD', leadSide: 'PUBLISHER' }), { answers, consent: true }, ctx);
    expect(out.id).toBe('sub_1');
    expect(repository.createSubmission).toHaveBeenCalledTimes(2);
    expect(repository.updateSubmission).not.toHaveBeenCalled();
  });

  it('a SUPPORT form raises a ticket under the caller, else the system user, with the files attached', async () => {
    support.createTicket.mockResolvedValue({ id: 'tkt_1', displayId: 'TKT-1' });
    await submit(published({ destination: 'SUPPORT', audience: 'SIGNED_IN' }), { answers: { ...answers, photo: ['https://files.adx.in/files/abc', '/files/local'] }, consent: true }, { ...ctx, userId: 'usr_pub' });
    expect(support.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', kind: 'ISSUE', category: 'OTHER', title: 'Ask us — Asha', attachmentUrls: ['https://files.adx.in/files/abc'] }),
    );
    expect(support.createTicket.mock.calls[0]![0].description).toMatch(/^Name: Asha\nPhone: 9876543210[\s\S]*Form submission sub_1$/);
    expect(repository.updateSubmission).toHaveBeenCalledWith('sub_1', { leadId: null, ticketId: 'tkt_1' });
    expect(repository.createSubmission).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'usr_pub' }));

    await submit(published({ destination: 'SUPPORT' }), { answers, consent: true }, ctx);
    expect(support.createTicket).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'usr_system' }));

    users.systemUserId.mockResolvedValueOnce(null);
    support.createTicket.mockClear();
    await submit(published({ destination: 'SUPPORT' }), { answers, consent: true }, ctx);
    expect(support.createTicket).not.toHaveBeenCalled();
  });

  it('emails everyone on the list, and a failed email never fails the submit', async () => {
    email.sendEmail.mockRejectedValueOnce(new Error('SMTP down'));
    const out = await submit(published({ notifyEmails: ['a@adx.in', 'b@adx.in'] }), { answers, consent: true }, ctx);
    expect(out.id).toBe('sub_1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail).toHaveBeenCalledWith('a@adx.in', 'New answer: Ask us', expect.stringContaining('<li>Name: Asha</li>'));
  });
});

describe('the desk', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    formId: 'frm_1',
    formVersion: 2,
    answers: { name: 'Asha', where: { latitude: 1, longitude: 2 }, tags: ['a', 'b'], agree: true },
    contactName: 'Asha',
    contactEmail: null,
    contactPhone: '9876543210',
    latitude: 1,
    longitude: 2,
    address: null,
    cityId: 'city_pune',
    userId: null,
    leadId: null,
    ticketId: null,
    status: 'NEW',
    source: null,
    ipHash: 'x',
    userAgent: null,
    consentAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  it('lists a page with the columns of the live definition', async () => {
    repository.listSubmissions.mockResolvedValueOnce({ items: [row()], total: 1 });
    const page = await listSubmissions('ask', { status: 'NEW', page: 2, pageSize: 10 });
    expect(repository.listSubmissions).toHaveBeenCalledWith('frm_1', { status: 'NEW' }, { skip: 10, take: 10 });
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.items[0]).toMatchObject({ id: 'sub_1', contactName: 'Asha', formVersion: 2, answers: expect.objectContaining({ name: 'Asha' }) });
    expect(page.fields.map((f) => f.id)).toEqual(['name', 'phone', 'email', 'city', 'where', 'note', 'photo']);
  });

  it('exports one column per field id across every version', async () => {
    const older = { ...definition, screens: [{ key: 'main', fields: [{ id: 'old_question', kind: 'text', label: 'Old' }, { id: 'name', kind: 'text', label: 'Name' }] }] };
    repository.versions.mockResolvedValueOnce([version(), version({ number: 1, status: 'RETIRED', definition: older })]);
    repository.listSubmissions.mockResolvedValueOnce({ items: [row(), row({ id: 'sub_0', formVersion: 1, answers: { old_question: 'yes, "quoted"', name: 'Ravi' } })], total: 2 });
    const csv = await submissionsCsv('ask', {});
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,createdAt,status,version,contactName,contactEmail,contactPhone,cityId,address,latitude,longitude,leadId,ticketId,source,name (Name),phone (Phone),email (Email),city (City),where (Where),note (Note),photo (Photo),old_question (Old)');
    expect(lines[1]).toBe('sub_1,2026-09-27T10:00:00.000Z,NEW,2,Asha,,9876543210,city_pune,,1,2,,,,Asha,,,,"1, 2",,,');
    expect(lines[2]).toBe('sub_0,2026-09-27T10:00:00.000Z,NEW,1,Asha,,9876543210,city_pune,,1,2,,,,Ravi,,,,,,,"yes, ""quoted"""');
  });

  it('maps the pins in a box and files a submission, audited', async () => {
    repository.submissionsInBox.mockResolvedValueOnce([{ id: 'sub_1', latitude: 1, longitude: 2, contactName: 'Asha', createdAt: NOW }]);
    expect(await submissionsInBox('ask', { west: 0, south: 0, east: 5, north: 5 })).toHaveLength(1);
    expect(repository.submissionsInBox).toHaveBeenCalledWith('frm_1', { west: 0, south: 0, east: 5, north: 5 }, 2000);

    repository.submission.mockResolvedValueOnce(row());
    repository.updateSubmission.mockResolvedValueOnce(row({ status: 'READ' }));
    const filed = await setSubmissionStatus('ask', 'sub_1', 'READ', { userId: 'usr_admin' });
    expect(filed.status).toBe('READ');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'FORM_SUBMISSION_STATUS', expect.objectContaining({ targetId: 'sub_1', diff: { status: { before: 'NEW', after: 'READ' } } }));
    repository.submission.mockResolvedValueOnce(null);
    await expect(setSubmissionStatus('ask', 'nope', 'READ', { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
