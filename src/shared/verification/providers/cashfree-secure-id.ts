import { getEffectiveSecureIdConfig } from '../../integrations/integration-config';
import {
  lastFour,
  upiConsentFresh,
  type CheckInputs,
  type CheckResult,
  type CheckType,
  type DigilockerDocument,
  type ErrorClass,
  type ImageInput,
} from '../checks';
import type { CheckContext, FetchLike, PendingAttempt, VerificationProvider } from '../provider';
import type { VerificationSettings } from '../settings';
import { secureIdCall, secureIdConfigured, type SecureIdAnswer, type SecureIdFailure, type SecureIdKeys, type SecureIdRequest } from './secure-id-http';
import { normaliseVehicleNumber, num, obj, shapeBankAccount, shapeVehicleRc, str, type BankAccountFacts, type VehicleRcFacts } from './secure-id-shapes';

/**
 * Cashfree Secure ID — Digio's automatic backup, and the provider of every
 * single check (Cashfree Phase 1; the owner, 1 Oct 2026).
 *
 * Grown from `shared/integrations/cashfree-verification.ts` (AG-4), which
 * made two calls and now re-exports thin wrappers over this file. It keeps
 * that file's style: NOTHING here throws for something Cashfree did. Every
 * check answers a `CheckResult`; a result that is FAILED says, in
 * `errorClass`, whether Cashfree answered (BUSINESS — final) or could not
 * (a technical class — the router moves on).
 *
 * Coded only from the verified reference of 1 Oct 2026:
 *
 *   PAN              POST /pan                       { pan, name? }
 *   BANK_ACCOUNT     POST /bank-account/sync         { bank_account, ifsc, name?, phone? }
 *                    POST /bank-account/async        … + user_id, read back with GET /bank-account?reference_id=
 *   GSTIN            POST /gstin                     { GSTIN, business_name? }      (upper-case key)
 *   VEHICLE_RC       POST /vehicle-rc                { verification_id, vehicle_number }
 *   DRIVING_LICENCE  POST /driving-license           { verification_id, dl_number, dob }
 *   FACE_LIVENESS    POST /face-liveness (multipart) verification_id, image
 *   FACE_MATCH       POST /face-match    (multipart) verification_id, first_image, second_image, threshold?
 *   NAME_MATCH       POST /name-match                { verification_id, name_1, name_2 }   score 0–1 → 0–100
 *   DIGILOCKER       POST /digilocker, GET /digilocker, GET /digilocker/document/{AADHAAR|PAN}
 *   UPI_VPA          POST /upi/penny-drop  or  POST /reverse-penny-drop + GET /remitter/status
 *                    — off (not a capability) while `verificationRouting.upiCheck` is NONE; under
 *                    VPA_LOOKUP it is Digio's backup, the penny drop, asked only with fresh consent
 *   HOSTED_KYC       no call of its own: Cashfree's hosted journey is a session of the checks above
 *
 * What is KEPT of an answer (`raw`) is cut down here, before it leaves:
 * numbers masked to their last four, no address, no photograph, no XML
 * link. Aadhaar is never stored (the standing owner rule): of a DigiLocker
 * Aadhaar the attempt keeps the name, the year of birth, the last four and
 * the status. The photograph is handed to the face match in memory
 * (`digilockerDocument`) and to nothing else.
 */

const NAME = 'CASHFREE_SECURE_ID' as const;

const ALWAYS: readonly CheckType[] = ['PAN', 'BANK_ACCOUNT', 'GSTIN', 'VEHICLE_RC', 'DRIVING_LICENCE', 'FACE_LIVENESS', 'FACE_MATCH', 'NAME_MATCH', 'DIGILOCKER', 'HOSTED_KYC'];

export function secureIdCapabilities(settings: VerificationSettings): CheckType[] {
  return settings.upiCheck === 'NONE' ? [...ALWAYS] : [...ALWAYS, 'UPI_VPA'];
}

/** What a caller that keeps its own record of a check may read in memory — never written by the router. */
export type VehicleRcTransient = { facts: VehicleRcFacts; raw: Record<string, unknown> };
export type BankAccountTransient = { facts: BankAccountFacts; raw: Record<string, unknown> };
export type ReversePennyDropTransient = { links: Record<string, string>; qrCode: string | null };

type Call = (request: Omit<SecureIdRequest, 'verificationId'>) => Promise<SecureIdAnswer>;

/** The keys in force and the call bound to them — read once per check. */
async function wire(ctx: CheckContext, keysOverride?: SecureIdKeys): Promise<{ keys: SecureIdKeys; call: Call }> {
  const keys = keysOverride ?? (await getEffectiveSecureIdConfig());
  const call: Call = (request) => secureIdCall({ ...request, verificationId: ctx.verificationId }, keys, ctx.fetchImpl, ctx.now);
  return { keys, call };
}

