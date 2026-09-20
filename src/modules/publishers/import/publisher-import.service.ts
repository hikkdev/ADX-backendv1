import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import { formatCsv, parseCsv } from '../../../shared/csv';
import type { PublisherImportOutcome } from '../../../shared/database';
import { normalizeMobile } from '../../auth';
import { allocateIdentifier } from '../../identifiers';
import { cityKeyFor, resolveCity } from '../../pricing';
import { prismaPublisherImportRepository as repository } from './prisma-publisher-import.repository';
import { IMPORT_COLUMNS, importRowSchema, type ImportRow } from './publisher-import.schema';
import type { CommitAction, ImportPublisherFields, MatchedPublisher, NewImportRow } from './publisher-import.repository';

/**
 * The legacy book, imported — Lot D (Q43/Q86).
 *
 * Two steps, on purpose: validation plans every row and writes the plan
 * down (VALIDATED, with a per-row report), and a second call commits it.
 * Ops read the report between the two. The rules are decision 86's: a
 * mobile match merges, filling only the columns the publisher has empty; a
 * PAN already on another publisher is a warning, not a refusal; an unknown
 * city is a warning, not a refusal; nothing refuses the batch; and every
 * publisher created lands PENDING_ONBOARDING with KYC PENDING and no agent
 * — an import never verifies anyone and never credits anyone's book.
 */

export type RawImportRow = { rowNumber: number; data: Record<string, unknown> };

/** The CSV by header name, in any order; row numbers count the header as line 1. */
export function parseImportCsv(text: string): RawImportRow[] {
  const [header, ...lines] = parseCsv(text);
  if (!header) return [];
  const names = header.map((cell) => cell.trim());
  return lines.map((cells, index) => ({
    rowNumber: index + 2,
    data: Object.fromEntries(names.map((name, column) => [name, (cells[column] ?? '').trim()])),
  }));
}

type Plan =
  | { action: 'CREATE'; warnings: string[] }
  | { action: 'MERGE'; publisherId: string; fill: ImportPublisherFields; warnings: string[] };

const fieldsOf = (row: ImportRow): ImportPublisherFields => {
  const { mobile: _mobile, ...rest } = row;
  const fields: ImportPublisherFields = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) (fields as Record<string, unknown>)[key] = value;
  return fields;
};

/** The fields of `incoming` the publisher does not already hold — and that an earlier row of this batch has not already claimed. */
/** QR-13: the columns that live on the person or the pin — a merge leaves an existing publisher's account alone. */
export const PERSON_OR_PIN_COLUMNS = new Set<string>(['firstName', 'lastName', 'dateOfBirth', 'gender', 'latitude', 'longitude']);

function blanksOf(publisher: MatchedPublisher, incoming: ImportPublisherFields, claimed: Set<string>): ImportPublisherFields {
  const fill: ImportPublisherFields = {};
  for (const [key, value] of Object.entries(incoming) as [keyof ImportPublisherFields, unknown][]) {
    if (PERSON_OR_PIN_COLUMNS.has(key)) continue;
    const current = key === 'panNumber' ? publisher.kyc?.panNumber : publisher[key as keyof MatchedPublisher];
    const empty = current === null || current === undefined || current === '';
    if (empty && !claimed.has(`${publisher.id}:${key}`)) fill[key] = value as never;
  }
  return fill;
}

