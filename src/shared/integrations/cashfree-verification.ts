import { env } from '../../config/env';
import { logger } from '../logging';

/**
 * Cashfree's Verification Suite — AG-4 (the owner, 20 Sep 2026): "for
 * vehicle verification and fetching details both for agents and publishers
 * putting their vehicle as ad spot", pointing at the vehicle-RC endpoint;
 * and the bank penny drop the payout rail has had a seam for since Lot B.
 *
 * Two calls, one shape of answer. `ok: true` carries the facts and the raw
 * payload (kept on the record, so a disputed check can be traced); `ok:
 * false` says why not — UNCONFIGURED (no client pair), REFUSED (Cashfree said
 * no: an unwhitelisted IP, a bad pair, a number it does not know), or
 * UNAVAILABLE (it did not answer in time). The caller decides what a refusal
 * means; nothing here throws.
 *
 *   Vehicle RC   GET  /verification/vehicle-rc?vehicle_number=KA01AB1234
 *   Bank         POST /verification/bank-account/sync { bank_account, ifsc, name }
 *
 * Headers x-client-id / x-client-secret. Test mode targets
 * sandbox.cashfree.com, live api.cashfree.com. Cashfree must whitelist the
 * server's IP before either answers (submitted 20 Sep 2026).
 */

export const CASHFREE_VERIFICATION_SANDBOX_HOST = 'https://sandbox.cashfree.com';
export const CASHFREE_VERIFICATION_LIVE_HOST = 'https://api.cashfree.com';
export const CASHFREE_VERIFICATION_TIMEOUT_MS = 10_000;

export type CashfreeVerificationConfig = { clientId?: string; clientSecret?: string; testMode: boolean };

export function getCashfreeVerificationConfig(): CashfreeVerificationConfig {
  const testModeRaw = env.CASHFREE_VERIFICATION_TEST_MODE ?? env.CASHFREE_PAYOUT_TEST_MODE ?? 'true';
  return {
    clientId: env.CASHFREE_VERIFICATION_CLIENT_ID ?? env.CASHFREE_PAYOUT_CLIENT_ID,
    clientSecret: env.CASHFREE_VERIFICATION_CLIENT_SECRET ?? env.CASHFREE_PAYOUT_CLIENT_SECRET,
    testMode: testModeRaw.toLowerCase() !== 'false',
  };
}

export function cashfreeVerificationConfigured(cfg = getCashfreeVerificationConfig()): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

export type VerificationFailure = { ok: false; code: 'UNCONFIGURED' | 'REFUSED' | 'UNAVAILABLE'; message: string; status?: number };

/** The registration certificate as Cashfree describes it, the fields ADX reads named plainly. */
export type VehicleRcFacts = {
  registrationNumber: string;
  ownerName: string | null;
  fatherName: string | null;
  presentAddress: string | null;
  vehicleClass: string | null;
  category: string | null;
  maker: string | null;
  model: string | null;
  fuelType: string | null;
  colour: string | null;
  registrationDate: string | null;
  registrationAuthority: string | null;
  rcExpiresAt: string | null;
  rcStatus: string | null;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
  insuranceValidUntil: string | null;
  fitnessValidUntil: string | null;
  pucValidUntil: string | null;
  financer: string | null;
  blacklisted: boolean | null;
  seatingCapacity: number | null;
  /** Cashfree's own status word: VALID, INVALID, … */
  status: string | null;
  referenceId: string | null;
};

export type VehicleRcAnswer = { ok: true; facts: VehicleRcFacts; raw: Record<string, unknown> } | VerificationFailure;

export type BankAccountFacts = {
  accountStatus: string | null;
  accountStatusCode: string | null;
  nameAtBank: string | null;
  bankName: string | null;
  branch: string | null;
  city: string | null;
  micr: string | null;
  utr: string | null;
  /** 0–100 as Cashfree scores it, null when it did not score. */
  nameMatchScore: number | null;
  nameMatchResult: string | null;
  referenceId: string | null;
  /** True when Cashfree says the account is live. */
  valid: boolean;
};

export type BankAccountAnswer = { ok: true; facts: BankAccountFacts; raw: Record<string, unknown> } | VerificationFailure;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const str = (raw: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
};
const num = (raw: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};
const bool = (raw: Record<string, unknown>, ...keys: string[]): boolean | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const word = value.trim().toUpperCase();
      if (word === 'YES' || word === 'TRUE' || word === 'BLACKLISTED') return true;
      if (word === 'NO' || word === 'FALSE' || word === 'NA' || word === 'NOT BLACKLISTED') return false;
    }
  }
  return null;
};

