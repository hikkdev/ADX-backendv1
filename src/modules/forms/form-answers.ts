import { LISTING_CATEGORIES } from '../listings';
import { FIELD_KIND_META, flattenFields, type FormDefinition, type FormField } from './form-schema';

/**
 * FM-1 (27 Sep 2026): an answer set, checked against the version it answers.
 *
 * Pure: the definition in, the raw `{ [fieldId]: value }` in, the clean
 * answers and every problem out. A field whose condition is not met is
 * dropped, not refused; an answer to a field the form does not have is
 * dropped too. What needs the database — a city id that must exist — is the
 * service's, after this passes.
 */

export type AnswerIssue = { fieldId: string; message: string };
export type Answers = Record<string, unknown>;
/** `city` is the name the phone's or the site's geocoder gave; the service resolves it to `cityId` when the catalogue knows it. */
export type LocationAnswer = { latitude: number; longitude: number; address?: string; cityId?: string; city?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_REF = /^(https?:\/\/\S+|\/files\/[A-Za-z0-9_-]+)$/;

/** One file answer as a reference: the string itself, or an upload record's `url` (else `/files/<fileId>`). */
function fileRefOf(item: unknown): string | null {
  if (typeof item === 'string') return item.length <= 500 && FILE_REF.test(item) ? item : null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (typeof record['url'] === 'string') return fileRefOf(record['url']);
  if (typeof record['fileId'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(record['fileId'])) return `/files/${record['fileId']}`;
  return null;
}
const DEFAULT_TEXT = 500;
const DEFAULT_TEXTAREA = 4000;
const MAX_FILES = 5;

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** The digits, with the leading plus kept — enough to say whether it is a number at all; the lead door normalises properly. */
export function cleanPhone(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return (trimmed.startsWith('+') ? '+' : '') + digits;
}

type Cleaned = { value: unknown } | { error: string };

function clean(field: FormField, raw: unknown): Cleaned {
  const label = field.label;
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return { error: `${label} must be text` };
      const limit = field.maxLength ?? (field.kind === 'text' ? DEFAULT_TEXT : DEFAULT_TEXTAREA);
      const value = raw.trim();
      return value.length > limit ? { error: `${label} is longer than ${limit} characters` } : { value };
    }
    case 'email': {
      if (typeof raw !== 'string') return { error: `${label} must be an email address` };
      const value = raw.trim().toLowerCase();
      return value.length <= 160 && EMAIL.test(value) ? { value } : { error: `${label} is not an email address` };
    }
    case 'phone': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} must be a phone number` };
      const value = cleanPhone(String(raw));
      return value ? { value } : { error: `${label} is not a phone number` };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(value)) return { error: `${label} must be a number` };
      if (typeof field.min === 'number' && value < field.min) return { error: `${label} must be at least ${field.min}` };
      if (typeof field.max === 'number' && value > field.max) return { error: `${label} must be at most ${field.max}` };
      return { value };
    }
    case 'select': {
      if (typeof raw !== 'string') return { error: `${label} must be one choice` };
      return field.options?.some((option) => option.value === raw) ? { value: raw } : { error: `${label}: "${raw}" is not one of the choices` };
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
      if (!list || !list.every((item) => typeof item === 'string')) return { error: `${label} must be a list of choices` };
      const values = [...new Set(list as string[])];
      const bad = values.find((item) => !field.options?.some((option) => option.value === item));
      if (bad !== undefined) return { error: `${label}: "${bad}" is not one of the choices` };
      if (typeof field.min === 'number' && values.length < field.min) return { error: `${label}: choose at least ${field.min}` };
      if (typeof field.max === 'number' && values.length > field.max) return { error: `${label}: choose at most ${field.max}` };
      return { value: values };
    }
    case 'checkbox': {
      const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
      if (value === null) return { error: `${label} must be ticked or not` };
      if (field.required && !value) return { error: `${label} must be ticked` };
      return { value };
    }
    case 'date': {
      if (typeof raw !== 'string' || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(raw))) return { error: `${label} must be a date (YYYY-MM-DD)` };
      if (typeof field.min === 'string' && raw < field.min) return { error: `${label} must be on or after ${field.min}` };
      if (typeof field.max === 'string' && raw > field.max) return { error: `${label} must be on or before ${field.max}` };
      return { value: raw };
    }
    case 'city': {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) return { error: `${label} must be a city from the list` };
      return { value: raw.trim() };
    }
    case 'category': {
      const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      return (LISTING_CATEGORIES as readonly string[]).includes(value) ? { value } : { error: `${label} is one of ${LISTING_CATEGORIES.join(', ')}` };
    }
    case 'location': {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `${label} must be a point on the map` };
      const point = raw as Record<string, unknown>;
      const latitude = Number(point['latitude']);
      const longitude = Number(point['longitude']);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return { error: `${label} needs a latitude and a longitude` };
      }
      const value: LocationAnswer = { latitude, longitude };
      if (typeof point['address'] === 'string' && point['address'].trim()) value.address = point['address'].trim().slice(0, 300);
      if (typeof point['cityId'] === 'string' && point['cityId'].trim()) value.cityId = point['cityId'].trim().slice(0, 64);
      // The apps and the website send the city's NAME beside the point (their geocoders give names, not ids).
      if (typeof point['city'] === 'string' && point['city'].trim()) value.city = point['city'].trim().slice(0, 64);
      return { value };
    }
    case 'file': {
      // A reference as a string, or the record `POST /upload` answers (`{ fileId, url, name, … }`) as the apps and the site send it.
      const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? null : [raw];
      const refs = list?.map(fileRefOf);
      if (!refs || refs.some((item) => item === null)) return { error: `${label} must be an uploaded file` };
      if (refs.length > MAX_FILES) return { error: `${label} takes at most ${MAX_FILES} files` };
      return { value: [...new Set(refs as string[])] };
    }
    default:
      return { error: `${label} is a kind this build cannot read` };
  }
}

/** What a condition compares against: a tick box reads "true"/"false", a list matches any of its choices. */
function conditionMet(field: FormField, answers: Answers): boolean {
  if (!field.dependsOn) return true;
  const value = answers[field.dependsOn.fieldId];
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.includes(field.dependsOn.equals);
  return String(value) === field.dependsOn.equals;
}

/** The clean answers and every problem at once. Inactive and unknown fields are dropped silently. */
export function validateAnswers(definition: FormDefinition, raw: Answers): { answers: Answers; issues: AnswerIssue[] } {
  const answers: Answers = {};
  const issues: AnswerIssue[] = [];
  for (const field of flattenFields(definition)) {
    if (!conditionMet(field, answers)) continue;
    const value = raw[field.id];
    if (isEmpty(value)) {
      if (field.required) issues.push({ fieldId: field.id, message: `${field.label} is required` });
      continue;
    }
    const cleaned = clean(field, value);
    if ('error' in cleaned) issues.push({ fieldId: field.id, message: cleaned.error });
    else answers[field.id] = cleaned.value;
  }
  return { answers, issues };
}

/* ── What the columns take ─────────────────────────────────────────── */

export type Contacts = { contactName: string | null; contactEmail: string | null; contactPhone: string | null };

/** The contact map's fields, else the first email / phone field answered; a name only when the map names one. */
export function liftContacts(definition: FormDefinition, answers: Answers): Contacts {
  const fields = flattenFields(definition);
  const text = (id: string | undefined): string | null => (id && typeof answers[id] === 'string' && (answers[id] as string).trim() ? (answers[id] as string).trim() : null);
  const first = (kind: FormField['kind']): string | null => {
    const field = fields.find((candidate) => candidate.kind === kind && typeof answers[candidate.id] === 'string');
    return field ? (answers[field.id] as string) : null;
  };
  return {
    contactName: text(definition.contactMap?.name)?.slice(0, 120) ?? null,
    contactEmail: text(definition.contactMap?.email) ?? first('email'),
    contactPhone: text(definition.contactMap?.phone) ?? first('phone'),
  };
}

export type Place = { latitude: number | null; longitude: number | null; address: string | null; cityId: string | null };

/** The first location answered, else the first city; nothing when neither was asked. */
export function liftPlace(definition: FormDefinition, answers: Answers): Place {
  const fields = flattenFields(definition);
  const location = fields.find((field) => field.kind === 'location' && answers[field.id] !== undefined);
  if (location) {
    const point = answers[location.id] as LocationAnswer;
    return { latitude: point.latitude, longitude: point.longitude, address: point.address ?? null, cityId: point.cityId ?? null };
  }
  const city = fields.find((field) => field.kind === 'city' && typeof answers[field.id] === 'string');
  return { latitude: null, longitude: null, address: null, cityId: city ? (answers[city.id] as string) : null };
}

/** The city ids an answer set names — the ones the service must find in the catalogue. */
export function cityIdsIn(definition: FormDefinition, answers: Answers): { fieldId: string; cityId: string }[] {
  const out: { fieldId: string; cityId: string }[] = [];
  for (const field of flattenFields(definition)) {
    const value = answers[field.id];
    if (field.kind === 'city' && typeof value === 'string') out.push({ fieldId: field.id, cityId: value });
    if (field.kind === 'location' && value && typeof (value as LocationAnswer).cityId === 'string') out.push({ fieldId: field.id, cityId: (value as LocationAnswer).cityId! });
    else if (field.kind === 'location' && value && typeof (value as LocationAnswer).city === 'string') out.push({ fieldId: field.id, cityId: (value as LocationAnswer).city! });
  }
  return out;
}

/**
 * A city answered by id or by NAME (the site's and the apps' pickers give names)
 * becomes the catalogue's id: `city` answers are rewritten to the id, a
 * location gains `cityId`; what the lookup does not know is one issue each.
 * Pure — the lookup is the catalogue rows the service fetched for the
 * candidates `cityIdsIn` named.
 */
export function resolveCityAnswers(
  definition: FormDefinition,
  answers: Answers,
  lookup: (value: string) => { id: string; name: string } | null,
): { issues: AnswerIssue[]; cityNames: Map<string, string> } {
  const issues: AnswerIssue[] = [];
  const cityNames = new Map<string, string>();
  for (const field of flattenFields(definition)) {
    const value = answers[field.id];
    if (field.kind === 'city' && typeof value === 'string') {
      const city = lookup(value);
      if (!city) issues.push({ fieldId: field.id, message: 'That city is not in the catalogue' });
      else {
        answers[field.id] = city.id;
        cityNames.set(city.id, city.name);
      }
    }
    if (field.kind === 'location' && value && typeof value === 'object') {
      const point = value as LocationAnswer;
      const candidate = point.cityId ?? point.city;
      if (!candidate) continue;
      const city = lookup(candidate);
      if (!city) {
        // A named city the catalogue lacks is kept as a name — the point still stands; an unknown ID is refused.
        if (point.cityId) issues.push({ fieldId: field.id, message: 'That city is not in the catalogue' });
        continue;
      }
      point.cityId = city.id;
      cityNames.set(city.id, city.name);
    }
  }
  return { issues, cityNames };
}

/** The file references an answer set carries — for a ticket's attachments. */
export function fileRefsIn(definition: FormDefinition, answers: Answers): string[] {
  return flattenFields(definition)
    .filter((field) => field.kind === 'file' && Array.isArray(answers[field.id]))
    .flatMap((field) => answers[field.id] as string[]);
}

/** One answer as a person reads it: the option's label, Yes/No, the address or the point, the files' count. */
export function formatAnswer(field: FormField, value: unknown, cityNames: ReadonlyMap<string, string> = new Map()): string {
  if (value === undefined || value === null) return '';
  switch (field.kind) {
    case 'select':
      return field.options?.find((option) => option.value === value)?.label ?? String(value);
    case 'multiselect':
      return (Array.isArray(value) ? value : [value]).map((item) => field.options?.find((option) => option.value === item)?.label ?? String(item)).join(', ');
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'city':
      return cityNames.get(String(value)) ?? String(value);
    case 'location': {
      const point = value as LocationAnswer;
      return point.address ? `${point.address} (${point.latitude}, ${point.longitude})` : `${point.latitude}, ${point.longitude}`;
    }
    case 'file':
      return (Array.isArray(value) ? value : [value]).join(' ');
    default:
      return String(value);
  }
}

/** "Label: value" per answered field, in the order asked — the lead's message and the ticket's body. */
export function answerLines(definition: FormDefinition, answers: Answers, cityNames?: ReadonlyMap<string, string>): string[] {
  return flattenFields(definition)
    .filter((field) => answers[field.id] !== undefined)
    .map((field) => `${field.label}: ${formatAnswer(field, answers[field.id], cityNames)}`);
}

export const kindLabel = (field: FormField): string => FIELD_KIND_META[field.kind].label;