export async function validateImport(
  input: { fileName?: string; note?: string; rows: RawImportRow[] },
  byUserId: string,
  req?: Request,
) {
  // First pass: shape and normalisation. Mobile is the key everything else hangs on.
  const parsed = input.rows.map((raw) => {
    const result = importRowSchema.safeParse(raw.data);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path[0] ? String(issue.path[0]) : 'row';
      const message = field === 'mobile' && (raw.data['mobile'] === undefined || raw.data['mobile'] === '') ? 'mobile is required' : `${field}: ${issue?.message ?? 'invalid'}`;
      return { rowNumber: raw.rowNumber, raw: raw.data, row: null, message };
    }
    return { rowNumber: raw.rowNumber, raw: raw.data, row: { ...result.data, mobile: normalizeMobile(result.data.mobile) }, message: null };
  });

  const valid = parsed.filter((item): item is typeof item & { row: ImportRow } => item.row !== null);
  const [byMobile, byPan] = await Promise.all([
    repository.findPublishersByMobiles([...new Set(valid.map((item) => item.row.mobile))]),
    repository.findPublishersByPans([...new Set(valid.map((item) => item.row.panNumber).filter((pan): pan is string => Boolean(pan)))]),
  ]);
  const mobileIndex = new Map(byMobile.map((publisher) => [publisher.mobile, publisher]));
  const panIndex = new Map(byPan.map((publisher) => [publisher.kyc?.panNumber ?? '', publisher]));

  // Second pass: the plan. Rows are planned in order so a duplicate inside
  // the batch is the later one, and a merge does not fill a column an earlier
  // row of the same batch already claimed.
  const seen = new Map<string, number>();
  const claimed = new Set<string>();
  const rows: NewImportRow[] = [];
  const counts = { rowCount: parsed.length, createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };

  for (const item of parsed) {
    if (!item.row) {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...item.raw, plan: null }, outcome: 'INVALID', publisherId: null, message: item.message });
      continue;
    }
    const row = item.row;
    const data: Record<string, unknown> = { ...row };
    const warnings: string[] = [];

    const earlier = seen.get(row.mobile);
    if (earlier !== undefined) {
      counts.skippedCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'SKIPPED', publisherId: null, message: `Duplicate of row ${earlier} in this file` });
      continue;
    }
    seen.set(row.mobile, item.rowNumber);

    if (row.city) {
      const canonical = await resolveCity(row.city);
      if (canonical) data['city'] = canonical;
      else warnings.push(`City "${row.city}" is not in the catalogue; kept as typed`);
    }
    const panHolder = row.panNumber ? panIndex.get(row.panNumber) : undefined;
    if (panHolder && panHolder.mobile !== row.mobile) {
      warnings.push(`PAN ${row.panNumber} is already on ${panHolder.displayId ?? panHolder.id} (${panHolder.name})`);
    }

    const fields = fieldsOf({ ...row, city: (data['city'] as string | undefined) ?? row.city });
    const existing = mobileIndex.get(row.mobile);
    let plan: Plan;
    let outcome: PublisherImportOutcome;
    let message: string | null;

    if (existing) {
      const fill = blanksOf(existing, fields, claimed);
      for (const key of Object.keys(fill)) claimed.add(`${existing.id}:${key}`);
      plan = { action: 'MERGE', publisherId: existing.id, fill, warnings };
      if (Object.keys(fill).length === 0) {
        outcome = 'SKIPPED';
        counts.skippedCount += 1;
        message = `Already on the book as ${existing.displayId ?? existing.id}; nothing to add`;
      } else {
        outcome = 'MERGED';
        counts.mergedCount += 1;
        message = `Merges into ${existing.displayId ?? existing.id}: fills ${Object.keys(fill).join(', ')}`;
      }
      if (warnings.length) message = `${message}. ${warnings.join('. ')}`;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, publisherId: existing.id, message });
      continue;
    }

    plan = { action: 'CREATE', warnings };
    counts.createdCount += 1;
    // E6: a WARNING row still creates; it is counted on its own as well.
    if (warnings.length) counts.warningCount += 1;
    outcome = warnings.length ? 'WARNING' : 'CREATED';
    message = warnings.length ? `Will create; ${warnings.join('. ')}` : 'Will create as a pending publisher';
    rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, publisherId: null, message });
  }

  const created = await repository.createImport({
    fileName: input.fileName ?? `rows-${new Date().toISOString().slice(0, 10)}.json`,
    note: input.note ?? null,
    uploadedById: byUserId,
    rows,
    counts,
  });
  await logActivity(byUserId, 'PUBLISHER_IMPORT_VALIDATED', {
    req,
    targetType: 'PublisherImport',
    targetId: created.id,
    module: 'publishers',
    metadata: { fileName: created.fileName, ...counts },
  });
  return created;
}

export const listImports = () => repository.listImports();

export async function getImport(id: string) {
  const found = await repository.findImport(id);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Import not found');
  return found;
}

/**
 * The second step. Only a VALIDATED import commits, and only once: the
 * plan written at validation is what runs, row by row, in one transaction.
 * Identifiers are minted here, ahead of the transaction, one per create.
 */
