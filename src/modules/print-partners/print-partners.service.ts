import { findActivityRows, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { monthWindowIST } from '../../shared/time';
import { toListPage } from '../../shared/pagination';
import { getPlatformSettings } from '../app-config';
import { normalizeMobile, revokeSessions } from '../auth';
import { allocateIdentifier } from '../identifiers';
import { notify } from '../notifications';
import { assertCityAllows, cityKeyFor, withCityKey } from '../pricing';
import {
  addMethod,
  listMethods,
  listWithdrawals,
  requestWithdrawal,
  withdrawalAllowance,
  type AddMethodInput,
} from '../payouts';
import { findUploadedFile } from '../uploads';
import { ensureWallet, findWalletFor, listEntries, snapshot, sumEntries } from '../wallets';
import { prismaPrintPartnersRepository as repository } from './prisma-print-partners.repository';
import type { PartnerFileRow, PartnerListFilter, PartnerPatch, PartnerRow } from './print-partners.repository';
import type {
  ApplicationDetailsInput,
  CreatePartnerInput,
  PartnerInvoiceInput,
  PartnerWithdrawalInput,
  RateCardInput,
  RateCardRow,
  UpdateMeInput,
  UpdatePartnerInput,
} from './print-partners.schema';

/**
 * Print partners — Lot B (Q50/B4b) and Lot H (Q147, the owner's 6 Sep and
 * 13 Sep mechanics).
 *
 * A print partner is a User with role PARTNER, a PrintPartner row ops keeps
 * at the desk, and a wallet with the fourth owner key. Lot B made the
 * partner a payee on a sign-in-disabled account; Lot H lets ops **activate**
 * the account so the partner signs in by OTP on their own phone and works
 * the floor — the rate card, the quote requests, the jobs, the wallet.
 *
 * Approved job costs land in the wallet as PRINT_COST and leave through the
 * same withdrawal ladder every other party uses — now raised by the partner
 * themselves, still vetted, released or marked paid with a UTR.
 *
 * Every write is audited by the controller: the desk's under the admin,
 * the floor's under the partner's own user.
 */

/** The purposes the partner's own files carry — both private (uploads). */
export const RATE_CARD_PURPOSE = 'PARTNER_RATE_CARD';
export const INVOICE_PURPOSE = 'PARTNER_INVOICE';

export const walletLabelFor = (partner: Pick<PartnerRow, 'name'>) => `${partner.name} · print partner`;

export async function createPartner(input: CreatePartnerInput): Promise<PartnerRow> {
  const mobile = normalizeMobile(input.mobile);
  // A partner account is never attached to an existing person: the account
  // has to be sign-in-disabled, and disabling a publisher's or an agent's
  // sign-in because their number was typed here would be a very bad day.
  if (await repository.findUserByMobile(mobile)) {
    throw new ApiError(409, 'CONFLICT', 'That mobile already belongs to an ADX account. A print partner needs its own number.');
  }
  if (input.email && (await repository.emailTaken(input.email))) {
    throw new ApiError(409, 'CONFLICT', 'That email belongs to another account');
  }
  // Lot V: a partner is signed where the city's rollout stage has print
  // partners on (LAUNCHED); a city outside the catalogue is free text.
  await assertCityAllows(input.city, 'printPartners');

  // Allocated after the checks, before the write: PRT-1209-2601 comes off an
  // atomic daily sequence and is never reissued, so a 409 must not burn one.
  const displayId = await allocateIdentifier('PARTNER');
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const partner = await repository.createPartner(await withCityKey({
    displayId,
    mobile,
    name: input.name,
    legalName: input.legalName ?? null,
    gstin: input.gstin ?? null,
    panNumber: input.panNumber ?? null,
    contactName: input.contactName ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    capabilities: input.capabilities ?? [],
    maxWidthFt: input.maxWidthFt ? new Decimal(input.maxWidthFt) : null,
    turnaroundDays: input.turnaroundDays ?? null,
    notes: input.notes ?? null,
  }));

  // The wallet exists from day one rather than appearing on the first job:
  // ops records the payout method against the account straight away, and a
  // wallet id is what the on-behalf withdrawal names.
  await ensureWallet({ kind: 'PRINT_PARTNER', id: partner.id }, walletLabelFor(partner));
  return partner;
}

/**
 * PP-1 (the owner, 21 Sep 2026): a print shop applies from the app. The
 * same row the desk would create, written by the applicant with `appliedAt`
 * stamped and the account left active so they can watch the review; the
 * desk reviews the details and the KYC and activates through the same
 * door as ever (`activatePartner`), or takes them off the roster with a
 * reason. A number that already holds a publisher, advertiser or agent
 * account is refused — the app picks a floor by role, and a shop shares a
 * phone with nobody. Idempotent: applying twice returns the application.
 */
export async function applyAsPartner(
  userId: string,
  input: { name: string; legalName?: string | null; mobile: string; email?: string | null },
  now = new Date(),
): Promise<{ partner: PartnerRow; created: boolean }> {
  const existing = await repository.findPartnerByUserId(userId);
  if (existing) return { partner: existing, created: false };
  const roles = await repository.findUserRoles(userId);
  if (roles.some((role) => role === 'PUBLISHER' || role === 'ADVERTISER' || role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER')) {
    throw new ApiError(409, 'CONFLICT', 'This number already has an ADX account. A print shop needs its own number.');
  }
  const displayId = await allocateIdentifier('PARTNER');
  const partner = await repository.createApplication({
    userId,
    appliedAt: now,
    displayId,
    mobile: normalizeMobile(input.mobile),
    name: input.name,
    legalName: input.legalName ?? null,
    gstin: null,
    panNumber: null,
    contactName: null,
    email: input.email ?? null,
    address: null,
    city: null,
    latitude: null,
    longitude: null,
    capabilities: [],
    maxWidthFt: null,
    turnaroundDays: null,
    notes: null,
  });
  await ensureWallet({ kind: 'PRINT_PARTNER', id: partner.id }, walletLabelFor(partner));
  await logActivity(userId, 'PRINT_PARTNER_APPLIED', undefined, { partnerId: partner.id, displayId });
  return { partner, created: true };
}

/**
 * PP-1: the applicant fills in what the desk would have typed. Open only
 * while the application is — a partner the desk has activated changes the
 * legal identity at the desk, and the rest through `updateMe`. The city is
 * gated like the desk's create, so a shop in a city with print partners off
 * hears CITY_NOT_OPEN now rather than at activation.
 */
export async function completeApplication(partner: PartnerRow, input: ApplicationDetailsInput): Promise<{ before: PartnerRow; after: PartnerRow }> {
  if (!partner.appliedAt || partner.activatedAt) {
    throw new ApiError(409, 'CONFLICT', 'This account is past its application. Ask ADX to change these details.');
  }
  if (input.email && input.email !== partner.email && (await repository.emailTaken(input.email))) {
    throw new ApiError(409, 'CONFLICT', 'That email belongs to another account');
  }
  if (input.city !== undefined && input.city !== null) await assertCityAllows(input.city, 'printPartners');
  const patch: PartnerPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.legalName !== undefined) patch.legalName = input.legalName;
  if (input.gstin !== undefined) patch.gstin = input.gstin;
  if (input.panNumber !== undefined) patch.panNumber = input.panNumber;
  if (input.contactName !== undefined) patch.contactName = input.contactName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.address !== undefined) patch.address = input.address;
  if (input.city !== undefined) patch.city = input.city;
  if (input.latitude !== undefined) patch.latitude = input.latitude;
  if (input.longitude !== undefined) patch.longitude = input.longitude;
  if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
  if (input.maxWidthFt !== undefined) patch.maxWidthFt = input.maxWidthFt ? new Decimal(input.maxWidthFt) : null;
  if (input.turnaroundDays !== undefined) patch.turnaroundDays = input.turnaroundDays;
  if (input.acceptsQuoteRequests !== undefined) patch.acceptsQuoteRequests = input.acceptsQuoteRequests;
  if (input.notes !== undefined) patch.notes = input.notes;
  const after = await repository.updatePartner(partner.id, await withCityKey(patch));
  return { before: partner, after };
}

