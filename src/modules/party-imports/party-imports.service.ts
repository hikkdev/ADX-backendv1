import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { formatCsv, parseCsv } from '../../shared/csv';
import type { ImportParty } from '../../shared/database';
import { normalizeMobile } from '../auth';
import { citySupport, resolveCity } from '../pricing';
import { prismaPartyImportsRepository as repository } from './prisma-party-imports.repository';
import { ADAPTERS, type CommitContext, type Fields, type PartyAdapter } from './party-adapters';
import type { ImportCounts, MatchedParty, NewImportRow, PartyImportOutcome } from './party-imports.repository';
import { KIND_OF, LISTING_COLUMNS, RATE_CARD_COLUMNS, isListingKind, type ImportKey, type ListImportsQuery, type ParsedRow, type PartyKey } from './party-imports.schema';

/**
 * Lot S — the publisher importer, generalised to the four parties that had
 * none. Two steps, on purpose: validation plans every row and writes the
 * plan down (VALIDATED, with a per-row report), and a second call commits
 * it. Ops read the report between the two.
 *
 * The rules are decision 86's, party for party: a mobile match merges,
 * filling only the columns the party has empty; a PAN or GSTIN already on
 * another row of the party is a warning, not a refusal; an unknown city is a
 * warning, not a refusal; a duplicate mobile inside the batch is skipped; a
 * malformed value is INVALID and names the field; nothing refuses the batch.
 *
 * Unlike the publisher's, the commit is NOT one transaction — see
 * `commitImport` for why, and for the resumable marker it uses instead.
 */

export type RawImportRow = { rowNumber: number; data: Record<string, unknown> };

export const adapterFor = (key: PartyKey): PartyAdapter => ADAPTERS[key];

/** Lot U: the enum an import is stored under, for a party or for one of the publisher's two kinds. */
export const partyOf = (key: ImportKey): ImportParty => (isListingKind(key) ? KIND_OF[key] : ADAPTERS[key].party);

/** Lot U: the file's header, in report order, for any key. */
export const columnsOf = (key: ImportKey): readonly string[] => (isListingKind(key) ? (key === 'listings' ? LISTING_COLUMNS : RATE_CARD_COLUMNS) : ADAPTERS[key].columns);

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
  | { action: 'MERGE'; targetId: string; targetUserId?: string | null; fill: Fields; warnings: string[] };

/** What a commit writes on the row's data once it has acted on it — the resumable marker. */
type RowResult = { action: 'CREATED' | 'MERGED' | 'SKIPPED' | 'FAILED'; targetId: string | null; targetUserId?: string | null; at: string };

type RowData = Record<string, unknown> & { plan?: Plan | null; result?: RowResult | null };

/**
 * T-B: the row as the console reads it — `targetUserId` beside `targetId`.
 * `targetId` is the party record (an Employee id); the employees page is
 * addressed by the account, so the row carries the user id the commit (or
 * the merge plan) named. Null for the parties whose page takes the record.
 */
function rowView<T extends { data: unknown }>(row: T): T & { targetUserId: string | null } {
  const data = row.data as RowData;
  const planned = data.plan?.action === 'MERGE' ? data.plan.targetUserId : null;
  return { ...row, targetUserId: data.result?.targetUserId ?? planned ?? null };
}

function withRowViews<T extends { rows: { data: unknown }[] }>(found: T) {
  return { ...found, rows: found.rows.map(rowView) };
}

/** The row's columns, strings only, mobile aside — what a create writes and a merge may fill. */
function fieldsOf(adapter: PartyAdapter, row: Record<string, unknown>): Fields {
  const fields: Fields = {};
  for (const column of adapter.columns) {
    if (column === 'mobile') continue;
    const value = row[column];
    if (typeof value === 'string' && value !== '') fields[column] = value;
  }
  return fields;
}

/** The mergeable fields of `incoming` the party does not already hold — and that an earlier row of this batch has not already claimed. */
function blanksOf(adapter: PartyAdapter, party: MatchedParty, incoming: Fields, claimed?: Set<string>): Fields {
  const fill: Fields = {};
  for (const key of adapter.mergeable) {
    const value = incoming[key];
    if (value === undefined) continue;
    const current = party.fields[key];
    const empty = current === null || current === undefined || current === '';
    if (empty && !claimed?.has(`${party.id}:${key}`)) fill[key] = value;
  }
  return fill;
}

const nameOf = (party: MatchedParty) => `${party.displayId ?? party.id} (${party.label})`;

