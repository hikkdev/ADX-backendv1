import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import * as schema from './reconciliation.schema';
import {
  autoMatch,
  createProfile,
  getLine,
  ignoreLine,
  importStatement,
  listImports,
  listLines,
  listProfiles,
  matchLine,
  summary,
  unmatchLine,
} from './reconciliation.service';
import { iterateLineCsv, LINE_EXPORT_ROW_CAP, lineCsvHeader, requireImport } from './reconciliation-export.service';
import type { ImportRow, LineRow, MatchRow, ProfileRow } from './reconciliation.repository';

/**
 * `/finance/reconciliation` — Lot B (Q85). Every write is audited by hand:
 * an import names the account and the counts, a match names the record and
 * the difference, an auto-match run names its tally.
 */

function parse<T>(s: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = s.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;
const lineId = (req: Request) => req.params['id'] as string;

const shapeProfile = (row: ProfileRow) => ({
  id: row.id,
  name: row.name,
  bankName: row.bankName,
  columns: row.columns,
  dateFormat: row.dateFormat,
  createdAt: row.createdAt,
});

const shapeImport = (row: ImportRow) => ({
  id: row.id,
  bankAccountId: row.bankAccountId,
  profileId: row.profileId,
  fileId: row.fileId,
  fileName: row.fileName,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  lineCount: row.lineCount,
  duplicateCount: row.duplicateCount,
  importedByUserId: row.importedByUserId,
  createdAt: row.createdAt,
});

const shapeMatch = (match: MatchRow | null) =>
  match
    ? {
        id: match.id,
        withdrawalId: match.withdrawalId,
        topUpId: match.topUpId,
        paymentId: match.paymentId,
        ledgerTransactionId: match.ledgerTransactionId,
        difference: money(match.difference),
        kind: match.kind,
        matchedByUserId: match.matchedByUserId,
        note: match.note,
        createdAt: match.createdAt,
      }
    : null;

const shapeLine = (row: LineRow) => ({
  id: row.id,
  importId: row.importId,
  bankAccountId: row.bankAccountId,
  valueDate: row.valueDate,
  description: row.description,
  utr: row.utr,
  direction: row.direction,
  amount: money(row.amount),
  runningBalance: row.runningBalance ? money(row.runningBalance) : null,
  matchStatus: row.matchStatus,
  match: shapeMatch(row.match),
  createdAt: row.createdAt,
});

/* ── Profiles ─────────────────────────────────────────────────────── */

export async function listProfilesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: (await listProfiles()).map(shapeProfile) });
}

export async function createProfileHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.CreateProfileInput>(schema.createProfileSchema, req.body);
  const profile = await createProfile({ ...body, dateFormat: body.dateFormat ?? null });
  await logActivity(userId(req), 'STATEMENT_PROFILE_CREATED', {
    req,
    module: 'reconciliation',
    targetType: 'BankStatementProfile',
    targetId: profile.id,
    metadata: { name: profile.name, bankName: profile.bankName, columns: profile.columns, dateFormat: profile.dateFormat },
  });
  res.status(201).json({ success: true, data: shapeProfile(profile) });
}

/* ── Imports ──────────────────────────────────────────────────────── */

export async function importHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new ApiError(400, 'BAD_REQUEST', 'Attach the statement as `file`');
  const body = parse<{ bankAccountId: string; profileId?: string }>(schema.importBodySchema, req.body ?? {});
  const outcome = await importStatement({
    bankAccountId: body.bankAccountId,
    profileId: body.profileId ?? null,
    file: { buffer: req.file.buffer, originalname: req.file.originalname },
    byUserId: userId(req),
  });
  await logActivity(userId(req), 'STATEMENT_IMPORTED', {
    req,
    module: 'reconciliation',
    targetType: 'BankStatementImport',
    targetId: outcome.import.id,
    metadata: {
      bankAccountId: body.bankAccountId,
      profileId: body.profileId ?? null,
      fileName: outcome.import.fileName,
      created: outcome.created,
      duplicates: outcome.duplicates,
      problems: outcome.problems.length,
    },
  });
  res.status(201).json({
    success: true,
    data: { import: shapeImport(outcome.import), created: outcome.created, duplicates: outcome.duplicates, problems: outcome.problems },
  });
}

export async function listImportsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ bankAccountId?: string; limit?: number }>(schema.importsQuerySchema, req.query);
  res.json({ success: true, data: (await listImports(query)).map(shapeImport) });
}

/* ── Exports (Lot G, Q125) ────────────────────────────────────────── */