/** O-B: the label per partner id, for `section-overviews`. */
export const findPrintPartnerLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

export async function getPartner(id: string): Promise<PartnerRow> {
  const partner = await repository.findPartner(id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Print partner not found');
  return partner;
}

export const listPartners = async (filter: PartnerListFilter) => {
  // Lot X-B: `?city=` is a slug (or a name, for the console's older links) — matched by key, the spelling as the fallback.
  const keyed = filter.city ? { ...filter, cityId: (await cityKeyFor(filter.city))?.cityId ?? null } : filter;
  const { items, total, counts } = await repository.listPartners(keyed);
  return toListPage(items, total, counts, filter);
};

export async function updatePartner(id: string, input: UpdatePartnerInput): Promise<{ before: PartnerRow; after: PartnerRow }> {
  const before = await getPartner(id);
  if (input.email && input.email !== before.email && (await repository.emailTaken(input.email))) {
    throw new ApiError(409, 'CONFLICT', 'That email belongs to another account');
  }
  const patch: PartnerPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.legalName !== undefined) patch.legalName = input.legalName;
  if (input.gstin !== undefined) patch.gstin = input.gstin;
  if (input.panNumber !== undefined) patch.panNumber = input.panNumber;
  if (input.contactName !== undefined) patch.contactName = input.contactName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.address !== undefined) patch.address = input.address;
  if (input.city !== undefined) patch.city = input.city;
  if (input.latitude !== undefined) patch.latitude = input.latitude;
  if (input.longitude !== undefined) patch.longitude = input.longitude;
  if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
  if (input.maxWidthFt !== undefined) patch.maxWidthFt = input.maxWidthFt ? new Decimal(input.maxWidthFt) : null;
  if (input.turnaroundDays !== undefined) patch.turnaroundDays = input.turnaroundDays;
  if (input.notes !== undefined) patch.notes = input.notes;
  // G13-B: the desk flips the quote switch for a partner who never activates.
  if (input.acceptsQuoteRequests !== undefined) patch.acceptsQuoteRequests = input.acceptsQuoteRequests;
  // Lot X-B: a patched city carries its key; a patch of other fields leaves the key alone.
  const after = await repository.updatePartner(id, await withCityKey(patch));
  return { before, after };
}

