import type { Request, Response } from 'express';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { createDocumentSchema, legalKindSchema, listDocumentsQuerySchema, updateDocumentSchema } from './legal.schema';
import {
  activateDocument,
  createDocument,
  currentDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  publicIndex,
  updateDocument,
} from './legal.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// GET /legal — public: every kind with a live version, no bodies.
export async function indexHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await publicIndex() });
}

// GET /legal/:kind — public: the live version with its body.
export async function currentHandler(req: Request, res: Response): Promise<void> {
  const parsed = legalKindSchema.safeParse(String(req.params['kind']).toUpperCase());
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'No such document');
  res.json({ success: true, data: await currentDocument(parsed.data) });
}

/* ── ADMIN ───────────────────────────────────────────────────────── */

export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = listDocumentsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listDocuments(parsed.data.kind) });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getDocument(req.params['id'] as string) });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const parsed = createDocumentSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const document = await createDocument({ ...parsed.data, createdByUserId: req.user!.sub });
  await logActivity(req.user!.sub, 'LEGAL_DOCUMENT_CREATED', req, { documentId: document.id, kind: document.kind, version: document.version });
  res.status(201).json({ success: true, data: document });
}

export async function updateHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateDocumentSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await updateDocument(req.params['id'] as string, parsed.data) });
}

export async function deleteHandler(req: Request, res: Response): Promise<void> {
  await deleteDocument(req.params['id'] as string);
  res.status(204).end();
}

export async function activateHandler(req: Request, res: Response): Promise<void> {
  const document = await activateDocument(req.params['id'] as string);
  await logActivity(req.user!.sub, 'LEGAL_DOCUMENT_ACTIVATED', req, { documentId: document.id, kind: document.kind, version: document.version });
  res.json({ success: true, data: document });
}
