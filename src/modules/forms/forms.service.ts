import type { Request } from 'express';
import type { FormAudience, FormDestination, Prisma } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { prismaFormsRepository as repository } from './prisma-forms.repository';
import type { Form, FormVersion } from './forms.repository';
import { asksForFile, assertPublishable, definitionOf, emptyDefinition, flattenFields, validateDefinition, type FormDefinition } from './form-schema';
import { LEAD_SIDES } from './forms.schema';

/**
 * FM-1 (27 Sep 2026): the forms desk — Content › Forms.
 *
 * A form is two things: its plumbing (`Form` — where answers go, who is
 * emailed, who may answer) and its questions (`FormVersion`), versioned the
 * way `layouts` versions a screen: one draft at a time, numbers only up,
 * publishing retires the live one, a restore publishes a copy as the newest.
 * The rules are copied rather than shared because the key differs (a form
 * id, not a surface) and the payload is a definition, not blocks.
 */

type Actor = { userId: string; req?: Request | undefined };

export const FORM_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type FormVersionView = {
  id: string;
  number: number;
  status: FormVersion['status'];
  definition: FormDefinition;
  changeNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
  publishedBy: { id: string; name: string } | null;
};

export type FormSummary = {
  id: string;
  key: string;
  title: string;
  destination: FormDestination;
  leadSide: string | null;
  audience: FormAudience;
  live: { number: number; publishedAt: Date | null } | null;
  draft: { number: number; updatedAt: Date } | null;
  submissionsNew: number;
  archivedAt: Date | null;
  updatedAt: Date;
};

/** What a page's Form block and `GET /app/forms/:key` hand a client. */
export type PublishedFormView = {
  key: string;
  title: string;
  description: string | null;
  audience: FormAudience;
  version: number;
  definition: FormDefinition;
};

export type FormSettingsInput = {
  key: string;
  title: string;
  description?: string | null | undefined;
  destination?: FormDestination | undefined;
  leadSide?: string | null | undefined;
  audience?: FormAudience | undefined;
  notifyEmails?: string[] | undefined;
};

export type FormSettingsPatch = Partial<Omit<FormSettingsInput, 'key'>>;

const json = (definition: FormDefinition) => definition as unknown as Prisma.InputJsonValue;
const note = (value: string | null | undefined) => value?.trim() || null;

async function views(rows: FormVersion[]): Promise<FormVersionView[]> {
  const names = await repository.userNames([...new Set(rows.map((row) => row.publishedById).filter((id): id is string => !!id))]);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    definition: definitionOf(row),
    changeNote: row.changeNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    retiredAt: row.retiredAt,
    publishedBy: row.publishedById ? { id: row.publishedById, name: names.get(row.publishedById) ?? row.publishedById } : null,
  }));
}

async function viewOf(row: FormVersion | null): Promise<FormVersionView | null> {
  return row ? (await views([row]))[0]! : null;
}