/** G13-B: when the account behind each partner last signed in — one lookup for a page. */
export async function withLastLogin<T extends Pick<PartnerRow, 'userId'>>(rows: readonly T[]): Promise<(T & { lastLoginAt: Date | null })[]> {
  const logins = new Map((await repository.findLastLogins(rows.map((row) => row.userId))).map((row) => [row.userId, row.lastLoginAt]));
  return rows.map((row) => ({ ...row, lastLoginAt: logins.get(row.userId) ?? null }));
}

/**
 * Off the roster: no new job may name this partner. Jobs already open run
 * to the end and their costs are still approved and still paid — a shop
 * that printed the banners is owed for them whatever happened since.
 * Idempotent: deactivating twice is the same answer.
 */
export async function deactivatePartner(id: string, reason?: string | null): Promise<{ before: PartnerRow; after: PartnerRow }> {
  const before = await getPartner(id);
  if (!before.isActive) return { before, after: before };
  const after = await repository.updatePartner(id, {
    isActive: false,
    ...(reason ? { notes: [before.notes, `Deactivated: ${reason}`].filter(Boolean).join('\n') } : {}),
  });
  // Lot H: off the roster is off the app too — the account is switched off
  // and every session the partner holds is ended, so a deactivated shop
  // cannot keep accepting jobs from a phone that was already signed in.
  await repository.setUserActive(before.userId, false);
  await revokeSessions(before.userId, 'PRINT_PARTNER_DEACTIVATED');
  return { before, after };
}

/**
 * Back on the roster, through the ordinary PATCH. Lot H: an account ops had
 * activated before signs in again; one never activated stays as it was —
 * activation is its own step.
 */
export async function reactivatePartner(id: string): Promise<PartnerRow> {
  const after = await repository.updatePartner(id, { isActive: true });
  if (after.activatedAt) await repository.setUserActive(after.userId, true);
  return after;
}

/* ── Lot H: activation ───────────────────────────────────────────── */

/**
 * Ops switches the account on: `User.isActive` true, `activatedAt` and who
 * did it stamped, and the partner told by SMS (the INVITE kind — an
 * invitation to sign in is what it is) that the ADX app now takes this
 * number. From then on the ordinary OTP sign-in answers the ordinary token
 * pair; the app decides the floor by the PARTNER role. Idempotent: a second
 * activation re-stamps nothing and sends nothing. A partner off the roster
 * is reactivated first (409).
 *
 * Lot N: with `kyc.printPartnerActivationRequiresKyc` on (off by default —
 * ops activate and KYC follows), a partner whose `PrintPartner.kycStatus`
 * is not VERIFIED is refused 409 `KYC_REQUIRED` — the desk records or
 * requests the partner's KYC first (N-B2's record; the mirror column is
 * read here through this module's own repository, as `publishers` reads
 * its own). An already-activated partner is idempotent before the gate.
 */
