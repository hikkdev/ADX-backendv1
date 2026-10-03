import { createHash } from 'crypto';
import type { Request } from 'express';
import type { FormSubmissionStatus, Prisma } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { formatCsv } from '../../shared/csv';
import { sendEmail } from '../../shared/email';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { inboundLead } from '../leads';
import { createTicket } from '../support';
import { systemUserId } from '../users';
import { prismaFormsRepository as repository } from './prisma-forms.repository';
import type { BoundingBox, Form, FormSubmission, FormVersion, SubmissionFilter } from './forms.repository';
import { currentDefinition, formByKey } from './forms.service';
import { definitionOf, flattenFields, type FormDefinition, type FormField } from './form-schema';
import { answerLines, cityIdsIn, fileRefsIn, liftContacts, liftPlace, resolveCityAnswers, validateAnswers, type AnswerIssue, type Answers } from './form-answers';

/**
 * FM-1 (27 Sep 2026): an answer arrives.
 *
 * The published version is the contract: every answer is checked against
 * it, consent is recorded with its time, and the contact and place fields
 * are lifted out of the JSON so the desk can filter, map and export without
 * reading every answer set. Then the destination: a LEAD goes through the
 * lead hunt's inbound door (scored, routed, deduplicated by phone), a
 * SUPPORT answer raises an ordinary ticket, an INBOX answer stays here.
 * Neither destination nor the notification emails can fail the submit —
 * the answer is stored first and the rest is best effort, logged.
 */

export type PublishedForm = { form: Form; version: FormVersion; definition: FormDefinition };

export type SubmitInput = { answers: Answers; consent: boolean; source?: string | undefined };

export type SubmitContext = { userId: string | null; ip: string | undefined; userAgent: string | undefined; now?: Date | undefined };

const MAX_MAP_PINS = 2000;
const CSV_SLICE = 1000;

/** The form a public door answers for: live, not archived, with its published version — else 404. */
export async function loadPublishedForm(key: string): Promise<PublishedForm> {
  const form = await repository.byKey(String(key ?? '').trim().toLowerCase());
  if (!form || form.archivedAt) throw new ApiError(404, 'NOT_FOUND', `No form "${key}"`);
  const version = await repository.live(form.id);
  if (!version) throw new ApiError(404, 'NOT_FOUND', `No form "${key}"`);
  return { form, version, definition: definitionOf(version) };
}

/** sha256 of the address — enough to spot a flood, never the address itself. */
export const hashIp = (ip: string | undefined): string | null => (ip ? createHash('sha256').update(ip).digest('hex') : null);

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function answerEmail(form: Form, lines: string[], submission: FormSubmission): string {
  const rows = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  return `<p>A new answer to <strong>${escapeHtml(form.title)}</strong> arrived at ${submission.createdAt.toISOString()}.</p><ul>${rows}</ul><p>Submission ${escapeHtml(submission.id)}.</p>`;
}

