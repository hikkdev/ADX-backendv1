import { z } from 'zod';
import { LEGAL_KINDS } from './legal.types';

export const legalKindSchema = z.enum(LEGAL_KINDS);

const title = z.string().trim().min(1).max(200);
const summary = z.string().trim().max(300);
/** Markdown. A policy with schedules runs to pages. */
const body = z.string().min(1).max(200_000);
const changeNote = z.string().trim().max(500);
/** The structured half of Contact info and FAQs: any JSON object the screens read. */
const meta = z.record(z.string(), z.unknown());

export const createDocumentSchema = z.object({
  kind: legalKindSchema,
  title,
  summary: summary.optional(),
  body,
  meta: meta.optional(),
  changeNote: changeNote.optional(),
  /** Go live in the same call. Off by default: read it over first. */
  activate: z.boolean().optional(),
});

export const updateDocumentSchema = z
  .object({
    title: title.optional(),
    summary: summary.nullable().optional(),
    body: body.optional(),
    meta: meta.nullable().optional(),
    changeNote: changeNote.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'Nothing to change' });

export const listDocumentsQuerySchema = z.object({ kind: legalKindSchema.optional() });