export async function activatePartner(
  id: string,
  byUserId: string,
  now = new Date(),
): Promise<{ before: PartnerRow; after: PartnerRow; activated: boolean }> {
  const before = await getPartner(id);
  if (!before.isActive) {
    throw new ApiError(409, 'CONFLICT', 'This partner is off the roster. Reactivate it before switching the account on.');
  }
  if (before.activatedAt) return { before, after: before, activated: false };
  await assertActivationKyc(before);
  // Lot V: activation is the moment the partner starts being asked to quote,
  // so it is gated like the create. Lot X-B: by the key the row carries.
  await assertCityAllows(before.city, 'printPartners', before.cityId);
  await repository.setUserActive(before.userId, true);
  const after = await repository.updatePartner(id, { activatedAt: now, activatedById: byUserId });
  await notify(
    'PARTNER_ACTIVATED',
    after.userId,
    { name: after.name, mobile: after.mobile },
    {
      type: 'SYSTEM',
      recipient: { mobile: after.mobile, email: after.email },
      inApp: {
        type: 'SYSTEM',
        title: 'Welcome to ADX',
        message: 'Your print partner account is active. Set up your rate card to be asked first for print jobs.',
      },
    },
  ).catch(() => undefined);
  return { before, after, activated: true };
}

/** Lot N: the KYC gate on activation, read from the platform settings row. */
async function assertActivationKyc(partner: Pick<PartnerRow, 'kycStatus'>): Promise<void> {
  const { kyc } = await getPlatformSettings();
  if (!kyc.printPartnerActivationRequiresKyc) return;
  if (partner.kycStatus === 'VERIFIED') return;
  throw new ApiError(409, 'KYC_REQUIRED', 'The partner’s KYC is not verified yet. Record or request it before switching the account on.', {
    kycStatus: partner.kycStatus,
  });
}

/* ── Lot H: the partner's own profile ────────────────────────────── */

/** The partner behind a signed-in user — 403 for a PARTNER-role user with no row, which should not exist. */
export async function getPartnerForUser(userId: string): Promise<PartnerRow> {
  const partner = await repository.findPartnerByUser(userId);
  if (!partner) throw new ApiError(403, 'FORBIDDEN', 'This account is not a print partner.');
  return partner;
}

export type RateCardState = {
  hasRateCard: boolean;
  fileId: string | null;
  /** The private file's door, when there is a file. */
  fileUrl: string | null;
  updatedAt: Date | null;
  rows: RateCardRow[];
};

export const hasRateCard = (partner: Pick<PartnerRow, 'rateCardFileId' | 'rateCardRows'>): boolean =>
  Boolean(partner.rateCardFileId) || (Array.isArray(partner.rateCardRows) && partner.rateCardRows.length > 0);

/** Lot H: a rate card is a file, rows, or both; either makes the partner "preferred". */
export function rateCardStateOf(partner: PartnerRow): RateCardState {
  const rows = Array.isArray(partner.rateCardRows) ? (partner.rateCardRows as RateCardRow[]) : [];
  return {
    hasRateCard: hasRateCard(partner),
    fileId: partner.rateCardFileId,
    fileUrl: partner.rateCardFileId ? `/api/v1/files/${partner.rateCardFileId}` : null,
    updatedAt: partner.rateCardUpdatedAt,
    rows,
  };
}

/** The partner's own page: the row, the wallet as it stands, the rate card state. */
export async function partnerProfile(partner: PartnerRow) {
  const wallet = await findWalletFor({ kind: 'PRINT_PARTNER', id: partner.id });
  const balances = wallet ? await snapshot(wallet.id) : null;
  return { partner, walletId: wallet?.id ?? null, balances, rateCard: rateCardStateOf(partner) };
}