/**
 * The CSV as a stream: audited before the first byte (an export that fails
 * half-way was still an export), a thousand lines a slice, under the cap.
 */
async function streamLines(req: Request, res: Response, filter: Parameters<typeof iterateLineCsv>[0], filename: string, target: { type: string; id: string }): Promise<void> {
  await logActivity(userId(req), 'RECONCILIATION_LINES_EXPORTED', {
    req,
    module: 'reconciliation',
    targetType: target.type,
    targetId: target.id,
    metadata: { filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() }, cap: LINE_EXPORT_ROW_CAP },
  });
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write(lineCsvHeader());
  for await (const chunk of iterateLineCsv(filter)) res.write(chunk);
  res.end();
}

/** GET /finance/reconciliation/imports/:id/export.csv — every line of one import with its match, its record and its resolver. */
export async function exportImportHandler(req: Request, res: Response): Promise<void> {
  const params = parse<{ id: string }>(schema.importIdParamSchema, req.params);
  const row = await requireImport(params.id);
  const stem = row.fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'statement';
  await streamLines(req, res, { importId: row.id }, `reconciliation-${stem}-${row.id}.csv`, { type: 'BankStatementImport', id: row.id });
}

/** GET /finance/reconciliation/lines/export.csv?status&bankAccountId&importId&from&to&q — the desk's filters, no page. */
export async function exportLinesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.LinesExportQuery>(schema.linesExportQuerySchema, req.query);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await streamLines(
    req,
    res,
    { status: query.status as LineRow['matchStatus'][] | undefined, bankAccountId: query.bankAccountId, importId: query.importId, from: query.from, to: query.to, q: query.q },
    `reconciliation-lines-${stamp}.csv`,
    { type: 'BankAccount', id: query.bankAccountId ?? 'all' },
  );
}

/* ── Lines ────────────────────────────────────────────────────────── */

export async function listLinesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.LinesQuery>(schema.linesQuerySchema, req.query);
  const page = await listLines(query);
  res.json({ success: true, data: { ...page, items: page.items.map(shapeLine) } });
}

export async function autoMatchHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ bankAccountId?: string; from?: Date; to?: Date }>(schema.windowSchema, req.body ?? {});
  const outcome = await autoMatch({ ...body, byUserId: userId(req) });
  await logActivity(userId(req), 'RECONCILIATION_AUTO_MATCHED', {
    req,
    module: 'reconciliation',
    targetType: 'BankAccount',
    targetId: body.bankAccountId ?? 'all',
    metadata: { ...body, scanned: outcome.scanned, matched: outcome.matched, differs: outcome.differs, unmatched: outcome.unmatched, awaitingMarkPaid: outcome.awaitingMarkPaid.length },
  });
  res.json({ success: true, data: outcome });
}

async function auditLine(req: Request, action: string, before: string, line: LineRow, metadata: Record<string, unknown> = {}): Promise<void> {
  await logActivity(userId(req), action, {
    req,
    module: 'reconciliation',
    targetType: 'BankStatementLine',
    targetId: line.id,
    diff: auditDiff({ matchStatus: before }, { matchStatus: line.matchStatus }),
    metadata: { amount: money(line.amount), direction: line.direction, valueDate: line.valueDate, ...metadata },
  });
}

export async function matchLineHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.MatchInput>(schema.matchSchema, req.body);
  const line = await matchLine(lineId(req), { ...body, byUserId: userId(req) });
  await auditLine(req, 'BANK_LINE_MATCHED', 'UNMATCHED', line, { match: shapeMatch(line.match) });
  res.json({ success: true, data: shapeLine(line) });
}

export async function ignoreLineHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ note?: string }>(schema.ignoreSchema, req.body ?? {});
  const line = await ignoreLine(lineId(req), { note: body.note ?? null, byUserId: userId(req) });
  await auditLine(req, 'BANK_LINE_IGNORED', 'UNMATCHED', line, { note: body.note ?? null });
  res.json({ success: true, data: shapeLine(line) });
}

export async function unmatchLineHandler(req: Request, res: Response): Promise<void> {
  const before = await getLine(lineId(req));
  const line = await unmatchLine(lineId(req), { byUserId: userId(req) });
  await auditLine(req, 'BANK_LINE_UNMATCHED', before.matchStatus, line, { previousMatch: shapeMatch(before.match) });
  res.json({ success: true, data: shapeLine(line) });
}

/* ── Summary ──────────────────────────────────────────────────────── */

export async function summaryHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ bankAccountId?: string; from?: Date; to?: Date }>(schema.windowSchema, req.query);
  res.json({ success: true, data: await summary(query) });
}
