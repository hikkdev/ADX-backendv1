import { logger } from '../logging';
import { authHeader, digioConfigured } from './digio-client';
import type { KycConfig } from './integration-config';

/**
 * DR-2 (23 Sep 2026): Digio as a second reader behind the document door.
 *
 * The vision model reads every kind of document. Digio's ID OCR reads the
 * identity papers it verifies — PAN, driving licence, passport, voter id —
 * on the account ADX already holds, with no model cost per read. This
 * adapter turns one call to Digio into the same `{ field: value }` shape
 * the model's reading is held to, so the desk cannot tell which read it.
 *
 * Digio's developer portal renders in the browser only, so the endpoint
 * and the answer's field names below are ADX's best reading of their KYC
 * OCR API and are held loosely: the path is configurable (`ocrPath` on the
 * KYC section, `DIGIO_OCR_PATH` in the environment), the answer is scanned
 * for the names Digio uses across its KYC products (`id_number`, `name`,
 * `dob`, `address`, `valid_till` …) rather than one fixed layout, and a
 * shape this adapter cannot read fails loudly with the answer logged, so
 * the first real call after enablement says exactly what to fix.
 */

export const DEFAULT_DIGIO_OCR_PATH = '/v2/client/kyc/ocr';

/** Digio's own names for the papers it reads; a kind not here goes to the model. */
export const DIGIO_ID_TYPES: Record<string, string> = {
  PAN: 'PAN',
  DRIVING_LICENCE: 'DL',
  PASSPORT: 'PASSPORT',
  VOTER_ID: 'VOTER_ID',
};

export const digioReadsKind = (kind: string): boolean => kind in DIGIO_ID_TYPES;

export type DigioOcrInput = {
  kind: string;
  /** The picture, base64 — a JPEG or PNG. A PDF is not sent to Digio. */
  image: { mimeType: string; base64: string };
};

export type DigioOcrResult = {
  /** Values by ADX's field key for the kind, only the ones Digio answered. */
  fields: Record<string, string>;
  /** Digio's whole answer, kept on the reading for the day the mapping proves wrong. */
  raw: unknown;
};

/** Where each of ADX's field keys may sit in Digio's answer, first match wins. */
const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  PAN: {
    number: ['id_number', 'pan', 'pan_number', 'number'],
    name: ['name', 'full_name', 'name_on_card'],
    fatherName: ['father_name', 'fathers_name', 'parent_name'],
    dateOfBirth: ['dob', 'date_of_birth'],
  },
  DRIVING_LICENCE: {
    number: ['id_number', 'dl_number', 'license_number', 'licence_number', 'number'],
    name: ['name', 'full_name'],
    dateOfBirth: ['dob', 'date_of_birth'],
    address: ['address', 'permanent_address'],
    validUntil: ['valid_till', 'valid_upto', 'validity', 'expiry_date', 'nt_validity', 'valid_to'],
    issuingAuthority: ['issuing_authority', 'rto', 'issued_by'],
  },
  PASSPORT: {
    number: ['id_number', 'passport_number', 'number'],
    name: ['name', 'full_name', 'given_name'],
    nationality: ['nationality', 'country_code'],
    dateOfBirth: ['dob', 'date_of_birth'],
    validUntil: ['expiry_date', 'date_of_expiry', 'valid_till', 'valid_upto'],
    placeOfIssue: ['place_of_issue', 'issued_at'],
  },
  VOTER_ID: {
    number: ['id_number', 'epic_number', 'epic_no', 'number'],
    name: ['name', 'full_name'],
    address: ['address'],
  },
};

/** Walks Digio's answer for a key, at the top or one or two levels down (`id_data`, `data`, `result`, `details`). */
function findValue(answer: unknown, keys: string[]): string | null {
  const layers: unknown[] = [answer];
  if (answer && typeof answer === 'object') {
    for (const inner of ['id_data', 'data', 'result', 'details', 'ocr_data', 'extracted_data']) {
      const value = (answer as Record<string, unknown>)[inner];
      if (value && typeof value === 'object') {
        layers.push(value);
        for (const deeper of ['id_data', 'data', 'details']) {
          const twice = (value as Record<string, unknown>)[deeper];
          if (twice && typeof twice === 'object') layers.push(twice);
        }
      }
    }
  }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const key of keys) {
      const value = (layer as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
  }
  return null;
}

/** DD/MM/YYYY and DD-MM-YYYY, as Digio prints dates, to ISO; anything already ISO passes through. */
export function digioDateToIso(value: string): string {
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(value.trim());
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  return value.trim();
}

const DATE_FIELDS = new Set(['dateOfBirth', 'validUntil']);

/** Digio's answer as ADX's fields for the kind. Throws when nothing recognisable came back. */
export function mapDigioAnswer(kind: string, answer: unknown): Record<string, string> {
  const aliases = FIELD_ALIASES[kind];
  if (!aliases) throw new Error(`Digio does not read ${kind}`);
  const fields: Record<string, string> = {};
  for (const [field, keys] of Object.entries(aliases)) {
    const value = findValue(answer, keys);
    if (value !== null) fields[field] = DATE_FIELDS.has(field) ? digioDateToIso(value) : value;
  }
  if (Object.keys(fields).length === 0) throw new Error('Digio answered in a shape this adapter does not recognise');
  return fields;
}

/**
 * One call to Digio's OCR. The request carries the id type and the picture
 * as base64 under the names Digio's KYC APIs use; the answer is mapped
 * loosely (see above). Network and non-2xx answers throw with the status.
 */
export async function digioReadDocument(cfg: KycConfig, input: DigioOcrInput): Promise<DigioOcrResult> {
  if (!digioConfigured(cfg) || !cfg.baseUrl) throw new Error('Digio is not configured');
  const idType = DIGIO_ID_TYPES[input.kind];
  if (!idType) throw new Error(`Digio does not read ${input.kind}`);
  const path = cfg.ocrPath || DEFAULT_DIGIO_OCR_PATH;
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
    body: JSON.stringify({
      id_type: idType,
      unique_request_id: `adx-ocr-${Date.now()}`,
      front_part: input.image.base64,
      front_part_mime_type: input.image.mimeType,
    }),
  });
  const text = await response.text();
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    /* kept as text; the mapper will refuse it with the body logged */
  }
  if (!response.ok) {
    logger.warn('Digio OCR refused the read', { status: response.status, body: text.slice(0, 500) });
    throw new Error(`Digio OCR answered ${response.status}`);
  }
  try {
    return { fields: mapDigioAnswer(input.kind, answer), raw: answer };
  } catch (cause) {
    logger.warn('Digio OCR answered in an unexpected shape', { body: text.slice(0, 500) });
    throw cause;
  }
}