/** What the partner may change from the app — the contact, the address, the capabilities, the quote switch. */
export async function updateMe(partner: PartnerRow, input: UpdateMeInput): Promise<{ before: PartnerRow; after: PartnerRow }> {
  if (input.email && input.email !== partner.email && (await repository.emailTaken(input.email))) {
    throw new ApiError(409, 'CONFLICT', 'That email belongs to another account');
  }
  const patch: PartnerPatch = {};
  if (input.contactName !== undefined) patch.contactName = input.contactName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.address !== undefined) patch.address = input.address;
  if (input.city !== undefined) patch.city = input.city;
  if (input.latitude !== undefined) patch.latitude = input.latitude;
  if (input.longitude !== undefined) patch.longitude = input.longitude;
  if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
  if (input.maxWidthFt !== undefined) patch.maxWidthFt = input.maxWidthFt ? new Decimal(input.maxWidthFt) : null;
  if (input.turnaroundDays !== undefined) patch.turnaroundDays = input.turnaroundDays;
  if (input.acceptsQuoteRequests !== undefined) patch.acceptsQuoteRequests = input.acceptsQuoteRequests;
  // Lot X-B: a patched city carries its key.
  const after = await repository.updatePartner(partner.id, await withCityKey(patch));
  return { before: partner, after };
}

/**
 * A file the partner named has to be their own and carry the purpose the
 * field expects. G13-B: on the desk's behalf, a file the acting admin
 * uploaded (on behalf of the partner, or under their own hand) passes too.
 */
async function assertOwnFile(partner: PartnerRow, fileId: string, purpose: string, alsoOwnedBy: string | null = null): Promise<void> {
  const file = await findUploadedFile(fileId);
  const owner = file ? (file.ownerUserId ?? file.userId) : null;
  const allowed = file ? owner === partner.userId || (alsoOwnedBy !== null && (owner === alsoOwnedBy || file.userId === alsoOwnedBy)) : false;
  if (!file || !allowed) {
    throw new ApiError(404, 'NOT_FOUND', 'File not found. Upload it first and send the id it returned.');
  }
  if (file.purpose !== purpose) {
    throw new ApiError(400, 'BAD_REQUEST', `That file was uploaded for ${file.purpose}; upload it with purpose ${purpose}.`);
  }
}

/**
 * The rate card (Lot H): a file uploaded under PARTNER_RATE_CARD, structured
 * rows, or both. Replaces what was there — the card is a whole, not a diff.
 * A partner with a rate card is asked first (the award's tie-break) and is
 * listed ahead in an AUTO invite.
 */
export async function setRateCard(partner: PartnerRow, input: RateCardInput, now = new Date()): Promise<{ before: PartnerRow; after: PartnerRow }> {
  if (input.fileId) await assertOwnFile(partner, input.fileId, RATE_CARD_PURPOSE);
  const after = await repository.updatePartner(partner.id, {
    rateCardFileId: input.fileId ?? null,
    rateCardRows: input.rows as never,
    rateCardUpdatedAt: now,
  });
  return { before: partner, after };
}

/**
 * G13-B: the desk sets the rate card for a partner who never activates —
 * the same card, the file the partner's own or the admin's upload on their
 * behalf. Audited by the controller under the admin.
 */
export async function setRateCardOnBehalf(
  partnerId: string,
  input: RateCardInput,
  byUserId: string,
  now = new Date(),
): Promise<{ before: PartnerRow; after: PartnerRow }> {
  const partner = await getPartner(partnerId);
  if (input.fileId) await assertOwnFile(partner, input.fileId, RATE_CARD_PURPOSE, byUserId);
  const after = await repository.updatePartner(partner.id, {
    rateCardFileId: input.fileId ?? null,
    rateCardRows: input.rows as never,
    rateCardUpdatedAt: now,
  });
  return { before: partner, after };
}

/* ── Lot H: the partner's money, from their own phone ────────────── */

/** The wallet behind the partner, opened if it somehow is not — ops recorded the payout method against it. */
async function partnerWallet(partner: PartnerRow): Promise<{ id: string }> {
  return (await findWalletFor({ kind: 'PRINT_PARTNER', id: partner.id })) ?? ensureWallet({ kind: 'PRINT_PARTNER', id: partner.id }, walletLabelFor(partner));
}