/** Cashfree's RC row → the facts ADX reads. Every field is optional on their side; nothing here assumes one. */
export function shapeVehicleRc(registrationNumber: string, raw: Record<string, unknown>): VehicleRcFacts {
  return {
    registrationNumber: str(raw, 'reg_no', 'vehicle_number', 'registration_number') ?? registrationNumber,
    ownerName: str(raw, 'owner', 'owner_name'),
    fatherName: str(raw, 'father_name', 'owner_father_name'),
    presentAddress: str(raw, 'present_address', 'current_address'),
    vehicleClass: str(raw, 'vehicle_class', 'class'),
    category: str(raw, 'vehicle_category', 'category'),
    maker: str(raw, 'manufacturer', 'maker_description', 'maker'),
    model: str(raw, 'vehicle_model', 'maker_model', 'model'),
    fuelType: str(raw, 'fuel_type', 'fuel'),
    colour: str(raw, 'color', 'colour'),
    registrationDate: str(raw, 'reg_date', 'registration_date'),
    registrationAuthority: str(raw, 'reg_authority', 'registration_authority', 'rto_name'),
    rcExpiresAt: str(raw, 'rc_expiry_date', 'reg_upto', 'registration_upto'),
    rcStatus: str(raw, 'rc_status', 'status_message'),
    insuranceCompany: str(raw, 'insurance_company', 'insurance_name'),
    insurancePolicyNumber: str(raw, 'insurance_policy_no', 'insurance_policy_number'),
    insuranceValidUntil: str(raw, 'insurance_upto', 'insurance_validity'),
    fitnessValidUntil: str(raw, 'fitness_upto', 'fit_upto'),
    pucValidUntil: str(raw, 'puc_upto', 'pucc_upto'),
    financer: str(raw, 'financer', 'financier'),
    blacklisted: bool(raw, 'blacklist_status', 'is_blacklisted'),
    seatingCapacity: num(raw, 'seating_capacity', 'seat_capacity'),
    status: str(raw, 'status'),
    referenceId: str(raw, 'reference_id', 'ref_id'),
  };
}

export function shapeBankAccount(raw: Record<string, unknown>): BankAccountFacts {
  const status = str(raw, 'account_status');
  return {
    accountStatus: status,
    accountStatusCode: str(raw, 'account_status_code'),
    nameAtBank: str(raw, 'name_at_bank', 'name_at_bank_account'),
    bankName: str(raw, 'bank_name', 'bank'),
    branch: str(raw, 'branch'),
    city: str(raw, 'city'),
    micr: str(raw, 'micr'),
    utr: str(raw, 'utr'),
    nameMatchScore: num(raw, 'name_match_score'),
    nameMatchResult: str(raw, 'name_match_result'),
    referenceId: str(raw, 'reference_id', 'ref_id'),
    valid: (status ?? '').toUpperCase() === 'VALID',
  };
}

async function call(
  path: string,
  init: RequestInit,
  cfg: CashfreeVerificationConfig,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: true; body: Record<string, unknown> } | VerificationFailure> {
  if (!cashfreeVerificationConfigured(cfg)) {
    return { ok: false, code: 'UNCONFIGURED', message: 'Cashfree verification is not configured; check by hand.' };
  }
  const host = cfg.testMode ? CASHFREE_VERIFICATION_SANDBOX_HOST : CASHFREE_VERIFICATION_LIVE_HOST;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${host}${path}`, {
      ...init,
      headers: { 'x-client-id': cfg.clientId!, 'x-client-secret': cfg.clientSecret!, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const message = str(body, 'message', 'error', 'error_description') ?? `Cashfree answered ${response.status}`;
      logger.warn('Cashfree verification refused', { path, status: response.status, message });
      return { ok: false, code: 'REFUSED', status: response.status, message };
    }
    return { ok: true, body };
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? `Cashfree did not answer in ${timeoutMs / 1000}s` : err instanceof Error ? err.message : String(err);
    logger.warn('Cashfree verification unavailable', { path, message });
    return { ok: false, code: 'UNAVAILABLE', message };
  } finally {
    clearTimeout(timer);
  }
}

export const VEHICLE_NUMBER_PATTERN = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/;

/** "ka 01 ab-1234" → "KA01AB1234". */
export const normaliseVehicleNumber = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function lookupVehicleRc(
  vehicleNumber: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  cfg: CashfreeVerificationConfig = getCashfreeVerificationConfig(),
  timeoutMs = CASHFREE_VERIFICATION_TIMEOUT_MS,
): Promise<VehicleRcAnswer> {
  const number = normaliseVehicleNumber(vehicleNumber);
  const answer = await call(`/verification/vehicle-rc?vehicle_number=${encodeURIComponent(number)}`, { method: 'GET' }, cfg, fetchImpl, timeoutMs);
  if (!answer.ok) return answer;
  return { ok: true, facts: shapeVehicleRc(number, answer.body), raw: answer.body };
}

export async function verifyBankAccount(
  input: { accountNumber: string; ifsc: string; name?: string | null; phone?: string | null },
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  cfg: CashfreeVerificationConfig = getCashfreeVerificationConfig(),
  timeoutMs = CASHFREE_VERIFICATION_TIMEOUT_MS,
): Promise<BankAccountAnswer> {
  const body: Record<string, string> = { bank_account: input.accountNumber.replace(/\s+/g, ''), ifsc: input.ifsc.trim().toUpperCase() };
  if (input.name?.trim()) body['name'] = input.name.trim();
  if (input.phone?.trim()) body['phone'] = input.phone.replace(/[^0-9]/g, '').slice(-10);
  const answer = await call('/verification/bank-account/sync', { method: 'POST', body: JSON.stringify(body) }, cfg, fetchImpl, timeoutMs);
  if (!answer.ok) return answer;
  return { ok: true, facts: shapeBankAccount(answer.body), raw: answer.body };
}

/**
 * How closely two names agree, 0–100 — the owner on an RC against the
 * applicant, when Cashfree gives no score of its own. Token overlap, case
 * and punctuation ignored, initials matched to the word they start.
 */
export function nameMatchScore(a: string | null | undefined, b: string | null | undefined): number | null {
  const tokens = (value: string) => value.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!a?.trim() || !b?.trim()) return null;
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return null;
  const matches = (x: string, y: string) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));
  const hit = left.filter((token) => right.some((other) => matches(token, other))).length;
  return Math.round((hit / Math.max(left.length, right.length)) * 100);
}