/** Cashfree's id for the call: `reference_id` on most endpoints, `ref_id` on face match and reverse penny drop. */
const refOf = (body: Record<string, unknown>): string | null => str(body, 'reference_id', 'ref_id') ?? str(obj(body, 'error'), 'reference_id', 'ref_id', 'refId');

function failure(ctx: CheckContext, answer: SecureIdFailure): CheckResult {
  return {
    status: 'FAILED',
    provider: NAME,
    providerRef: refOf(answer.body),
    verificationId: ctx.verificationId,
    errorClass: answer.errorClass,
    failureCode: answer.code ?? (answer.status ? `HTTP_${answer.status}` : 'NO_ANSWER'),
    failureReason: answer.message.slice(0, 200),
    raw: { httpStatus: answer.status, code: answer.code },
  };
}

function refused(ctx: CheckContext, body: Record<string, unknown>, failureCode: string, failureReason: string, raw: Record<string, unknown>, extras: Partial<CheckResult> = {}): CheckResult {
  return { status: 'FAILED', provider: NAME, providerRef: refOf(body), verificationId: ctx.verificationId, errorClass: 'BUSINESS', failureCode, failureReason, raw, ...extras };
}

function passed(ctx: CheckContext, body: Record<string, unknown>, raw: Record<string, unknown>, extras: Partial<CheckResult> = {}): CheckResult {
  return { status: 'VERIFIED', provider: NAME, providerRef: refOf(body), verificationId: ctx.verificationId, raw, ...extras };
}

/** A score Cashfree gave on its 0–100 scale (a string on PAN and bank answers; `-` when it gave none). */
const score100 = (body: Record<string, unknown>, key: string): number | undefined => {
  const value = num(body, key);
  return value === null ? undefined : Math.max(0, Math.min(100, value));
};

const upper = (value: string): string => value.trim().toUpperCase();

/* ── PAN ───────────────────────────────────────────────────────── */

