import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { assertCanCreateForPublisher, type ListingActor } from '../listings';
import { formatGuide, formatGuides, templateCsv } from './import-formats';
import { commitListingImport, commitRateCardImport, validateListingImport, validateRateCardImport } from './listing-imports.service';
import { importBodySchema, listImportsQuerySchema, partyKeySchema, publisherQuerySchema, type ListingKind, type PartyKey } from './party-imports.schema';
import { commitImport, getImport, importReportCsv, listImports, parseImportCsv, revokeImport, validateImport, type RawImportRow } from './party-imports.service';

/** `:party` is one of four words; anything else is a 400, never a table lookup. */
function partyOf(req: Request): PartyKey {
  const parsed = partyKeySchema.safeParse(req.params['party']);
  if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', 'party must be one of advertisers, agents, print-partners, employees');
  return parsed.data;
}

const idOf = (req: Request) => req.params['id'] as string;

/** The two shapes a file arrives in — a multipart CSV under `file`, or a JSON body of rows — as one input. */
function rowsOf(req: Request): { fileName?: string | undefined; note?: string | undefined; rows: RawImportRow[] } {
  const file = req.file as { originalname: string; buffer: Buffer } | undefined;
  if (file) {
    const rows = parseImportCsv(file.buffer.toString('utf8'));
    if (rows.length === 0) throw new ApiError(400, 'BAD_REQUEST', 'The CSV has a header and no rows');
    const note = typeof req.body?.['note'] === 'string' ? (req.body['note'] as string).trim().slice(0, 500) : undefined;
    return { fileName: file.originalname, note, rows };
  }
  const parsed = importBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Send a CSV under `file` or a JSON body of rows', parsed.error.flatten());
  return { fileName: parsed.data.fileName, note: parsed.data.note, rows: parsed.data.rows.map((data, index) => ({ rowNumber: index + 1, data })) };
}

/**
 * POST /party-imports/:party — Lot S.
 *
 * Two shapes in: a multipart CSV under `file` (the `uploads` CSV multer runs
 * ahead of this handler and leaves it in memory), or a JSON body of rows.
 * One shape out: a VALIDATED import with its per-row plan.
 */
export async function importPartyHandler(req: Request, res: Response): Promise<void> {
  const party = partyOf(req);
  res.status(201).json({ success: true, data: await validateImport(party, rowsOf(req), req.user!.sub, req) });
}

export async function listImportsHandler(req: Request, res: Response): Promise<void> {
  const party = partyOf(req);
  const query = listImportsQuerySchema.safeParse(req.query);
  if (!query.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', query.error.flatten());
  res.json({ success: true, data: await listImports(party, query.data) });
}

export async function getImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getImport(partyOf(req), idOf(req)) });
}

export async function commitImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await commitImport(partyOf(req), idOf(req), req.user!.sub, req) });
}

export async function revokeImportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await revokeImport(partyOf(req), idOf(req), req.user!.sub, req) });
}

/* ── Lot U: the publisher's two kinds ─────────────────────────────────── */

const actorOf = (req: Request): ListingActor => ({ userId: req.user!.sub, isAdmin: (req.user?.roles ?? []).includes('ADMIN') });

/** `?publisherId=` — required on the write routes and for an agent's reads. */
function publisherIdOf(req: Request): string {
  const parsed = publisherQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'publisherId is required', parsed.error.flatten());
  return parsed.data.publisherId;
}

/** An import read by id: the act rule the write used, so an agent reads only their publisher's. */
async function ownedImport(kind: ListingKind, req: Request) {
  const found = await getImport(kind, idOf(req));
  const actor = actorOf(req);
  if (!actor.isAdmin) await assertCanCreateForPublisher(found.publisherId ?? '', actor);
  return found;
}

/**
 * The handlers for `/party-imports/listings` and `/party-imports/rate-card`,
 * one set per kind. ADMIN or AGENT_PUBLISHER at the router; the act rule an
 * agent's own listing creation uses (`listings.assertCanCreateForPublisher`)
 * in the service, against the publisher the import is for.
 */
export function listingKindHandlers(kind: ListingKind) {
  const validate = kind === 'listings' ? validateListingImport : validateRateCardImport;
  const commit = kind === 'listings' ? commitListingImport : commitRateCardImport;
  return {
    async import(req: Request, res: Response): Promise<void> {
      const publisherId = publisherIdOf(req);
      res.status(201).json({ success: true, data: await validate(publisherId, rowsOf(req), actorOf(req), req) });
    },
    async list(req: Request, res: Response): Promise<void> {
      const query = listImportsQuerySchema.safeParse(req.query);
      if (!query.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', query.error.flatten());
      const actor = actorOf(req);
      // ADX may read every publisher's; an agent reads one publisher's, under the act rule.
      if (!actor.isAdmin) await assertCanCreateForPublisher(publisherIdOf(req), actor);
      res.json({ success: true, data: await listImports(kind, query.data) });
    },
    async get(req: Request, res: Response): Promise<void> {
      res.json({ success: true, data: await ownedImport(kind, req) });
    },
    async commit(req: Request, res: Response): Promise<void> {
      res.json({ success: true, data: await commit(idOf(req), actorOf(req), req.user!.sub, req) });
    },
    async revoke(req: Request, res: Response): Promise<void> {
      await ownedImport(kind, req);
      res.json({ success: true, data: await revokeImport(kind, idOf(req), req.user!.sub, req) });
    },
    async report(req: Request, res: Response): Promise<void> {
      await ownedImport(kind, req);
      const id = idOf(req);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${kind}-import-${id}.csv"`);
      res.send(await importReportCsv(kind, id));
    },
  };
}

/* ── Lot U: the format guide ──────────────────────────────────────────── */

export async function formatsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: formatGuides() });
}

export async function formatHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: formatGuide(req.params['kind'] as string) });
}

export async function formatTemplateHandler(req: Request, res: Response): Promise<void> {
  const kind = req.params['kind'] as string;
  const csv = templateCsv(kind);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${kind}-template.csv"`);
  res.send(csv);
}

export async function importReportHandler(req: Request, res: Response): Promise<void> {
  const party = partyOf(req);
  const id = idOf(req);
  const csv = await importReportCsv(party, id);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${party}-import-${id}.csv"`);
  res.send(csv);
}