export async function validateImport(
  key: PartyKey,
  input: { fileName?: string | undefined; note?: string | undefined; rows: RawImportRow[] },
  byUserId: string,
  req?: Request,
) {
  const adapter = adapterFor(key);

  // First pass: shape and normalisation. Mobile is the key everything else hangs on.
  const parsed = input.rows.map((raw) => {
    const result = adapter.rowSchema.safeParse(raw.data);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path[0] ? String(issue.path[0]) : 'row';
      const blank = raw.data[field] === undefined || raw.data[field] === '';
      const message = blank ? `${field} is required` : `${field}: ${issue?.message ?? 'invalid'}`;
      return { rowNumber: raw.rowNumber, raw: raw.data, row: null, message };
    }
    const data = result.data as ParsedRow;
    return { rowNumber: raw.rowNumber, raw: raw.data, row: { ...data, mobile: normalizeMobile(data.mobile) } as ParsedRow, message: null };
  });

  const valid = parsed.filter((item): item is typeof item & { row: ParsedRow } => item.row !== null);
  const match = await adapter.match(valid.map((item) => item.row));
  const mobileIndex = new Map(match.byMobile.map((party) => [party.mobile, party]));

  // Second pass: the plan. Rows are planned in order so a duplicate inside
  // the batch is the later one, and a merge does not fill a column an earlier
  // row of the same batch already claimed.
  const seen = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const claimed = new Set<string>();
  const rows: NewImportRow[] = [];
  const counts: ImportCounts = { rowCount: parsed.length, createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };

  for (const item of parsed) {
    if (!item.row) {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...item.raw, plan: null }, outcome: 'INVALID', targetId: null, message: item.message });
      continue;
    }
    const row = item.row;
    const data: Record<string, unknown> = { ...row };
    const warnings: string[] = [];

    const earlier = seen.get(row.mobile);
    if (earlier !== undefined) {
      counts.skippedCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'SKIPPED', targetId: null, message: `Duplicate of row ${earlier} in this file` });
      continue;
    }
    seen.set(row.mobile, item.rowNumber);

    const existing = mobileIndex.get(row.mobile);

    // A create that the party's own service would refuse is INVALID here,
    // named, rather than a failure at commit: a partner's number on another
    // account; an email already on an account, or twice in the file.
    const blocked = match.blockedMobiles.get(row.mobile);
    if (!existing && blocked) {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'INVALID', targetId: null, message: `mobile: ${blocked}` });
      continue;
    }
    const email = row['email'];
    if (adapter.uniqueEmail && email && !existing) {
      const earlierEmail = seenEmails.get(email);
      const holder = match.takenEmails.get(email);
      const reason = holder !== undefined && holder !== row.mobile
        ? 'email: already on another account'
        : earlierEmail !== undefined
          ? `email: already used by row ${earlierEmail} in this file`
          : null;
      if (reason) {
        counts.invalidCount += 1;
        rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'INVALID', targetId: null, message: reason });
        continue;
      }
      seenEmails.set(email, item.rowNumber);
    }

    if (row['city']) {
      const canonical = await resolveCity(row['city']);
      if (canonical) data['city'] = canonical;
      else warnings.push(`City "${row['city']}" is not in the catalogue; kept as typed`);
    }
    // Lot V: a new agent is onboarded only where the city's rollout stage
    // says so — the gate `agents.createAgent` applies at commit, named here
    // so the report says so first. A merge into an existing agent is not
    // an onboarding.
    if (adapter.party === 'AGENT' && !existing && row['city']) {
      const view = await citySupport(row['city']);
      if (view.resolved && !view.switches.agentOnboarding) {
        counts.invalidCount += 1;
        rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'INVALID', targetId: null, message: `city: ADX is not onboarding agents in ${view.city!.name} (${view.stage!.toLowerCase()})` });
        continue;
      }
    }
    const pan = row['panNumber'];
    const panHolder = pan ? match.byPan.get(pan) : undefined;
    if (panHolder && panHolder.mobile !== row.mobile) warnings.push(`PAN ${pan} is already on ${nameOf(panHolder)}`);
    const gstin = row['gstin'];
    const gstinHolder = gstin ? match.byGstin.get(gstin) : undefined;
    if (gstinHolder && gstinHolder.mobile !== row.mobile) warnings.push(`GSTIN ${gstin} is already on ${nameOf(gstinHolder)}`);

    const unwritten = adapter.unwritten.filter((column) => row[column]);
    const note = unwritten.length ? `${unwritten.join(', ')} kept on the report only` : null;

    const fields = fieldsOf(adapter, data);
    let plan: Plan;
    let outcome: PartyImportOutcome;
    let message: string;

    if (existing) {
      const fill = blanksOf(adapter, existing, fields, claimed);
      for (const column of Object.keys(fill)) claimed.add(`${existing.id}:${column}`);
      plan = { action: 'MERGE', targetId: existing.id, targetUserId: existing.userId ?? null, fill, warnings };
      if (Object.keys(fill).length === 0) {
        outcome = 'SKIPPED';
        counts.skippedCount += 1;
        message = `Already on the platform as ${nameOf(existing)}; nothing to add`;
      } else {
        outcome = 'MERGED';
        counts.mergedCount += 1;
        message = `Merges into ${nameOf(existing)}: fills ${Object.keys(fill).join(', ')}`;
      }
      if (warnings.length) message = `${message}. ${warnings.join('. ')}`;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, targetId: existing.id, message });
      continue;
    }

    plan = { action: 'CREATE', warnings };
    counts.createdCount += 1;
    // A WARNING row still creates; it is counted on its own as well.
    if (warnings.length) counts.warningCount += 1;
    outcome = warnings.length ? 'WARNING' : 'CREATED';
    message = warnings.length ? `Will create; ${warnings.join('. ')}` : `Will create as a pending ${adapter.noun}`;
    if (note) message = `${message}; ${note}`;
    rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, targetId: null, message });
  }

  const created = await repository.createImport({
    party: adapter.party,
    fileName: input.fileName ?? `rows-${new Date().toISOString().slice(0, 10)}.json`,
    note: input.note ?? null,
    uploadedById: byUserId,
    rows,
    counts,
  });
  await logActivity(byUserId, 'PARTY_IMPORT_VALIDATED', {
    req,
    targetType: 'PartyImport',
    targetId: created.id,
    module: 'party-imports',
    metadata: { party: adapter.party, fileName: created.fileName, counts },
  });
  return withRowViews(created);
}

