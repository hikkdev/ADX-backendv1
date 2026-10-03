/**
 * What Cashfree's rows are read into — the facts ADX uses, named plainly.
 *
 * Moved here from `shared/integrations/cashfree-verification.ts` (AG-4) when
 * the two calls it made grew into the Secure ID provider; that file
 * re-exports everything below, so nothing that imported from it changed.
 * Pure: no configuration, no network.
 */

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

export const str = (raw: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
};
export const num = (raw: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};
export const bool = (raw: Record<string, unknown>, ...keys: string[]): boolean | null => {
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
export const obj = (raw: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = raw[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

/**
 * Cashfree's RC row → the facts ADX reads. Every field is optional on their
 * side; nothing here assumes one. The first name in each list is the one in
 * the Secure ID reference (`POST /vehicle-rc`, 1 Oct 2026); the rest are
 * the spellings the first cut read, kept so an older stored row still shapes.
 */
export function shapeVehicleRc(registrationNumber: string, raw: Record<string, unknown>): VehicleRcFacts {
  return {
    registrationNumber: str(raw, 'reg_no', 'vehicle_number', 'registration_number') ?? registrationNumber,
    ownerName: str(raw, 'owner', 'owner_name'),
    fatherName: str(raw, 'owner_father_name', 'father_name'),
    presentAddress: str(raw, 'present_address', 'current_address'),
    vehicleClass: str(raw, 'class', 'vehicle_class'),
    category: str(raw, 'vehicle_category', 'category'),
    maker: str(raw, 'vehicle_manufacturer_name', 'manufacturer', 'maker_description', 'maker'),
    model: str(raw, 'model', 'vehicle_model', 'maker_model'),
    fuelType: str(raw, 'type', 'fuel_type', 'fuel'),
    colour: str(raw, 'vehicle_colour', 'vehicle_color', 'color', 'colour'),
    registrationDate: str(raw, 'reg_date', 'registration_date'),
    registrationAuthority: str(raw, 'reg_authority', 'registration_authority', 'rto_name'),
    rcExpiresAt: str(raw, 'rc_expiry_date', 'reg_upto', 'registration_upto'),
    rcStatus: str(raw, 'rc_status', 'status_message'),
    insuranceCompany: str(raw, 'vehicle_insurance_company_name', 'insurance_company', 'insurance_name'),
    insurancePolicyNumber: str(raw, 'vehicle_insurance_policy_number', 'insurance_policy_no', 'insurance_policy_number'),
    insuranceValidUntil: str(raw, 'vehicle_insurance_upto', 'insurance_upto', 'insurance_validity'),
    fitnessValidUntil: str(raw, 'fitness_upto', 'fit_upto'),
    pucValidUntil: str(raw, 'pucc_upto', 'puc_upto'),
    financer: str(raw, 'rc_financer', 'financer', 'financier'),
    blacklisted: bool(raw, 'blacklist_status', 'is_blacklisted'),
    seatingCapacity: num(raw, 'vehicle_seat_capacity', 'seating_capacity', 'seat_capacity'),
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

export const VEHICLE_NUMBER_PATTERN = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/;

/** "ka 01 ab-1234" → "KA01AB1234". */
export const normaliseVehicleNumber = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

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