async function pan(input: CheckInputs['PAN'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const number = upper(input.pan);
  const answer = await call({ check: 'PAN', method: 'POST', path: '/pan', json: { pan: number, ...(input.name?.trim() ? { name: input.name.trim() } : {}) } });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  // The business example in Cashfree's own docs misspells the field; both are read.
  const registeredName = str(body, 'registered_name', 'registered_nam') ?? undefined;
  const raw = {
    pan: lastFour(number),
    valid: body['valid'] === true,
    type: str(body, 'type'),
    panStatus: str(body, 'pan_status'),
    registeredName: registeredName ?? null,
    nameMatchResult: str(body, 'name_match_result'),
    aadhaarSeedingStatus: str(body, 'aadhaar_seeding_status'),
    referenceId: refOf(body),
  };
  const extras = { matchedName: registeredName, nameMatchScore: score100(body, 'name_match_score') };
  if (body['valid'] !== true) return refused(ctx, body, `PAN_${str(body, 'pan_status') ?? 'INVALID'}`, str(body, 'message') ?? 'Invalid PAN', raw, extras);
  return passed(ctx, body, raw, extras);
}

/* ── bank account ──────────────────────────────────────────────── */

/** `account_status_code`s under FAILED / REJECTED that say the bank could not be reached, not that the account is bad. */
const BANK_SOURCE_DOWN = new Set(['FAILED_AT_BANK', 'IMPS_MODE_FAIL', 'CONNECTION_TIMEOUT', 'NPCI_UNAVAILABLE', 'SOURCE_BANK_DECLINED', 'BENEFICIARY_BANK_OFFLINE', 'VERIFICATION_ALREADY_UNDER_PROCESS']);
const BANK_IN_FLIGHT = new Set(['RECEIVED', 'IN_PROCESS', 'PROCESSING', 'APPROVAL_PENDING', 'PARTIALLY_APPROVED']);

function bankRaw(facts: BankAccountFacts, accountNumber: string | null, ifsc: string | null): Record<string, unknown> {
  return {
    account: lastFour(accountNumber),
    ifscCode: ifsc,
    accountStatus: facts.accountStatus,
    accountStatusCode: facts.accountStatusCode,
    nameAtBank: facts.nameAtBank,
    bankName: facts.bankName,
    branch: facts.branch,
    nameMatchResult: facts.nameMatchResult,
    utr: facts.utr,
    referenceId: facts.referenceId,
  };
}

/** One bank answer — the sync call's, the status read's or the webhook's `data` — read into a result. */
export function bankResultOf(ctx: Pick<CheckContext, 'verificationId'>, body: Record<string, unknown>, account: { accountNumber: string | null; ifsc: string | null }): CheckResult {
  const facts = shapeBankAccount(body);
  const raw = bankRaw(facts, account.accountNumber, account.ifsc);
  const common = { provider: NAME, providerRef: facts.referenceId, verificationId: ctx.verificationId, raw, matchedName: facts.nameAtBank ?? undefined, nameMatchScore: facts.nameMatchScore ?? undefined, transient: { facts, raw: body } satisfies BankAccountTransient };
  const status = (facts.accountStatus ?? '').toUpperCase();
  const code = (facts.accountStatusCode ?? '').toUpperCase();
  if (status === 'VALID') return { status: 'VERIFIED', ...common };
  if (BANK_IN_FLIGHT.has(status)) return { status: 'PENDING', ...common };
  if (code === 'INSUFFICIENT_BALANCE') return { status: 'FAILED', errorClass: 'INSUFFICIENT_BALANCE', failureCode: code, failureReason: 'The Secure ID wallet has no balance for this check', ...common };
  if (BANK_SOURCE_DOWN.has(code)) return { status: 'FAILED', errorClass: 'HTTP_5XX', failureCode: code, failureReason: 'The bank could not be reached; nothing was learned about the account', ...common };
  return { status: 'FAILED', errorClass: 'BUSINESS', failureCode: code || status || 'INVALID', failureReason: 'The bank did not confirm this account', ...common };
}

async function bankAccount(input: CheckInputs['BANK_ACCOUNT'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const accountNumber = input.accountNumber.replace(/\s+/g, '');
  const ifsc = upper(input.ifsc);
  const json: Record<string, unknown> = { bank_account: accountNumber, ifsc };
  if (input.name?.trim()) json['name'] = input.name.trim();
  if (input.phone?.trim()) json['phone'] = input.phone.replace(/[^0-9]/g, '').slice(-10);
  const asynchronous = input.mode === 'ASYNC';
  // The async call takes `user_id` — ours, unique — where the sync call takes no id of ours at all.
  if (asynchronous) json['user_id'] = ctx.verificationId;
  const answer = await call({ check: 'BANK_ACCOUNT', method: 'POST', path: asynchronous ? '/bank-account/async' : '/bank-account/sync', json });
  if (!answer.ok) return failure(ctx, answer);
  return bankResultOf(ctx, answer.body, { accountNumber, ifsc });
}

async function bankRefresh(attempt: PendingAttempt, ctx: CheckContext, call: Call): Promise<CheckResult> {
  const query: Record<string, string> = attempt.providerRef ? { reference_id: attempt.providerRef } : { user_id: attempt.verificationId };
  const answer = await call({ check: 'BANK_ACCOUNT', method: 'GET', path: '/bank-account', query });
  if (!answer.ok) return stillPending(attempt, ctx, answer);
  // The attempt already holds the masked account; the status read does not echo the number.
  const result = bankResultOf(ctx, answer.body, { accountNumber: null, ifsc: null });
  return { ...result, raw: { ...result.raw, account: attempt.result?.['account'] ?? null, ifscCode: attempt.result?.['ifscCode'] ?? null } };
}

/* ── GSTIN ─────────────────────────────────────────────────────── */

async function gstin(input: CheckInputs['GSTIN'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const number = upper(input.gstin);
  // The key is upper-case — `GSTIN`, not `gstin` (the product page's sample conflicts; the API reference is the spec).
  const answer = await call({ check: 'GSTIN', method: 'POST', path: '/gstin', json: { GSTIN: number, ...(input.businessName?.trim() ? { business_name: input.businessName.trim() } : {}) } });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  const legalName = str(body, 'legal_name_of_business') ?? undefined;
  const raw = {
    gstin: number,
    valid: body['valid'] === true,
    legalName: legalName ?? null,
    tradeName: str(body, 'trade_name_of_business'),
    gstStatus: str(body, 'gst_in_status'),
    taxpayerType: str(body, 'taxpayer_type'),
    constitution: str(body, 'constitution_of_business'),
    registeredOn: str(body, 'date_of_registration'),
    referenceId: refOf(body),
  };
  // A GSTIN Cashfree does not know comes back with no `valid` at all — only the id and "GSTIN Doesn't Exist".
  if (body['valid'] !== true) return refused(ctx, body, 'GSTIN_NOT_FOUND', str(body, 'message') ?? 'This GSTIN does not exist', raw);
  return passed(ctx, body, raw, { matchedName: legalName });
}

/* ── vehicle RC ────────────────────────────────────────────────── */

function rcResult(ctx: CheckContext, number: string, body: Record<string, unknown>): CheckResult {
  const facts = shapeVehicleRc(number, body);
  const raw = {
    registrationNumber: facts.registrationNumber,
    status: facts.status,
    rcStatus: facts.rcStatus,
    ownerName: facts.ownerName,
    vehicleClass: facts.vehicleClass,
    maker: facts.maker,
    model: facts.model,
    rcExpiresAt: facts.rcExpiresAt,
    insuranceValidUntil: facts.insuranceValidUntil,
    blacklisted: facts.blacklisted,
    referenceId: facts.referenceId,
  };
  const extras = { matchedName: facts.ownerName ?? undefined, transient: { facts, raw: body } satisfies VehicleRcTransient };
  if ((facts.status ?? '').toUpperCase() !== 'VALID') return refused(ctx, body, `RC_${(facts.status ?? 'INVALID').toUpperCase()}`, 'The registration authority has no valid certificate for this number', raw, extras);
  return passed(ctx, body, raw, extras);
}

async function vehicleRc(input: CheckInputs['VEHICLE_RC'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const number = normaliseVehicleNumber(input.vehicleNumber);
  const answer = await call({ check: 'VEHICLE_RC', method: 'POST', path: '/vehicle-rc', json: { verification_id: ctx.verificationId, vehicle_number: number } });
  if (answer.ok) return rcResult(ctx, number, answer.body);
  // The id was taken already: this attempt's first try reached Cashfree. The documented status read has its answer.
  if (answer.status === 409) {
    const read = await call({ check: 'VEHICLE_RC', method: 'GET', path: '/vehicle-rc', query: { verification_id: ctx.verificationId } });
    if (read.ok) return rcResult(ctx, number, read.body);
  }
  return failure(ctx, answer);
}

/* ── driving licence ───────────────────────────────────────────── */

async function drivingLicence(input: CheckInputs['DRIVING_LICENCE'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const number = upper(input.dlNumber).replace(/\s+/g, '');
  const answer = await call({ check: 'DRIVING_LICENCE', method: 'POST', path: '/driving-license', json: { verification_id: ctx.verificationId, dl_number: number, dob: input.dob } });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  const details = obj(body, 'details_of_driving_licence');
  const validity = obj(body, 'dl_validity');
  const name = str(details, 'name') ?? undefined;
  const status = (str(body, 'status') ?? '').toUpperCase();
  const raw = {
    dlNumber: lastFour(number),
    status: status || null,
    name: name ?? null,
    licenceStatus: str(details, 'status'),
    issuedOn: str(details, 'date_of_issue'),
    nonTransportValidUntil: str(obj(validity, 'non_transport'), 'to'),
    transportValidUntil: str(obj(validity, 'transport'), 'to'),
    referenceId: refOf(body),
  };
  if (status !== 'VALID') return refused(ctx, body, `DL_${status || 'INVALID'}`, 'The licensing authority has no valid licence for this number and date of birth', raw, { matchedName: name });
  return passed(ctx, body, raw, { matchedName: name });
}

/* ── the face ──────────────────────────────────────────────────── */

const blobOf = (image: ImageInput): Blob => new Blob([new Uint8Array(image.bytes)], { type: image.mime });
const filenameOf = (image: ImageInput, fallback: string): string => image.filename ?? `${fallback}.${image.mime === 'image/png' ? 'png' : 'jpg'}`;

async function faceLiveness(input: CheckInputs['FACE_LIVENESS'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const form = new FormData();
  form.append('verification_id', ctx.verificationId);
  form.append('image', blobOf(input.image), filenameOf(input.image, 'selfie'));
  const answer = await call({ check: 'FACE_LIVENESS', method: 'POST', path: '/face-liveness', form });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  const status = (str(body, 'status') ?? '').toUpperCase();
  // Only the verdict and the score are kept — not the age range, the gender or anything else Cashfree reads off a face.
  const raw = { status: status || null, liveness: body['liveness'] === true, livenessScore: num(body, 'liveness_score'), referenceId: refOf(body) };
  if (status === 'SUCCESS' && body['liveness'] === true) return passed(ctx, body, raw);
  return refused(ctx, body, status && status !== 'SUCCESS' ? status : 'NOT_LIVE', 'The picture is not a live face', raw);
}

async function faceMatch(input: CheckInputs['FACE_MATCH'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const form = new FormData();
  form.append('verification_id', ctx.verificationId);
  form.append('first_image', blobOf(input.first), filenameOf(input.first, 'first'));
  form.append('second_image', blobOf(input.second), filenameOf(input.second, 'second'));
  if (input.threshold !== undefined) form.append('threshold', String(input.threshold));
  const answer = await call({ check: 'FACE_MATCH', method: 'POST', path: '/face-match', form });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  const status = (str(body, 'status') ?? '').toUpperCase();
  const result = (str(body, 'face_match_result') ?? '').toUpperCase();
  const raw = { status: status || null, result: result || null, score: num(body, 'face_match_score'), referenceId: refOf(body) };
  if (status === 'SUCCESS' && result === 'YES') return passed(ctx, body, raw);
  return refused(ctx, body, status && status !== 'SUCCESS' ? status : 'FACE_MISMATCH', 'The two faces do not match', raw);
}

/* ── name match ────────────────────────────────────────────────── */

async function nameMatch(input: CheckInputs['NAME_MATCH'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const answer = await call({ check: 'NAME_MATCH', method: 'POST', path: '/name-match', json: { verification_id: ctx.verificationId, name_1: input.name1.trim(), name_2: input.name2.trim() } });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  // This API scores 0–1 where the PAN and bank answers score 0–100; the layer speaks 0–100 everywhere.
  const fraction = num(body, 'score');
  const score = fraction === null ? undefined : Math.round(Math.max(0, Math.min(1, fraction)) * 10_000) / 100;
  const raw = { status: str(body, 'status'), score: score ?? null, reason: str(body, 'reason'), referenceId: refOf(body) };
  if (score !== undefined && score >= ctx.settings.nameMatchMin) return passed(ctx, body, raw, { nameMatchScore: score });
  return refused(ctx, body, 'NAME_MISMATCH', `The names agree ${score ?? 0} in 100; ${ctx.settings.nameMatchMin} is needed`, raw, { nameMatchScore: score });
}

/* ── DigiLocker ────────────────────────────────────────────────── */

/** Cashfree's DigiLocker page is good for ten minutes. */
const DIGILOCKER_URL_TTL_MS = 10 * 60 * 1000;

async function digilockerCreate(input: CheckInputs['DIGILOCKER'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const json: Record<string, unknown> = { verification_id: ctx.verificationId, document_requested: input.documents };
  if (input.redirectUrl) json['redirect_url'] = input.redirectUrl;
  if (input.userFlow) json['user_flow'] = input.userFlow;
  const answer = await call({ check: 'DIGILOCKER', method: 'POST', path: '/digilocker', json });
  if (!answer.ok) return failure(ctx, answer);
  const url = str(answer.body, 'url');
  if (!url) return { status: 'FAILED', provider: NAME, providerRef: refOf(answer.body), verificationId: ctx.verificationId, errorClass: 'HTTP_5XX', failureCode: 'NO_URL', failureReason: 'Cashfree answered without a DigiLocker page', raw: {} };
  const now = ctx.now?.() ?? new Date();
  return {
    status: 'NEEDS_USER_ACTION',
    provider: NAME,
    providerRef: refOf(answer.body),
    verificationId: ctx.verificationId,
    raw: { status: 'PENDING', documentRequested: input.documents, referenceId: refOf(answer.body) },
    userAction: { kind: 'REDIRECT', url, expiresAt: new Date(now.getTime() + DIGILOCKER_URL_TTL_MS).toISOString() },
  };
}

/** A read that failed for a reason that says nothing about the answer: the attempt stays as it was, to be read again. */
function stillPending(attempt: PendingAttempt, ctx: CheckContext, answer: SecureIdFailure): CheckResult {
  if (answer.errorClass === 'BUSINESS') return failure(ctx, answer);
  return { status: 'PENDING', provider: NAME, providerRef: attempt.providerRef, verificationId: ctx.verificationId, raw: { ...(attempt.result ?? {}), lastReadError: answer.errorClass } };
}

export type DigilockerDocumentRead =
  | { ok: true; status: string; name: string | null; yearOfBirth: string | null; numberLast4: string | null; panType: string | null; /** In memory only — never stored. */ photo: Buffer | null }
  | { ok: false; pending: boolean; errorClass: ErrorClass; code: string | null };

/** Cashfree's codes for "the person's DigiLocker consent is no longer there" — DigiLocker is asked again. */
export const DIGILOCKER_CONSENT_GONE = new Set(['session_expired', 'url_expired', 'consent_not_granted']);

function readDocument(document: DigilockerDocument, answer: SecureIdAnswer): DigilockerDocumentRead {
  if (!answer.ok) return { ok: false, pending: false, errorClass: answer.errorClass, code: answer.code };
  // 202: "Validation in process check after some time".
  if (answer.status === 202 || str(answer.body, 'code') === 'validation_pending') return { ok: false, pending: true, errorClass: 'HTTP_5XX', code: 'validation_pending' };
  const body = answer.body;
  const dob = str(body, 'dob');
  const photoText = document === 'AADHAAR' ? str(body, 'photo_link') : null;
  // `photo_link` is the JPEG itself in Base64, not a link.
  const photo = photoText ? Buffer.from(photoText.replace(/^data:[^,]*,/, ''), 'base64') : null;
  return {
    ok: true,
    status: str(body, 'status') ?? 'UNKNOWN',
    name: document === 'PAN' ? str(body, 'name_pan_card', 'name') : str(body, 'name'),
    // DigiLocker dates are dd-mm-yyyy; the year is all that is kept.
    yearOfBirth: str(body, 'year_of_birth') ?? (dob && /\d{4}$/.test(dob) ? dob.slice(-4) : null),
    numberLast4: lastFour(document === 'AADHAAR' ? str(body, 'uid') : document === 'PAN' ? str(body, 'pan') : str(body, 'dl_number')),
    panType: document === 'PAN' ? str(body, 'type') : null,
    photo: photo && photo.length > 0 ? photo : null,
  };
}

/**
 * One document out of a consented DigiLocker — for the face match, which
 * needs the Aadhaar photograph and may not have it stored. The consent
 * lasts about an hour; after it, the read is refused with one of
 * `DIGILOCKER_CONSENT_GONE` and DigiLocker is asked again.
 */
export async function digilockerDocument(
  verificationId: string,
  document: DigilockerDocument,
  options: { fetchImpl?: FetchLike | undefined; now?: (() => Date) | undefined; keys?: SecureIdKeys | undefined } = {},
): Promise<DigilockerDocumentRead> {
  const keys = options.keys ?? (await getEffectiveSecureIdConfig());
  const answer = await secureIdCall({ check: 'DIGILOCKER', method: 'GET', path: `/digilocker/document/${document}`, query: { verification_id: verificationId }, verificationId }, keys, options.fetchImpl, options.now);
  return readDocument(document, answer);
}

/** What is kept of one DigiLocker document: its status, the name, the year of birth, the last four. Never the number, the photograph or the XML. */
const keptOf = (read: Extract<DigilockerDocumentRead, { ok: true }>): Record<string, unknown> => ({
  status: read.status,
  name: read.name,
  yearOfBirth: read.yearOfBirth,
  last4: read.numberLast4,
  ...(read.panType ? { type: read.panType } : {}),
});

/** A DigiLocker status body — the status read's, or the webhook's `data` — with the documents fetched when the person has consented. */
async function digilockerResult(attempt: PendingAttempt, ctx: CheckContext, body: Record<string, unknown>, call: Call): Promise<CheckResult> {
  const status = (str(body, 'status') ?? '').toUpperCase();
  const requested = Array.isArray(body['document_requested']) ? (body['document_requested'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  const consented = Array.isArray(body['document_consent']) ? (body['document_consent'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  const user = obj(body, 'user_details');
  const dob = str(user, 'dob');
  const base = {
    provider: NAME,
    providerRef: refOf(body) ?? attempt.providerRef,
    verificationId: ctx.verificationId,
  };
  const kept: Record<string, unknown> = {
    status: status || null,
    documentRequested: requested.length > 0 ? requested : (attempt.result?.['documentRequested'] ?? []),
    documentConsent: consented,
    consentValidUntil: str(body, 'document_consent_validity'),
    name: str(user, 'name'),
    yearOfBirth: dob && /\d{4}$/.test(dob) ? dob.slice(-4) : null,
    eaadhaar: str(user, 'eaadhaar'),
    referenceId: base.providerRef,
  };

  if (status === 'PENDING') return { status: 'NEEDS_USER_ACTION', ...base, raw: kept };
  if (status === 'EXPIRED') return { status: 'FAILED', ...base, errorClass: 'BUSINESS', failureCode: 'DIGILOCKER_EXPIRED', failureReason: 'The DigiLocker page was not finished within ten minutes', raw: kept };
  if (status === 'CONSENT_DENIED') return { status: 'FAILED', ...base, errorClass: 'BUSINESS', failureCode: 'CONSENT_DENIED', failureReason: 'The person declined to share their documents', raw: kept };
  // FAILURE is DigiLocker's own system error: no answer was given.
  if (status !== 'AUTHENTICATED') return { status: 'FAILED', ...base, errorClass: 'HTTP_5XX', failureCode: `DIGILOCKER_${status || 'UNKNOWN'}`, failureReason: 'DigiLocker could not complete the check', raw: kept };

  const documents: Record<string, unknown> = {};
  let name: string | undefined = (kept['name'] as string | null) ?? undefined;
  for (const document of ['AADHAAR', 'PAN'] as const) {
    if (!(kept['documentRequested'] as string[]).includes(document)) continue;
    const read = readDocument(document, await call({ check: 'DIGILOCKER', method: 'GET', path: `/digilocker/document/${document}`, query: { verification_id: ctx.verificationId } }));
    if (read.ok) {
      documents[document] = keptOf(read);
      if (document === 'AADHAAR' && read.name) name = read.name;
      continue;
    }
    if (read.pending || (read.errorClass !== 'BUSINESS' && document === 'AADHAAR')) {
      // The documents are not ready (or Cashfree could not be read): authenticated, but not finished — read again.
      return { status: 'PENDING', ...base, raw: { ...kept, documents, lastReadError: read.code ?? read.errorClass } };
    }
    documents[document] = { status: read.code ?? 'UNAVAILABLE' };
  }
  const raw = { ...kept, name: name ?? null, documents };
  const aadhaar = documents['AADHAAR'] as { status?: string } | undefined;
  if ((kept['documentRequested'] as string[]).includes('AADHAAR') && aadhaar?.status !== 'SUCCESS') {
    return { status: 'FAILED', ...base, errorClass: 'BUSINESS', failureCode: aadhaar?.status === 'AADHAAR_NOT_LINKED' ? 'AADHAAR_NOT_LINKED' : 'AADHAAR_UNAVAILABLE', failureReason: 'DigiLocker did not share the Aadhaar details', raw, matchedName: name };
  }
  return { status: 'VERIFIED', ...base, raw, matchedName: name };
}

async function digilockerRefresh(attempt: PendingAttempt, ctx: CheckContext, call: Call): Promise<CheckResult> {
  const answer = await call({ check: 'DIGILOCKER', method: 'GET', path: '/digilocker', query: { verification_id: attempt.verificationId } });
  if (!answer.ok) return stillPending(attempt, ctx, answer);
  return digilockerResult(attempt, ctx, answer.body, call);
}

/* ── UPI (off until the owner picks one) ───────────────────────── */

async function upi(input: CheckInputs['UPI_VPA'], ctx: CheckContext, call: Call): Promise<CheckResult> {
  const vpa = input.vpa.trim();
  const masked = vpa.replace(/^(.{0,2}).*(@.*)$/, '$1••••$2');
  if (ctx.settings.upiCheck === 'REVERSE_PENNY_DROP') {
    const json: Record<string, unknown> = { verification_id: ctx.verificationId };
    if (input.name?.trim()) json['name'] = input.name.trim();
    if (input.redirectUrl) json['redirect_url'] = input.redirectUrl;
    const answer = await call({ check: 'UPI_VPA', method: 'POST', path: '/reverse-penny-drop', json });
    if (!answer.ok) return failure(ctx, answer);
    const body = answer.body;
    const link = str(body, 'upi_link');
    if (!link) return { status: 'FAILED', provider: NAME, providerRef: refOf(body), verificationId: ctx.verificationId, errorClass: 'HTTP_5XX', failureCode: 'NO_LINK', failureReason: 'Cashfree answered without a UPI link', raw: {} };
    const links: Record<string, string> = {};
    for (const key of ['upi_link', 'gpay', 'bhim', 'paytm', 'phonepe']) {
      const value = str(body, key);
      if (value) links[key] = value;
    }
    return {
      status: 'NEEDS_USER_ACTION',
      provider: NAME,
      providerRef: refOf(body),
      verificationId: ctx.verificationId,
      raw: { mode: 'REVERSE_PENNY_DROP', vpa: masked, status: 'CREATED', referenceId: refOf(body) },
      userAction: { kind: 'REDIRECT', url: link, expiresAt: str(body, 'valid_upto') },
      transient: { links, qrCode: str(body, 'qr_code') } satisfies ReversePennyDropTransient,
    };
  }

  // The penny drop needs the account holder's own consent, given within five minutes of the call.
  if (!input.consent) {
    return { status: 'FAILED', provider: NAME, providerRef: null, verificationId: ctx.verificationId, errorClass: 'BUSINESS', failureCode: 'CONSENT_REQUIRED', failureReason: 'A UPI penny drop needs the account holder to consent first', raw: { mode: 'PENNY_DROP', vpa: masked } };
  }
  const json: Record<string, unknown> = {
    verification_id: ctx.verificationId,
    vpa,
    user_consent: { obtained: true, type: 'EXPLICIT', timestamp: input.consent.obtainedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'), purpose: input.consent.purpose },
  };
  if (input.name?.trim()) json['name'] = input.name.trim();
  const answer = await call({ check: 'UPI_VPA', method: 'POST', path: '/upi/penny-drop', json });
  if (!answer.ok) return failure(ctx, answer);
  const body = answer.body;
  const status = (str(body, 'status') ?? '').toUpperCase();
  const nameAtBank = str(body, 'name_at_bank') ?? undefined;
  const raw = { mode: 'PENNY_DROP', vpa: masked, status: status || null, nameAtBank: nameAtBank ?? null, nameMatchResult: str(body, 'name_match_result'), account: lastFour(str(body, 'bank_account')), ifscCode: str(body, 'ifsc'), utr: str(body, 'utr'), referenceId: refOf(body) };
  const extras = { matchedName: nameAtBank, nameMatchScore: score100(body, 'name_match_score') };
  if (status === 'VALID') return passed(ctx, body, raw, extras);
  return refused(ctx, body, `UPI_${status || 'INVALID'}`, 'This UPI id was not confirmed', raw, extras);
}

async function upiRefresh(attempt: PendingAttempt, ctx: CheckContext, call: Call): Promise<CheckResult> {
  const answer = await call({ check: 'UPI_VPA', method: 'GET', path: '/remitter/status', query: { verification_id: attempt.verificationId } });
  if (!answer.ok) return stillPending(attempt, ctx, answer);
  const body = answer.body;
  const status = (str(body, 'status') ?? '').toUpperCase();
  const nameAtBank = str(body, 'name_at_bank') ?? undefined;
  const base = { provider: NAME, providerRef: refOf(body) ?? attempt.providerRef, verificationId: ctx.verificationId };
  const raw = { ...(attempt.result ?? {}), status: status || null, nameAtBank: nameAtBank ?? null, nameMatchResult: str(body, 'name_match_result'), account: lastFour(str(body, 'bank_account')), ifscCode: str(body, 'ifsc'), utr: str(body, 'utr') };
  if (status === 'SUCCESS') return { status: 'VERIFIED', ...base, raw, matchedName: nameAtBank, nameMatchScore: score100(body, 'name_match_score') };
  if (status === 'CREATED') return { status: 'NEEDS_USER_ACTION', ...base, raw };
  return { status: 'FAILED', ...base, errorClass: 'BUSINESS', failureCode: `UPI_${status || 'FAILURE'}`, failureReason: status === 'EXPIRED' ? 'The ₹1 payment was not made in time' : 'The ₹1 payment did not confirm the account', raw };
}

/* ── the provider ──────────────────────────────────────────────── */

/**
 * A provider bound to a way of getting keys — the settings row in the
 * running server; fixed keys in the legacy wrappers, the tests and the
 * smoke script.
 */
export function createSecureIdProvider(keysOf?: () => Promise<SecureIdKeys> | SecureIdKeys): VerificationProvider {
  const keysNow = async (): Promise<SecureIdKeys> => (keysOf ? keysOf() : getEffectiveSecureIdConfig());
  return {
    name: NAME,
    capabilities: secureIdCapabilities,
    async configured() {
      return secureIdConfigured(await keysNow());
    },
    async usable(check, input, settings, now) {
      // The UPI penny drop (asked as the owner's PENNY_DROP, or as the
      // backup of Digio's VPA lookup) needs the holder's own consent from
      // the last five minutes. Without it Cashfree is not asked at all — the
      // router skips it rather than record a refusal nobody could avoid.
      if (check === 'UPI_VPA' && settings.upiCheck !== 'REVERSE_PENNY_DROP' && !upiConsentFresh((input as CheckInputs['UPI_VPA']).consent, now)) return 'NEEDS_CONSENT';
      return null;
    },
    async run(check, input, ctx) {
      const { call } = await wire(ctx, await keysNow());
      switch (check) {
        case 'PAN':
          return pan(input as CheckInputs['PAN'], ctx, call);
        case 'BANK_ACCOUNT':
          return bankAccount(input as CheckInputs['BANK_ACCOUNT'], ctx, call);
        case 'GSTIN':
          return gstin(input as CheckInputs['GSTIN'], ctx, call);
        case 'VEHICLE_RC':
          return vehicleRc(input as CheckInputs['VEHICLE_RC'], ctx, call);
        case 'DRIVING_LICENCE':
          return drivingLicence(input as CheckInputs['DRIVING_LICENCE'], ctx, call);
        case 'FACE_LIVENESS':
          return faceLiveness(input as CheckInputs['FACE_LIVENESS'], ctx, call);
        case 'FACE_MATCH':
          return faceMatch(input as CheckInputs['FACE_MATCH'], ctx, call);
        case 'NAME_MATCH':
          return nameMatch(input as CheckInputs['NAME_MATCH'], ctx, call);
        case 'DIGILOCKER':
          return digilockerCreate(input as CheckInputs['DIGILOCKER'], ctx, call);
        case 'UPI_VPA':
          return upi(input as CheckInputs['UPI_VPA'], ctx, call);
        case 'HOSTED_KYC':
          // Cashfree has no hosted journey of its own: its equivalent is a
          // session of the checks above, opened by the caller. Nothing is
          // asked of Cashfree here; the person is what the session waits on.
          return { status: 'NEEDS_USER_ACTION', provider: NAME, providerRef: null, verificationId: ctx.verificationId, raw: { composite: true } };
        default:
          return { status: 'FAILED', provider: NAME, providerRef: null, verificationId: ctx.verificationId, errorClass: 'NOT_ENABLED', failureCode: 'UNSUPPORTED_CHECK', failureReason: 'Cashfree Secure ID does not answer this check', raw: {} };
      }
    },
    async refresh(attempt, ctx) {
      const { call } = await wire(ctx, await keysNow());
      if (attempt.checkType === 'DIGILOCKER') return digilockerRefresh(attempt, ctx, call);
      if (attempt.checkType === 'BANK_ACCOUNT') return bankRefresh(attempt, ctx, call);
      if (attempt.checkType === 'UPI_VPA') return upiRefresh(attempt, ctx, call);
      return { status: 'PENDING', provider: NAME, providerRef: attempt.providerRef, verificationId: ctx.verificationId, raw: attempt.result ?? {} };
    },
  };
}

/** The provider the running server uses — keys from Settings › Integrations › Secure ID, else the environment. */
export const cashfreeSecureIdProvider: VerificationProvider = createSecureIdProvider();

/** A DigiLocker webhook's `data` read into a result, the documents fetched when the person has consented. */
export async function digilockerResultFromEvent(attempt: PendingAttempt, ctx: CheckContext, data: Record<string, unknown>, keys?: SecureIdKeys): Promise<CheckResult> {
  const { call } = await wire(ctx, keys);
  return digilockerResult(attempt, ctx, data, call);
}
