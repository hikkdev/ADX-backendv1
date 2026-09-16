import type { AuditDiff } from './activity-log';

/**
 * Field names that never appear in the audit log in the clear. The log is
 * readable by every admin; a rotation is an event worth recording without the
 * log becoming the place the values live.
 */
export const SECRET_FIELD = /secret|password|token|hash|otp/i;
export const REDACTED = '[REDACTED]';

/** decimal.js instances — Prisma's Decimal — without importing the ORM to say so. */
function isDecimalLike(value: unknown): value is { toString(): string; toFixed(): string; d: unknown; e: unknown; s: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'd' in value &&
    'e' in value &&
    's' in value &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function'
  );
}

/** A value as it will sit in the JSON column: Decimals as strings, Dates as ISO, absent as null. */
export function auditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (isDecimalLike(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(auditValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELD.test(key) ? REDACTED : auditValue(item);
    }
    return out;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `{ field: { before, after } }` for the fields that changed.
 *
 * Values are compared after normalisation, so `Decimal('5')` and
 * `Decimal('5.00')` are the same money and produce no entry. A field whose
 * key names a secret is still reported as changed — that is the event — but
 * both sides are masked. With no field list, every key on either side is
 * considered.
 */
export function auditDiff(
  before: object | null | undefined,
  after: object | null | undefined,
  fields?: readonly string[],
): AuditDiff {
  const left = (before ?? {}) as Record<string, unknown>;
  const right = (after ?? {}) as Record<string, unknown>;
  const keys = fields ?? Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  const diff: AuditDiff = {};
  for (const key of keys) {
    const was = auditValue(left[key]);
    const now = auditValue(right[key]);
    if (same(was, now)) continue;
    diff[key] = SECRET_FIELD.test(key) ? { before: REDACTED, after: REDACTED } : { before: was, after: now };
  }
  return diff;
}