function formView(form: Form) {
  return {
    id: form.id,
    key: form.key,
    title: form.title,
    description: form.description,
    destination: form.destination,
    leadSide: form.leadSide,
    audience: form.audience,
    notifyEmails: form.notifyEmails,
    archivedAt: form.archivedAt,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

/** The form a key names, archived or not — the desk sees both. */
export async function formByKey(key: string): Promise<Form> {
  const form = await repository.byKey(String(key ?? '').trim().toLowerCase());
  if (!form) throw new ApiError(404, 'NOT_FOUND', `No form "${key}"`);
  return form;
}

/** A destination of LEAD needs a side; any other destination carries none. */
function leadSideFor(destination: FormDestination, leadSide: string | null | undefined): string | null {
  if (destination !== 'LEAD') return null;
  if (!leadSide || !(LEAD_SIDES as readonly string[]).includes(leadSide)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `A form that makes leads names the side — one of ${LEAD_SIDES.join(', ')}`);
  }
  return leadSide;
}

/* ── Reads ─────────────────────────────────────────────────────────── */

/** `GET /forms` — every form, what is live, whether a draft waits, and how many answers are unread. */
export async function listForms(): Promise<FormSummary[]> {
  const [forms, versions, counts] = await Promise.all([repository.list(), repository.currentVersions(), repository.newSubmissionCounts()]);
  return forms.map((form) => {
    const live = versions.filter((row) => row.formId === form.id && row.status === 'PUBLISHED').sort((a, b) => b.number - a.number)[0];
    const draft = versions.filter((row) => row.formId === form.id && row.status === 'DRAFT').sort((a, b) => b.number - a.number)[0];
    return {
      id: form.id,
      key: form.key,
      title: form.title,
      destination: form.destination,
      leadSide: form.leadSide,
      audience: form.audience,
      live: live ? { number: live.number, publishedAt: live.publishedAt } : null,
      draft: draft ? { number: draft.number, updatedAt: draft.updatedAt } : null,
      submissionsNew: counts.get(form.id) ?? 0,
      archivedAt: form.archivedAt,
      updatedAt: form.updatedAt,
    };
  });
}

/** `GET /forms/:key` — the settings, the live version, the draft and the history. */
export async function getForm(key: string) {
  const form = await formByKey(key);
  const [live, draft, history] = await Promise.all([repository.live(form.id), repository.draft(form.id), repository.versions(form.id)]);
  return { ...formView(form), live: await viewOf(live), draft: await viewOf(draft), versions: await views(history) };
}

export async function listVersions(key: string): Promise<FormVersionView[]> {
  const form = await formByKey(key);
  return views(await repository.versions(form.id));
}

/** The published form, for a page's Form block and the public read — null when archived or nothing is live. */
export async function publishedFormView(key: string): Promise<PublishedFormView | null> {
  const form = await repository.byKey(String(key ?? '').trim().toLowerCase());
  if (!form || form.archivedAt) return null;
  const live = await repository.live(form.id);
  if (!live) return null;
  return { key: form.key, title: form.title, description: form.description, audience: form.audience, version: live.number, definition: definitionOf(live) };
}

/* ── Settings ──────────────────────────────────────────────────────── */

/** `POST /forms` — the plumbing, and an empty draft v1 to start on. */
export async function createForm(input: FormSettingsInput, actor: Actor) {
  const key = input.key.trim().toLowerCase();
  if (!FORM_KEY.test(key) || key.length > 64) throw new ApiError(400, 'VALIDATION_ERROR', 'A form key is lowercase words joined by hyphens, at most 64 long');
  if (await repository.byKey(key)) throw new ApiError(409, 'CONFLICT', `A form with the key "${key}" already exists`);
  const destination = input.destination ?? 'INBOX';
  const form = await repository.create({
    key,
    title: input.title.trim(),
    description: note(input.description),
    destination,
    leadSide: leadSideFor(destination, input.leadSide),
    audience: input.audience ?? 'PUBLIC',
    notifyEmails: input.notifyEmails ?? [],
    createdByUserId: actor.userId,
  });
  const draft = await repository.createDraft({ formId: form.id, number: 1, definition: json(emptyDefinition()), changeNote: null, createdByUserId: actor.userId });
  await logActivity(actor.userId, 'FORM_CREATED', {
    req: actor.req,
    targetType: 'Form',
    targetId: form.id,
    module: 'forms',
    metadata: { key, destination, audience: form.audience },
  });
  return { ...formView(form), live: null, draft: await viewOf(draft), versions: await views([draft]) };
}

/** `PATCH /forms/:key` — the settings. Turning a form PUBLIC while it asks for a file is refused: a public form cannot take uploads. */
export async function updateForm(key: string, patch: FormSettingsPatch, actor: Actor) {
  const form = await formByKey(key);
  const destination = patch.destination ?? form.destination;
  const audience = patch.audience ?? form.audience;
  if (audience === 'PUBLIC' && form.audience !== 'PUBLIC') {
    const [live, draft] = await Promise.all([repository.live(form.id), repository.draft(form.id)]);
    if ([live, draft].some((row) => row && asksForFile(definitionOf(row)))) {
      throw new ApiError(409, 'CONFLICT', 'This form asks for a file, which only signed-in people may send — remove the file fields before making it public');
    }
  }
  const data = {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: note(patch.description) } : {}),
    destination,
    leadSide: leadSideFor(destination, patch.leadSide === undefined ? form.leadSide : patch.leadSide),
    audience,
    ...(patch.notifyEmails !== undefined ? { notifyEmails: patch.notifyEmails } : {}),
  };
  const updated = await repository.update(form.id, data);
  await logActivity(actor.userId, 'FORM_UPDATED', {
    req: actor.req,
    targetType: 'Form',
    targetId: form.id,
    module: 'forms',
    metadata: { key: form.key, changed: Object.keys(patch) },
  });
  return formView(updated);
}

/** `POST /forms/:key/archive` — the form stops answering; its history and answers stay. */
export async function archiveForm(key: string, actor: Actor) {
  const form = await formByKey(key);
  if (form.archivedAt) throw new ApiError(409, 'CONFLICT', `"${form.title}" is already archived`);
  const updated = await repository.update(form.id, { archivedAt: new Date() });
  await logActivity(actor.userId, 'FORM_ARCHIVED', { req: actor.req, targetType: 'Form', targetId: form.id, module: 'forms', metadata: { key: form.key } });
  return formView(updated);
}

