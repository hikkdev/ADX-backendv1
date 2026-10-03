import { FIELD_KEY, type CustomFieldKind } from './custom-fields.schema';

/**
 * CF-1 (27 Sep 2026): a value, checked against its definition. Pure: the
 * definition's kind and options in, the clean value or one sentence out.
 * `null` is the clear — the caller deletes the row.
 */

export type ValueDef = { key: string; label: string; kind: string; options: unknown; required: boolean };
export type LocationValue = { latitude: number; longitude: number; address?: string; cityId?: string };
export type Checked = { ok: true; value: unknown } | { ok: false; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL = /^https?:\/\/\S+$/i;

export const optionsOf = (def: Pick<ValueDef, 'options'>): { value: string; label: string }[] =>
  Array.isArray(def.options) ? (def.options as { value?: unknown; label?: unknown }[]).filter((o) => typeof o.value === 'string').map((o) => ({ value: o.value as string, label: typeof o.label === 'string' ? o.label : (o.value as string) })) : [];

/** `Preferred contact time` → `preferred_contact_time`. */
export function keyFromLabel(label: string): string {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40).replace(/_+$/g, '');
}

export const isValidKey = (key: string): boolean => FIELD_KEY.test(key);

export function checkValue(def: ValueDef, raw: unknown): Checked {
  const label = def.label;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0)) {
    return def.required ? { ok: false, message: `${label} is required` } : { ok: true, value: null };
  }
  switch (def.kind as CustomFieldKind) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: `${label} must be text` };
      const value = raw.trim();
      return value.length <= 500 ? { ok: true, value } : { ok: false, message: `${label} is longer than 500 characters` };
    }
    case 'textarea': {
      if (typeof raw !== 'string') return { ok: false, message: `${label} must be text` };
      const value = raw.trim();
      return value.length <= 4000 ? { ok: true, value } : { ok: false, message: `${label} is longer than 4000 characters` };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: `${label} must be a number` };
    }
    case 'select': {
      if (typeof raw !== 'string') return { ok: false, message: `${label} must be one choice` };
      return optionsOf(def).some((option) => option.value === raw) ? { ok: true, value: raw } : { ok: false, message: `${label}: "${raw}" is not one of the choices` };
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
      if (!list || !list.every((item) => typeof item === 'string')) return { ok: false, message: `${label} must be a list of choices` };
      const values = [...new Set(list as string[])];
      const options = optionsOf(def);
      const bad = values.find((item) => !options.some((option) => option.value === item));
      return bad === undefined ? { ok: true, value: values } : { ok: false, message: `${label}: "${bad}" is not one of the choices` };
    }
    case 'checkbox': {
      const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
      if (value === null) return { ok: false, message: `${label} must be ticked or not` };
      return { ok: true, value };
    }
    case 'date':
      return typeof raw === 'string' && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? { ok: true, value: raw } : { ok: false, message: `${label} must be a date (YYYY-MM-DD)` };
    case 'email': {
      if (typeof raw !== 'string') return { ok: false, message: `${label} must be an email address` };
      const value = raw.trim().toLowerCase();
      return value.length <= 160 && EMAIL.test(value) ? { ok: true, value } : { ok: false, message: `${label} is not an email address` };
    }
    case 'phone': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, message: `${label} must be a phone number` };
      const trimmed = String(raw).trim();
      const digits = trimmed.replace(/[^\d]/g, '');
      if (digits.length < 8 || digits.length > 15) return { ok: false, message: `${label} is not a phone number` };
      return { ok: true, value: (trimmed.startsWith('+') ? '+' : '') + digits };
    }
    case 'url': {
      if (typeof raw !== 'string') return { ok: false, message: `${label} must be a web address` };
      const value = raw.trim();
      return value.length <= 500 && URL.test(value) ? { ok: true, value } : { ok: false, message: `${label} must start with http:// or https://` };
    }
    case 'location': {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: `${label} must be a point on the map` };
      const point = raw as Record<string, unknown>;
      const latitude = Number(point['latitude']);
      const longitude = Number(point['longitude']);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return { ok: false, message: `${label} needs a latitude and a longitude` };
      }
      const value: LocationValue = { latitude, longitude };
      if (typeof point['address'] === 'string' && point['address'].trim()) value.address = point['address'].trim().slice(0, 300);
      if (typeof point['cityId'] === 'string' && point['cityId'].trim()) value.cityId = point['cityId'].trim().slice(0, 64);
      return { ok: true, value };
    }
    default:
      return { ok: false, message: `${label} is a kind this build cannot read` };
  }
}