async function makeLead(published: PublishedForm, submission: FormSubmission, lines: string[], cityName: string | null): Promise<string | null> {
  const { form } = published;
  if (!submission.contactPhone) {
    logger.warn('Form answer without a phone: no lead made', { form: form.key, submission: submission.id });
    return null;
  }
  const side = form.leadSide === 'PUBLISHER' || form.leadSide === 'ADVERTISER' ? form.leadSide : null;
  if (!side) {
    logger.warn('Form makes leads but names no side: no lead made', { form: form.key, submission: submission.id });
    return null;
  }
  try {
    const answer = await inboundLead(
      {
        side,
        businessName: submission.contactName ?? submission.contactEmail ?? `Answered "${form.title}"`,
        contactName: submission.contactName ?? undefined,
        phone: submission.contactPhone,
        email: submission.contactEmail ?? undefined,
        city: cityName ?? undefined,
        address: submission.address ?? undefined,
        latitude: submission.latitude ?? undefined,
        longitude: submission.longitude ?? undefined,
        message: lines.join('\n'),
        channel: 'LINK',
      },
      { sourceKey: `form:${form.key}`, sourceKind: 'INBOUND', note: `Answered the form "${form.title}"` },
    );
    return answer.leadId;
  } catch (err) {
    // An existing account's number, a malformed one — the answer is kept; the lead is not.
    logger.warn('Form answer not made a lead', { form: form.key, submission: submission.id, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function makeTicket(published: PublishedForm, submission: FormSubmission, lines: string[], attachments: string[], userId: string | null): Promise<string | null> {
  const { form } = published;
  const raisedBy = userId ?? (await systemUserId());
  if (!raisedBy) {
    logger.warn('No account to raise the form ticket under', { form: form.key, submission: submission.id });
    return null;
  }
  const who = submission.contactName ?? submission.contactEmail ?? submission.contactPhone ?? 'an answer';
  const contact = [submission.contactName && `Name: ${submission.contactName}`, submission.contactEmail && `Email: ${submission.contactEmail}`, submission.contactPhone && `Phone: ${submission.contactPhone}`].filter(Boolean) as string[];
  try {
    const ticket = await createTicket({
      userId: raisedBy,
      kind: 'ISSUE',
      title: `${form.title} — ${who}`.slice(0, 160),
      description: [...lines, ...(contact.length ? ['', ...contact] : []), '', `Form submission ${submission.id}`].join('\n').slice(0, 4000),
      category: 'OTHER',
      attachmentUrls: attachments.filter((ref) => /^https?:\/\//.test(ref)).slice(0, 5),
    });
    return ticket.id;
  } catch (err) {
    logger.warn('Form answer not made a ticket', { form: form.key, submission: submission.id, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** `POST /app/forms/:key/submissions` → `{ id, message }`. */
export async function submit(published: PublishedForm, input: SubmitInput, ctx: SubmitContext): Promise<{ id: string; message: string }> {
  const { form, version, definition } = published;
  if (input.consent !== true) throw new ApiError(400, 'VALIDATION_ERROR', 'Consent is required', { issues: [{ fieldId: 'consent', message: 'Tick the consent box to send' }] });
  const raw = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
  const { answers, issues } = validateAnswers(definition, raw);

  // A city by id or by name — the site's and the apps' pickers send names — resolved against the catalogue.
  const candidates = [...new Set(cityIdsIn(definition, answers).map((entry) => entry.cityId))];
  const known = await repository.citiesByIdsOrNames(candidates);
  const byId = new Map(known.map((city) => [city.id, city]));
  const byName = new Map(known.map((city) => [city.name.trim().toLowerCase(), city]));
  const resolved = resolveCityAnswers(definition, answers, (value) => byId.get(value) ?? byName.get(value.trim().toLowerCase()) ?? null);
  issues.push(...resolved.issues);
  const cityNames = resolved.cityNames;
  if (issues.length) throw new ApiError(400, 'VALIDATION_ERROR', issues.length === 1 ? issues[0]!.message : `${issues.length} answers need attention — the first: ${issues[0]!.message}`, { issues });

  const contacts = liftContacts(definition, answers);
  const place = liftPlace(definition, answers);
  const now = ctx.now ?? new Date();
  const submission = await repository.createSubmission({
    formId: form.id,
    formVersion: version.number,
    answers: answers as Prisma.InputJsonValue,
    ...contacts,
    ...place,
    userId: ctx.userId,
    status: 'NEW',
    source: input.source?.trim().slice(0, 120) || null,
    ipHash: hashIp(ctx.ip),
    userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    consentAt: now,
  });

  const lines = answerLines(definition, answers, cityNames);
  const cityName = place.cityId ? (cityNames.get(place.cityId) ?? null) : null;
  let leadId: string | null = null;
  let ticketId: string | null = null;
  if (form.destination === 'LEAD') leadId = await makeLead(published, submission, lines, cityName);
  else if (form.destination === 'SUPPORT') ticketId = await makeTicket(published, submission, lines, fileRefsIn(definition, answers), ctx.userId);
  if (leadId || ticketId) await repository.updateSubmission(submission.id, { leadId, ticketId });

  for (const to of form.notifyEmails) {
    void sendEmail(to, `New answer: ${form.title}`, answerEmail(form, lines, submission)).catch((err: unknown) => {
      logger.warn('Form answer notification not sent', { form: form.key, to, err: err instanceof Error ? err.message : String(err) });
    });
  }
  return { id: submission.id, message: definition.successMessage };
}

/* ── The desk ──────────────────────────────────────────────────────── */

export type SubmissionQuery = SubmissionFilter & { page: number; pageSize: number };

export type SubmissionView = {
  id: string;
  createdAt: Date;
  status: FormSubmissionStatus;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  cityId: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  answers: Answers;
  formVersion: number;
  leadId: string | null;
  ticketId: string | null;
  source: string | null;
  userId: string | null;
};

export type SubmissionColumn = { id: string; label: string; kind: FormField['kind'] };

const submissionView = (row: FormSubmission): SubmissionView => ({
  id: row.id,
  createdAt: row.createdAt,
  status: row.status,
  contactName: row.contactName,
  contactEmail: row.contactEmail,
  contactPhone: row.contactPhone,
  cityId: row.cityId,
  address: row.address,
  latitude: row.latitude,
  longitude: row.longitude,
  answers: (row.answers && typeof row.answers === 'object' && !Array.isArray(row.answers) ? row.answers : {}) as Answers,
  formVersion: row.formVersion,
  leadId: row.leadId,
  ticketId: row.ticketId,
  source: row.source,
  userId: row.userId,
});

const columnsOf = (definition: FormDefinition | null): SubmissionColumn[] => (definition ? flattenFields(definition).map((field) => ({ id: field.id, label: field.label, kind: field.kind })) : []);

/** `GET /forms/:key/submissions` — a page of answers and the columns the latest definition draws. */
export async function listSubmissions(key: string, query: SubmissionQuery) {
  const form = await formByKey(key);
  const { page, pageSize, ...filter } = query;
  const [{ items, total }, definition] = await Promise.all([repository.listSubmissions(form.id, filter, { skip: (page - 1) * pageSize, take: pageSize }), currentDefinition(form)]);
  return { items: items.map(submissionView), total, page, pageSize, fields: columnsOf(definition) };
}

const FIXED_COLUMNS = ['id', 'createdAt', 'status', 'version', 'contactName', 'contactEmail', 'contactPhone', 'cityId', 'address', 'latitude', 'longitude', 'leadId', 'ticketId', 'source'] as const;

/**
 * `GET /forms/:key/submissions.csv` — every answer the filter matches, one
 * column per field id across every version (newest version's order first,
 * then the ids only older versions had), a cell per answer as a person reads it.
 */
export async function submissionsCsv(key: string, filter: SubmissionFilter): Promise<string> {
  const form = await formByKey(key);
  const versions = await repository.versions(form.id);
  const fields = new Map<string, FormField>();
  for (const version of versions) for (const field of flattenFields(definitionOf(version))) if (!fields.has(field.id)) fields.set(field.id, field);
  const ids = [...fields.keys()];
  const rows: (string | number | null)[][] = [[...FIXED_COLUMNS, ...ids.map((id) => `${id} (${fields.get(id)!.label})`)]];
  let skip = 0;
  for (;;) {
    const { items } = await repository.listSubmissions(form.id, filter, { skip, take: CSV_SLICE });
    for (const row of items) {
      const view = submissionView(row);
      rows.push([
        view.id,
        view.createdAt.toISOString(),
        view.status,
        view.formVersion,
        view.contactName,
        view.contactEmail,
        view.contactPhone,
        view.cityId,
        view.address,
        view.latitude,
        view.longitude,
        view.leadId,
        view.ticketId,
        view.source,
        ...ids.map((id) => cell(fields.get(id)!, view.answers[id])),
      ]);
    }
    if (items.length < CSV_SLICE) break;
    skip += CSV_SLICE;
  }
  return formatCsv(rows);
}

function cell(field: FormField, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join('; ');
  if (field.kind === 'location') {
    const point = value as { latitude: number; longitude: number; address?: string };
    return point.address ? `${point.address} (${point.latitude}, ${point.longitude})` : `${point.latitude}, ${point.longitude}`;
  }
  return JSON.stringify(value);
}

/** `GET /forms/:key/submissions/map?bbox=w,s,e,n` — the pins in the box, newest first, at most 2000. */
export async function submissionsInBox(key: string, box: BoundingBox) {
  const form = await formByKey(key);
  return repository.submissionsInBox(form.id, box, MAX_MAP_PINS);
}

/** `PATCH /forms/:key/submissions/:id { status }` — read, archived, or back to new. */
export async function setSubmissionStatus(key: string, id: string, status: FormSubmissionStatus, actor: { userId: string; req?: Request | undefined }) {
  const form = await formByKey(key);
  const row = await repository.submission(form.id, id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', `No submission "${id}" on "${form.title}"`);
  const updated = row.status === status ? row : await repository.updateSubmission(row.id, { status });
  await logActivity(actor.userId, 'FORM_SUBMISSION_STATUS', {
    req: actor.req,
    targetType: 'FormSubmission',
    targetId: row.id,
    module: 'forms',
    diff: { status: { before: row.status, after: status } },
    metadata: { key: form.key },
  });
  return submissionView(updated);
}

export type { AnswerIssue };