export const listImports = (key: ImportKey, query: ListImportsQuery) => repository.listImports(partyOf(key), query);

export async function getImport(key: ImportKey, id: string) {
  const found = await repository.findImport(partyOf(key), id);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Import not found');
  return withRowViews(found);
}

const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/**
 * The second step. Only a VALIDATED import commits, and only once: the plan
 * written at validation is what runs, row by row, in order.
 *
 * Per row, not one transaction — and deliberately so. The publisher's
 * importer writes its own rows and can wrap them in one `$transaction`; this
 * one must not: a party is created through its module's own service
 * (`registerAdvertiser`, `createAgent`, `createPartner`, `createUser` +
 * `createEmployee`), which runs on the shared client and mints identifiers
 * off an atomic counter — none of that can be handed a transaction client
 * without reopening four modules. So each row is its own unit, and the
 * marker makes it resumable: as a row lands, its result is written on the
 * row (`data.result`, `targetId`, `outcome`), and a commit that dies
 * half-way leaves the import VALIDATED with the finished rows stamped — the
 * next call skips them and carries on. A row the party's service refuses
 * (a 4xx of its own) is marked FAILED with the reason and the commit goes on;
 * an infrastructure error stops the commit where it is, to be resumed.
 */
export async function commitImport(key: PartyKey, id: string, byUserId: string, req?: Request) {
  const adapter = adapterFor(key);
  const found = await getImport(key, id);
  if (found.status !== 'VALIDATED') {
    throw new ApiError(409, 'CONFLICT', found.status === 'COMMITTED' ? 'This import has already been committed' : 'This import was revoked');
  }

  // The parties as they are NOW, in one read: validation and commit are two
  // requests, and a number that joined in between is merged into rather
  // than duplicated. No two actionable rows share a mobile (the later one
  // was SKIPPED at validation), so one read serves every row.
  const actionable = found.rows.filter((row) => {
    const data = row.data as RowData;
    return data.plan && (!data.result || data.result.action === 'FAILED');
  });
  const match = await adapter.match(actionable.map((row) => ({ ...(row.data as Record<string, string>), mobile: String((row.data as RowData)['mobile']) }) as ParsedRow));
  const mobileIndex = new Map(match.byMobile.map((party) => [party.mobile, party]));
  const now = new Date();
  /** This run's results by row id, on top of what earlier runs stamped. */
  const results = new Map<string, { result: RowResult; outcome: PartyImportOutcome }>();

  for (const row of actionable) {
    const data = row.data as RowData;
    const plan = data.plan!;
    const mobile = String(data['mobile']);
    const fields = fieldsOf(adapter, data);
    const ctx: CommitContext = { byUserId, req, importId: id, rowNumber: row.rowNumber };
    const current = mobileIndex.get(mobile);
    const stamp = async (result: RowResult, outcome: PartyImportOutcome | undefined, message: string | null | undefined) => {
      await repository.stampRow(row.id, { data: { ...data, result }, targetId: result.targetId, ...(outcome ? { outcome } : {}), ...(message !== undefined ? { message } : {}) });
      results.set(row.id, { result, outcome: outcome ?? row.outcome });
    };

    try {
      if (plan.action === 'MERGE' || current) {
        const target = current ?? null;
        if (!target) {
          // The party the merge was planned against is gone. Nothing to fill into.
          await stamp({ action: 'SKIPPED', targetId: null, at: now.toISOString() }, 'SKIPPED', `${adapter.noun} ${plan.action === 'MERGE' ? plan.targetId : mobile} is no longer on the platform; nothing done`);
          continue;
        }
        // Recomputed against the party as it is now: a column filled since
        // validation is not overwritten.
        const fill = blanksOf(adapter, target, plan.action === 'MERGE' ? plan.fill : fields);
        if (Object.keys(fill).length === 0) {
          const message = plan.action === 'CREATE' ? `Already on the platform as ${nameOf(target)} (joined after validation); nothing to add` : `Nothing left to fill on ${nameOf(target)}`;
          await stamp({ action: 'SKIPPED', targetId: target.id, targetUserId: target.userId ?? null, at: now.toISOString() }, 'SKIPPED', message);
          continue;
        }
        await adapter.merge(target, fill, ctx);
        const message = plan.action === 'CREATE' ? `Merged into ${nameOf(target)}: this number joined after validation; filled ${Object.keys(fill).join(', ')}` : undefined;
        await stamp({ action: 'MERGED', targetId: target.id, targetUserId: target.userId ?? null, at: now.toISOString() }, 'MERGED', message);
        continue;
      }

      const blocked = match.blockedMobiles.get(mobile);
      if (blocked) throw new ApiError(409, 'CONFLICT', blocked);
      const created = await adapter.create({ ...fields, mobile }, ctx);
      // A WARNING row keeps its outcome: the report still shows what ops were told.
      await stamp({ action: 'CREATED', targetId: created.id, targetUserId: created.userId ?? null, at: now.toISOString() }, row.outcome === 'WARNING' ? undefined : 'CREATED', undefined);
    } catch (err) {
      if (!isApiError(err)) throw err;
      await stamp({ action: 'FAILED', targetId: null, at: now.toISOString() }, 'INVALID', `Not ${plan.action === 'MERGE' ? 'merged' : 'created'}: ${err.message}`);
    }
  }

  // The counts as the commit left them: this run's results over the rows as they were read.
  const counts = { createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };
  for (const row of found.rows) {
    const landed = results.get(row.id);
    const result = landed?.result ?? (row.data as RowData).result;
    const outcome = landed?.outcome ?? row.outcome;
    if (result?.action === 'CREATED') {
      counts.createdCount += 1;
      if (outcome === 'WARNING') counts.warningCount += 1;
    } else if (result?.action === 'MERGED') counts.mergedCount += 1;
    else if (outcome === 'SKIPPED' || result?.action === 'SKIPPED') counts.skippedCount += 1;
    else if (outcome === 'INVALID' || result?.action === 'FAILED') counts.invalidCount += 1;
  }
  const committed = await repository.finishCommit(id, counts, now);
  await logActivity(byUserId, 'PARTY_IMPORT_COMMITTED', {
    req,
    targetType: 'PartyImport',
    targetId: id,
    module: 'party-imports',
    metadata: { party: adapter.party, fileName: committed.fileName, ...counts },
  });
  return withRowViews(committed);
}