/** The earnings page: the balance and what may leave today, a page of the ledger, the withdrawals. */
export async function partnerEarnings(partner: PartnerRow, query: { limit?: number; cursor?: string } = {}) {
  const wallet = await partnerWallet(partner);
  const limit = Math.min(query.limit ?? 50, 200);
  const [balances, allowance, entries, withdrawals] = await Promise.all([
    snapshot(wallet.id),
    withdrawalAllowance(wallet.id),
    listEntries(wallet.id, { limit, ...(query.cursor ? { cursor: query.cursor } : {}) }),
    listWithdrawals({ walletId: wallet.id, limit: 50 }),
  ]);
  return {
    walletId: wallet.id,
    balances,
    allowance,
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: money(entry.amount),
      balanceAfter: money(entry.balanceAfter),
      orderId: entry.orderId,
      reference: entry.reference,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
    withdrawals,
  };
}

/**
 * The partner's own withdrawal — `payouts.requestWithdrawal` exactly: the
 * VERIFIED method (their default unless one is named), the minimum, the
 * daily cap on the SMALL_AGENCY rung, the cleared balance, the freeze. A
 * person still vets it; nothing here is automatic.
 */
export async function requestPartnerWithdrawal(partner: PartnerRow, input: PartnerWithdrawalInput, now = new Date()) {
  const wallet = await partnerWallet(partner);
  let methodId = input.payoutMethodId ?? null;
  if (!methodId) {
    const methods = await listMethods(partner.userId);
    const verified = methods.filter((method) => method.status === 'VERIFIED');
    const method = verified.find((row) => row.isDefault) ?? verified[0];
    if (!method) {
      throw new ApiError(400, 'BAD_REQUEST', 'Add a bank account or UPI ID first; ADX verifies it before sending money to it.');
    }
    methodId = method.id;
  }
  return requestWithdrawal(wallet.id, { amount: input.amount as Money, payoutMethodId: methodId, userId: partner.userId }, now);
}

/** The partner's bank or UPI, verified by the desk like everyone else's. */
export const listPartnerPayoutMethods = (partner: PartnerRow) => listMethods(partner.userId);
export const addPartnerPayoutMethod = (partner: PartnerRow, input: AddMethodInput) => addMethod(partner.userId, input);

/**
 * The month's invoice to ADX (Lot H): a private file under PARTNER_INVOICE,
 * the partner's own. The latest is kept on the row; every one the partner
 * ever uploaded is listed from the files themselves on the console page.
 * The month rides on the audit row until the schema carries an invoice
 * table (README, schema note).
 */
export async function recordPartnerInvoice(partner: PartnerRow, input: PartnerInvoiceInput): Promise<{ before: PartnerRow; after: PartnerRow }> {
  await assertOwnFile(partner, input.fileId, INVOICE_PURPOSE);
  const after = await repository.updatePartner(partner.id, { invoiceUploadFileId: input.fileId });
  return { before: partner, after };
}

export const listPartnerInvoices = (partner: Pick<PartnerRow, 'userId'>, limit = 36) =>
  repository.listPartnerFiles(partner.userId, INVOICE_PURPOSE, limit);

/** G13-B: the desk records the month's invoice for a partner who never activates — the file the admin's own upload, or the partner's. */
export async function recordPartnerInvoiceOnBehalf(partnerId: string, input: PartnerInvoiceInput, byUserId: string): Promise<{ before: PartnerRow; after: PartnerRow }> {
  const partner = await getPartner(partnerId);
  await assertOwnFile(partner, input.fileId, INVOICE_PURPOSE, byUserId);
  const after = await repository.updatePartner(partner.id, { invoiceUploadFileId: input.fileId });
  return { before: partner, after };
}

export type PartnerInvoiceView = PartnerFileRow & {
  /** `YYYY-MM`, from the PARTNER_INVOICE_UPLOADED audit row that named the file; null for a file uploaded and never recorded. */
  month: string | null;
  /** Who recorded it — the partner, or an admin on their behalf. */
  recordedBy: 'PARTNER' | 'ADMIN' | null;
};

/**
 * G13-B: every invoice on file for the partner, newest first, each with
 * its month. The files are the partner's own PARTNER_INVOICE uploads plus
 * any an admin uploaded on their behalf — those are found through the
 * `PARTNER_INVOICE_UPLOADED` audit rows against the partner, which also
 * carry the month (the schema has no invoice table yet; README).
 */
