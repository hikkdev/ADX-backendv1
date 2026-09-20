import { z } from 'zod';

/**
 * QR-8 (17 Sep 2026): a listing draft, as the phone saves it.
 *
 * The wizard's answers travel whole — they are the phone's, in the shape
 * its flow config gave them, and the server keeps them as sent; `category`
 * and `title` are lifted out for the desk's list, `stepIndex`/`stepKey`
 * say where the person stopped. Nothing here is validated as a listing:
 * a draft is by definition unfinished.
 */
export const saveDraftSchema = z.object({
  category: z.string().trim().min(1).max(40).nullable().optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  stepIndex: z.number().int().min(0).max(50).optional(),
  stepKey: z.string().trim().min(1).max(60).nullable().optional(),
  answers: z.record(z.string(), z.unknown()),
});
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

/** The desk's list: every publisher's drafts, oldest untouched first by default. */
export const deskDraftsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Only drafts untouched for at least this many days. */
  idleDays: z.coerce.number().int().min(0).max(365).optional(),
  category: z.string().trim().min(1).optional(),
  /** A publisher's name, mobile or reference, or the draft's reference or title. */
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(['IDLE', 'NEWEST']).default('IDLE'),
});
export type DeskDraftsQuery = z.infer<typeof deskDraftsQuerySchema>;
