import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../shared/auth';
import { ApiError } from '../../shared/errors';
import { formSubmitLimiter, verifyCaptcha } from '../../shared/security';
import { fieldKinds } from './form-schema';
import { bboxQuerySchema, createFormSchema, filterOf, patchFormSchema, publishSchema, saveDraftSchema, submissionStatusSchema, submissionsQuerySchema, submitSchema } from './forms.schema';
import { archiveForm, createForm, discardDraft, getForm, listForms, listVersions, publishDraft, publishedFormView, restoreForm, restoreVersion, saveDraft, updateForm } from './forms.service';
import { listSubmissions, loadPublishedForm, setSubmissionStatus, submissionsCsv, submissionsInBox, submit, type PublishedForm } from './submissions.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());
const actorOf = (req: Request) => ({ userId: req.user!.sub, req });
const keyOf = (req: Request) => String(req.params['key'] ?? '');

/* ── Public ───────────────────────────────────────────────────────── */

/** `GET /app/forms/:key` — the published form, or 404. */
export async function publicFormHandler(req: Request, res: Response): Promise<void> {
  const view = await publishedFormView(keyOf(req));
  if (!view) throw new ApiError(404, 'NOT_FOUND', `No form "${keyOf(req)}"`);
  res.json({ success: true, data: view });
}

/**
 * The door's guard depends on the form: a PUBLIC form takes anyone behind the
 * captcha and the per-IP limiter; a SIGNED_IN form takes a token. The form is
 * read once here and handed to the handler on `res.locals`.
 */
export async function submissionGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const published = await loadPublishedForm(keyOf(req));
  res.locals['publishedForm'] = published;
  if (published.form.audience === 'SIGNED_IN') {
    authenticate(req, res, next);
    return;
  }
  formSubmitLimiter(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    void verifyCaptcha(req, res, next);
  });
}

/** `POST /app/forms/:key/submissions` → 201 `{ id, message }`. */
export async function submitHandler(req: Request, res: Response): Promise<void> {
  const published = res.locals['publishedForm'] as PublishedForm | undefined;
  if (!published) throw new ApiError(500, 'INTERNAL_ERROR', 'The submission gate did not run');
  const parsed = submitSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const answer = await submit(published, parsed.data, { userId: req.user?.sub ?? null, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ success: true, data: answer });
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listForms() });
}

export async function fieldKindsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: fieldKinds() });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const parsed = createFormSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.status(201).json({ success: true, data: await createForm(parsed.data, actorOf(req)) });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getForm(keyOf(req)) });
}

export async function updateHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchFormSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await updateForm(keyOf(req), parsed.data, actorOf(req)) });
}

export async function saveDraftHandler(req: Request, res: Response): Promise<void> {
  const parsed = saveDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await saveDraft(keyOf(req), parsed.data, actorOf(req)) });
}

export async function discardDraftHandler(req: Request, res: Response): Promise<void> {
  await discardDraft(keyOf(req), actorOf(req));
  res.json({ success: true, data: { message: 'Draft discarded' } });
}

export async function publishHandler(req: Request, res: Response): Promise<void> {
  const parsed = publishSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await publishDraft(keyOf(req), parsed.data, actorOf(req)) });
}

export async function versionsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listVersions(keyOf(req)) });
}

export async function restoreHandler(req: Request, res: Response): Promise<void> {
  const number = Number(req.params['number']);
  if (!Number.isInteger(number) || number < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'A version number is a whole number from 1');
  res.json({ success: true, data: await restoreVersion(keyOf(req), number, actorOf(req)) });
}

export async function archiveHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await archiveForm(keyOf(req), actorOf(req)) });
}

export async function restoreFormHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restoreForm(keyOf(req), actorOf(req)) });
}

/* ── The answers ──────────────────────────────────────────────────── */

export async function submissionsHandler(req: Request, res: Response): Promise<void> {
  const parsed = submissionsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listSubmissions(keyOf(req), { ...filterOf(parsed.data), page: parsed.data.page, pageSize: parsed.data.pageSize }) });
}

export async function submissionsCsvHandler(req: Request, res: Response): Promise<void> {
  const parsed = submissionsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const csv = await submissionsCsv(keyOf(req), filterOf(parsed.data));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="form-${keyOf(req)}-submissions.csv"`);
  res.send(csv);
}

export async function submissionsMapHandler(req: Request, res: Response): Promise<void> {
  const parsed = bboxQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await submissionsInBox(keyOf(req), parsed.data.bbox) });
}

export async function submissionStatusHandler(req: Request, res: Response): Promise<void> {
  const parsed = submissionStatusSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await setSubmissionStatus(keyOf(req), String(req.params['id'] ?? ''), parsed.data.status, actorOf(req)) });
}