export async function listPartnerInvoicesWithMonths(partner: PartnerRow, limit = 36): Promise<PartnerInvoiceView[]> {
  const [own, rows] = await Promise.all([
    listPartnerInvoices(partner, limit),
    findActivityRows({ action: 'PARTNER_INVOICE_UPLOADED', targetType: 'PrintPartner', targetId: partner.id }, { skip: 0, take: 500, sort: 'newest' }),
  ]);
  const months = new Map<string, { month: string | null; recordedBy: 'PARTNER' | 'ADMIN' }>();
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
    const fileId = typeof meta['fileId'] === 'string' ? meta['fileId'] : null;
    if (!fileId || months.has(fileId)) continue;
    months.set(fileId, { month: typeof meta['month'] === 'string' ? meta['month'] : null, recordedBy: meta['onBehalf'] === true ? 'ADMIN' : 'PARTNER' });
  }
  const seen = new Set(own.map((file) => file.id));
  const named = [...months.keys()].filter((id) => !seen.has(id));
  const extra = named.length ? await repository.findFilesByIds(named) : [];
  return [...own, ...extra]
    .map((file) => ({ ...file, month: months.get(file.id)?.month ?? null, recordedBy: months.get(file.id)?.recordedBy ?? null }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export type PartnerEarningsSummary = { thisMonth: string; lastMonth: string; pending: string; paidToDate: string };

/**
 * G13-B: the earnings page's four figures, Indian months, from the ledger:
 * `thisMonth` / `lastMonth` are the EARNING lines (the approved print
 * costs, net of TDS) in the month; `pending` is what is on its way out —
 * withdrawals raised, approved or with the rail, not yet paid; `paidToDate`
 * is every withdrawal PAID.
 */
export async function partnerEarningsSummary(partner: PartnerRow, now = new Date()): Promise<PartnerEarningsSummary> {
  const wallet = await partnerWallet(partner);
  const shifted = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const current = monthWindowIST(year, month);
  const previous = monthWindowIST(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
  const [thisMonth, lastMonth, inFlight, paid] = await Promise.all([
    sumEntries(wallet.id, ['EARNING'], current.start, current.end),
    sumEntries(wallet.id, ['EARNING'], previous.start, previous.end),
    listWithdrawals({ walletId: wallet.id, status: ['REQUESTED', 'APPROVED', 'PROCESSING'], limit: 200 }),
    listWithdrawals({ walletId: wallet.id, status: ['PAID'], limit: 200 }),
  ]);
  const sum = (rows: readonly { netAmount: Decimal | string }[]) => rows.reduce((acc, row) => acc.plus(new Decimal(row.netAmount)), new Decimal(0));
  return {
    thisMonth: money(thisMonth.total),
    lastMonth: money(lastMonth.total),
    pending: money(sum(inFlight)),
    paidToDate: money(sum(paid)),
  };
}

/**
 * The partner's money and work in one read: the wallet as it stands, its
 * statement lines, the withdrawals raised against it, and the jobs behind
 * the credits. The console's partner page is drawn from this.
 */
export async function partnerLedger(id: string, query: { limit?: number; cursor?: string } = {}) {
  const partner = await getPartner(id);
  const wallet = await findWalletFor({ kind: 'PRINT_PARTNER', id: partner.id });
  const limit = Math.min(query.limit ?? 100, 200);
  const [balances, entries, withdrawals, jobs, jobCounts, invoices] = await Promise.all([
    wallet ? snapshot(wallet.id) : null,
    wallet ? listEntries(wallet.id, { limit, ...(query.cursor ? { cursor: query.cursor } : {}) }) : [],
    wallet ? listWithdrawals({ walletId: wallet.id, limit: 50 }) : [],
    repository.listJobsForPartner(partner.id, limit),
    repository.countJobsForPartner(partner.id),
    // Lot H: the invoices the partner uploaded for ADX, newest first.
    listPartnerInvoices(partner),
  ]);
  return {
    partner,
    walletId: wallet?.id ?? null,
    balances,
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: money(entry.amount),
      balanceAfter: money(entry.balanceAfter),
      orderId: entry.orderId,
      reference: entry.reference,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
    withdrawals,
    jobs,
    jobCounts: Object.fromEntries(jobCounts.map((row) => [row.status, row.count])),
    invoices,
  };
}