/** Only an uncommitted import can be withdrawn; a committed one is history. */
export async function revokeImport(key: ImportKey, id: string, byUserId: string, req?: Request) {
  const party = partyOf(key);
  const found = await getImport(key, id);
  if (found.status !== 'VALIDATED') throw new ApiError(409, 'CONFLICT', 'Only an uncommitted import can be revoked');
  const revoked = await repository.setStatus(id, 'REVOKED');
  await logActivity(byUserId, 'PARTY_IMPORT_REVOKED', { req, targetType: 'PartyImport', targetId: id, module: 'party-imports', metadata: { party, ...(found.publisherId ? { publisherId: found.publisherId } : {}) } });
  return withRowViews(revoked);
}

/** The rows as ops read them: outcome and message first, then the party's columns. */
export async function importReportCsv(key: ImportKey, id: string): Promise<string> {
  const columns = columnsOf(key);
  const found = await getImport(key, id);
  const header = ['rowNumber', 'outcome', 'message', 'targetId', ...columns];
  const lines = found.rows.map((row) => {
    const data = row.data as Record<string, unknown>;
    return [row.rowNumber, row.outcome, row.message, row.targetId, ...columns.map((column) => (typeof data[column] === 'string' ? (data[column] as string) : ''))];
  });
  return formatCsv([header, ...lines]);
}
