import {
  findActivity,
  findActivityRows,
  type ActivityFilter,
  type ActivityPage,
  type ActivityRow,
  type ActivitySort,
} from '../../shared/audit';

/** The export walks the same query a slice at a time and stops here regardless of the filter. */
export const EXPORT_ROW_CAP = 50_000;
export const EXPORT_BATCH = 1_000;

export const CSV_COLUMNS = [
  'id',
  'createdAt',
  'userId',
  'actorName',
  'actorEmail',
  'action',
  'module',
  'targetType',
  'targetId',
  'requestId',
  'ipAddress',
  'metadata',
  'diff',
] as const;

export async function listAudit(filter: ActivityFilter, page: ActivityPage) {
  return findActivity(filter, page);
}

/** The timeline for one record — every row that named it. */
export async function targetTimeline(target: { targetType: string; targetId: string }, page: ActivityPage) {
  return findActivity({ targetType: target.targetType, targetId: target.targetId }, page);
}

/**
 * Rows for the export, in batches, never more than the cap. An async
 * generator so the controller can stream each batch as it arrives rather than
 * holding fifty thousand rows in memory before the first byte leaves.
 */
export async function* iterateAuditRows(
  filter: ActivityFilter,
  sort: ActivitySort,
  cap = EXPORT_ROW_CAP,
): AsyncGenerator<ActivityRow[], void, void> {
  let skip = 0;
  while (skip < cap) {
    const take = Math.min(EXPORT_BATCH, cap - skip);
    const rows = await findActivityRows(filter, { skip, take, sort });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < take) return;
    skip += rows.length;
  }
}

/** RFC 4180: quote when needed, double the quotes inside. Never a bare newline. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`;
}

export function csvLine(row: ActivityRow): string {
  const cells = [
    row.id,
    row.createdAt,
    row.userId,
    row.user?.name ?? '',
    row.user?.email ?? '',
    row.action,
    row.module,
    row.targetType,
    row.targetId,
    row.requestId,
    row.ipAddress,
    row.metadata,
    row.diff,
  ];
  return `${cells.map(csvCell).join(',')}\r\n`;
}