/** `POST /forms/:key/restore-form` — back from the archive; whatever was live is live again. */
export async function restoreForm(key: string, actor: Actor) {
  const form = await formByKey(key);
  if (!form.archivedAt) throw new ApiError(409, 'CONFLICT', `"${form.title}" is not archived`);
  const updated = await repository.update(form.id, { archivedAt: null });
  await logActivity(actor.userId, 'FORM_UNARCHIVED', { req: actor.req, targetType: 'Form', targetId: form.id, module: 'forms', metadata: { key: form.key } });
  return formView(updated);
}

/* ── Versions ──────────────────────────────────────────────────────── */

/** `PUT /forms/:key/draft` — the next version of this form's questions, created or replaced. */
export async function saveDraft(key: string, input: { definition: unknown; changeNote?: string | null | undefined }, actor: Actor): Promise<FormVersionView> {
  const form = await formByKey(key);
  const definition = validateDefinition(input.definition, form.audience);
  const existing = await repository.draft(form.id);
  const row = existing
    ? await repository.updateDraft(existing.id, { definition: json(definition), changeNote: input.changeNote === undefined ? existing.changeNote : note(input.changeNote) })
    : await repository.createDraft({
        formId: form.id,
        number: (await repository.highestNumber(form.id)) + 1,
        definition: json(definition),
        changeNote: note(input.changeNote),
        createdByUserId: actor.userId,
      });
  await logActivity(actor.userId, 'FORM_DRAFTED', {
    req: actor.req,
    targetType: 'FormVersion',
    targetId: row.id,
    module: 'forms',
    metadata: { key: form.key, number: row.number, fields: flattenFields(definition).length, replaced: Boolean(existing) },
  });
  return (await viewOf(row))!;
}

/** `DELETE /forms/:key/draft` — the draft goes; nothing live changes. */
export async function discardDraft(key: string, actor: Actor): Promise<void> {
  const form = await formByKey(key);
  const draft = await repository.draft(form.id);
  if (!draft) throw new ApiError(404, 'NOT_FOUND', `No draft waiting on "${form.title}"`);
  await repository.deleteDraft(draft.id);
  await logActivity(actor.userId, 'FORM_DRAFT_DISCARDED', {
    req: actor.req,
    targetType: 'FormVersion',
    targetId: draft.id,
    module: 'forms',
    metadata: { key: form.key, number: draft.number },
  });
}

/** `POST /forms/:key/publish` — the draft goes live, checked again (the audience may have changed since it was saved); the live one retires. */
export async function publishDraft(key: string, input: { changeNote?: string | null | undefined }, actor: Actor): Promise<FormVersionView> {
  const form = await formByKey(key);
  const draft = await repository.draft(form.id);
  if (!draft) throw new ApiError(409, 'CONFLICT', `Nothing to publish on "${form.title}" — save a draft first`);
  const definition = validateDefinition(draft.definition, form.audience);
  assertPublishable(definition);
  const published = await repository.publishDraft(draft.id, form.id, actor.userId, new Date(), input.changeNote === undefined ? null : note(input.changeNote));
  await logActivity(actor.userId, 'FORM_PUBLISHED', {
    req: actor.req,
    targetType: 'FormVersion',
    targetId: published.id,
    module: 'forms',
    metadata: { key: form.key, number: published.number, fields: flattenFields(definition).length },
  });
  return (await viewOf(published))!;
}

/** `POST /forms/:key/versions/:number/restore` — an old version's questions, published anew as the newest version. */
export async function restoreVersion(key: string, number: number, actor: Actor): Promise<FormVersionView> {
  const form = await formByKey(key);
  const source = await repository.byNumber(form.id, number);
  if (!source) throw new ApiError(404, 'NOT_FOUND', `"${form.title}" has no version ${number}`);
  if (source.status === 'DRAFT') throw new ApiError(409, 'CONFLICT', 'That version is the draft — publish it instead');
  if (source.status === 'PUBLISHED') throw new ApiError(409, 'CONFLICT', `Version ${number} is already live`);
  const definition = validateDefinition(source.definition, form.audience);
  assertPublishable(definition);
  const restored = await repository.publishCopy({
    formId: form.id,
    number: (await repository.highestNumber(form.id)) + 1,
    definition: json(definition),
    changeNote: `Restored from version ${number}`,
    by: actor.userId,
    at: new Date(),
  });
  await logActivity(actor.userId, 'FORM_RESTORED', {
    req: actor.req,
    targetType: 'FormVersion',
    targetId: restored.id,
    module: 'forms',
    metadata: { key: form.key, number: restored.number, restoredFrom: number },
  });
  return (await viewOf(restored))!;
}

/** The definition the desk's submissions table is drawn from: the live one, else the draft, else nothing. */
export async function currentDefinition(form: Form): Promise<FormDefinition | null> {
  const live = await repository.live(form.id);
  if (live) return definitionOf(live);
  const draft = await repository.draft(form.id);
  return draft ? definitionOf(draft) : null;
}