export async function commitImport(id: string, byUserId: string, req?: Request, byRole = 'Admin') {
  const found = await getImport(id);
  if (found.status !== 'VALIDATED') {
    throw new ApiError(409, 'CONFLICT', found.status === 'COMMITTED' ? 'This import has already been committed' : 'This import was revoked');
  }

  const actions: CommitAction[] = [];
  for (const row of found.rows) {
    const data = row.data as Record<string, unknown> & { plan?: Plan | null };
    const plan = data.plan;
    if (!plan) continue;
    if (plan.action === 'MERGE') {
      if (Object.keys(plan.fill).length === 0) continue;
      // Lot X-B: a merge that fills the city stamps its key beside it.
      const cityId = plan.fill.city !== undefined ? ((await cityKeyFor(plan.fill.city))?.cityId ?? null) : undefined;
      actions.push({ rowId: row.id, action: 'MERGE', publisherId: plan.publisherId, fill: plan.fill, ...(cityId !== undefined ? { cityId } : {}) });
      continue;
    }
    const fields: ImportPublisherFields = {};
    for (const column of IMPORT_COLUMNS) {
      if (column === 'mobile') continue;
      const value = data[column];
      if (typeof value === 'string' && value !== '') (fields as Record<string, string>)[column] = value;
    }
    // QR-13: the same number the OTP door canonicalises to, so the account
    // the import opens is the one the person signs in as.
    const mobile = normalizeMobile(String(data['mobile']));
    // The pin and the person ride as their own types, not strings.
    for (const numeric of ['latitude', 'longitude'] as const) {
      const value = data[numeric];
      if (typeof value === 'number') (fields as Record<string, unknown>)[numeric] = value;
    }
    // Lot X-B: the key the row's city (canonical slug, or as typed) resolves to; cached a minute per spelling.
    const cityId = fields.city !== undefined ? ((await cityKeyFor(fields.city))?.cityId ?? null) : undefined;
    actions.push({
      rowId: row.id,
      action: 'CREATE',
      publisher: { ...fields, mobile, name: fields.name ?? mobile, displayId: await allocateIdentifier('PUBLISHER') },
      ...(cityId !== undefined ? { cityId } : {}),
      // QR-13: a row that names the person opens their account with the publisher.
      ...(fields.firstName !== undefined ? { account: { displayId: await allocateIdentifier('USER') } } : {}),
      // QR-14: the batch's uploader is who onboarded the row.
      onboardedBy: { userId: byUserId, role: byRole },
    });
  }

  const committed = await repository.commitImport(id, actions, new Date());
  await logActivity(byUserId, 'PUBLISHER_IMPORT_COMMITTED', {
    req,
    targetType: 'PublisherImport',
    targetId: id,
    module: 'publishers',
    metadata: { fileName: committed.fileName, created: committed.createdCount, merged: committed.mergedCount, skipped: committed.skippedCount, warnings: committed.warningCount, invalid: committed.invalidCount },
  });
  return committed;
}

/** Only an uncommitted import can be withdrawn; a committed one is history. */
export async function revokeImport(id: string, byUserId: string, req?: Request) {
  const found = await getImport(id);
  if (found.status !== 'VALIDATED') throw new ApiError(409, 'CONFLICT', 'Only an uncommitted import can be revoked');
  const revoked = await repository.setStatus(id, 'REVOKED');
  await logActivity(byUserId, 'PUBLISHER_IMPORT_REVOKED', { req, targetType: 'PublisherImport', targetId: id, module: 'publishers' });
  return revoked;
}

/** The rows as ops read them: outcome and message first, then the book's columns. */
export async function importReportCsv(id: string): Promise<string> {
  const found = await getImport(id);
  const header = ['rowNumber', 'outcome', 'message', 'publisherId', ...IMPORT_COLUMNS];
  const lines = found.rows.map((row) => {
    const data = row.data as Record<string, unknown>;
    return [row.rowNumber, row.outcome, row.message, row.publisherId, ...IMPORT_COLUMNS.map((column) => (typeof data[column] === 'string' ? (data[column] as string) : ''))];
  });
  return formatCsv([header, ...lines]);
}
