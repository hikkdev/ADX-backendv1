import { randomUUID } from 'node:crypto';
import { onboardingFactsOf, type OnboardingFacts } from '../../shared/onboarding';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money } from '../../shared/money';
import { dateOfBirthToDate, dateOfBirthToString, normalizeMobile } from '../../shared/validation';
import type {
  Advertiser,
  AgreementKind,
  Brand,
  Gender,
  KycStatus,
  RefundDestination,
  RefundReason,
  TopUpMethod,
  WalletRefundRequest,
  WalletTopUp,
} from '../../shared/database';
import type { ListQuery, PageQuery } from '../../shared/pagination';
import { kycSummaryOf, type KycSummary } from '../../shared/kyc-state';
import { findAgentTier } from '../agents';
import { acceptInsertionOrder as recordInsertionOrder, isCurrentAcceptance } from '../agreements';
import { allocateIdentifier } from '../identifiers';
import { platformAccount, post as postLedger } from '../ledger';
import { findPayoutMethod, recordIncentiveOnce } from '../payouts';
import { withCityKey } from '../pricing';
import { findWallet, move } from '../wallets';
import { prismaAdvertisersRepository as repository } from './prisma-advertisers.repository';
import type { AdvertiserRosterQuery, CreateAdvertiserInput, Money, PersonRow, RefundRequestDeskRow, TopUpDeskQuery, WalletSnapshot } from './advertisers.repository';

/**
 * The demand-side lifecycle. Specification: docs/advertiser-onboarding.md.
 *
 * Deliberately shaped like the supply module: gates counted the same way,
 * agreements through the same table, money held rather than debited. Where a
 * decision could have gone either way, it went the way the publisher side
 * already goes.
 */

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export const ADVERTISER_PLATFORM: AgreementKind = 'ADVERTISER_PLATFORM';

/**
 * Gate 2. A company needs a company name; a private individual is already
 * named by the account, so requiring one of them would be a form that cannot
 * be completed.
 *
 * The equivalent SQL predicate lives in `prisma-advertisers.repository.ts`
 * funnel(). The two must agree — if this changes, change that.
 */
export function isProfileComplete(advertiser: Advertiser): boolean {
  if (!advertiser.billingAddress || !advertiser.city) return false;
  return advertiser.type === 'INDIVIDUAL' || Boolean(advertiser.companyName);
}

export type BookingEligibility = {
  eligible: boolean;
  /**
   * Every unmet BOOKING gate, not just the first, so the app can show the
   * whole path. SUSPENDED is Lot A's BLOCK_NEW: nothing new starts until it
   * is lifted. QR-16: KYC is no longer among these — it gates the launch.
   */
  blockedBy: Array<'SUSPENDED' | 'PROFILE' | 'KYC' | 'AGREEMENT' | 'FUNDS'>;
  /**
   * QR-16 (the owner, 17 Sep 2026): what stops a PAID campaign from going
   * live. An unverified advertiser browses, fills a cart and pays; the
   * campaign stays SCHEDULED until KYC — identity, and the business
   * documents for a business — is verified, and the lifecycle tick launches
   * it then. Today the one entry is KYC.
   */
  launchBlockedBy: Array<'KYC'>;
  wallet: WalletSnapshot | null;
};

/**
 * Gates 2, 4 and 5 for the booking, gate 3 for the launch, evaluated together.
 *
 * `amount` is optional: without it this answers "can this advertiser book at
 * all", with it, "can they afford this campaign".
 */
export async function bookingEligibility(
  advertiserId: string,
  amount?: Money
): Promise<BookingEligibility> {
  const advertiser = await getAdvertiser(advertiserId);
  const [acceptance, template, wallet] = await Promise.all([
    repository.findAcceptance(advertiserId, ADVERTISER_PLATFORM),
    repository.activeTemplate(ADVERTISER_PLATFORM),
    repository.walletSnapshot(advertiserId),
  ]);

  const blockedBy: BookingEligibility['blockedBy'] = [];
  if ((advertiser.suspensionScopes ?? []).includes('BLOCK_NEW')) blockedBy.push('SUSPENDED');
  if (!isProfileComplete(advertiser)) blockedBy.push('PROFILE');
  // QR-16: verification holds the launch, not the booking — see `launchBlockedBy`.
  const launchBlockedBy: BookingEligibility['launchBlockedBy'] = advertiser.kycStatus === 'VERIFIED' ? [] : ['KYC'];
  // Lot D (Q55): any acceptance clears the gate unless the live version says
  // `requiresReacceptance` — then it has to be the live version. One rule,
  // owned by `agreements`, applied here rather than restated.
  if (!isCurrentAcceptance(acceptance, template)) blockedBy.push('AGREEMENT');

  const spendable = wallet ? Number(wallet.spendable) : 0;
  const needed = amount ? Number(amount) : 0;
  if (spendable <= 0 || spendable < needed) blockedBy.push('FUNDS');

  return { eligible: blockedBy.length === 0, blockedBy, launchBlockedBy, wallet };
}

/**
 * Lot A BLOCK_NEW on its own, for the paths that must refuse a suspended
 * account without also demanding KYC, an agreement or funds — an admin
 * recording a bank transfer that has already arrived, say. Nothing new starts
 * for a suspended advertiser, and activating a plan is something new starting.
 */
export async function assertNotSuspended(advertiserId: string): Promise<void> {
  const advertiser = await getAdvertiser(advertiserId);
  if ((advertiser.suspensionScopes ?? []).includes('BLOCK_NEW')) {
    throw new ApiError(409, 'ADVERTISER_SUSPENDED', 'This advertiser account is suspended');
  }
}

/**
 * Throws the code the app routes on rather than a generic conflict, so the
 * client can send the advertiser to KYC, the agreement or top-up without
 * parsing a message.
 */
export async function assertCanBook(advertiserId: string, amount?: Money): Promise<BookingEligibility> {
  const eligibility = await bookingEligibility(advertiserId, amount);
  const { eligible, blockedBy } = eligibility;
  if (eligible) return eligibility;

  // Lot A BLOCK_NEW, checked ahead of the ordinary gates: an account ADX has
  // suspended is not sent to KYC or top-up, it is told it is suspended.
  if (blockedBy.includes('SUSPENDED')) {
    throw new ApiError(409, 'ADVERTISER_SUSPENDED', 'This advertiser account is suspended and cannot book');
  }
  if (blockedBy.includes('PROFILE')) {
    throw new ApiError(409, 'CONFLICT', 'Complete the advertiser profile before booking');
  }
  // QR-16: KYC no longer refuses a booking — it holds the launch (`launchBlockedBy`).
  if (blockedBy.includes('AGREEMENT')) {
    throw new ApiError(
      403,
      'PLATFORM_AGREEMENT_REQUIRED',
      'Accept the current advertiser platform agreement before booking'
    );
  }
  throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Wallet balance does not cover this campaign');
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export async function getAdvertiser(id: string): Promise<Advertiser> {
  const advertiser = await repository.findAdvertiserById(id);
  if (!advertiser) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
  return advertiser;
}

/** N3-B: the profile by its id, or null — for the KYC desk's `:id` resolution (row id → profile id → user id). */
export function findAdvertiser(id: string): Promise<Advertiser | null> {
  return repository.findAdvertiserById(id);
}

/**
 * E6: `GET /advertisers/:id` — the profile plus `user { closedAt,
 * closeReason } | null`. Null means no account backs the profile yet (an
 * agent holding it open); an open account answers `{ closedAt: null,
 * closeReason: null }`, so the console can tell the two apart. N3-B: and
 * `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }`,
 * derived the way the queue derives it, so the party page and the queue agree.
 */
export async function getAdvertiserDetail(
  id: string,
): Promise<Advertiser & { user: { closedAt: Date | null; closeReason: string | null } | null; kyc: KycSummary; onboarding: OnboardingFacts; person: DetailPerson | null }> {
  const advertiser = await getAdvertiser(id);
  const [user, record, held] = await Promise.all([
    advertiser.userId ? repository.findUserClosure(advertiser.userId) : Promise.resolve(null),
    repository.findKycSummary(advertiser.id, advertiser.userId),
    // QR-15: the person behind the account, for the desk's Edit details drawer.
    advertiser.userId ? repository.findUserPerson(advertiser.userId) : Promise.resolve(null),
  ]);
  // QR-14: who onboarded them, named.
  const byName = advertiser.onboardedById ? await repository.findUserLabel(advertiser.onboardedById) : null;
  return {
    ...advertiser,
    user: user ? { closedAt: user.closedAt, closeReason: user.closeReason } : null,
    kyc: kycSummaryOf(record, advertiser.kycStatus),
    onboarding: onboardingFactsOf(advertiser, byName),
    person: personOf(held),
  };
}

/** QR-15: the person's fields as the console reads them — the date of birth as YYYY-MM-DD. */
export type DetailPerson = {
  displayId: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  avatarUrl: string | null;
  consentAcceptedAt: Date | null;
};

function personOf(held: PersonRow | null | undefined): DetailPerson | null {
  if (!held) return null;
  return {
    displayId: held.displayId ?? null,
    firstName: held.firstName ?? null,
    lastName: held.lastName ?? null,
    dateOfBirth: dateOfBirthToString(held.dateOfBirth ?? null),
    gender: held.gender ?? null,
    avatarUrl: held.avatarUrl ?? null,
    consentAcceptedAt: held.consentAcceptedAt ?? null,
  };
}

/**
 * QR-14/15: the roster names who onboarded each row — `onboarding { via,
 * viaLabel, byId, byName, byRole, at }` — with one name lookup for the page.
 * A row read without the stamp columns (an older fixture, a narrow select)
 * is left as it is.
 */
async function withOnboardingFacts<T extends { onboardedById?: string | null }>(rows: T[]): Promise<(T & { onboarding?: OnboardingFacts })[]> {
  const ids = rows.map((r) => r.onboardedById).filter((id): id is string => Boolean(id));
  const names = ids.length > 0 ? await repository.userLabels(ids) : new Map<string, string | null>();
  return rows.map((row) =>
    'onboardedVia' in row ? { ...row, onboarding: onboardingFactsOf(row as never, row.onboardedById ? (names.get(row.onboardedById) ?? null) : null) } : row,
  );
}

/**
 * The signed-in user's own advertiser profile, or null.
 *
 * Null rather than 404: a User who has signed in but not registered as an
 * advertiser is an ordinary state the app routes on, not an error.
 */
export function getAdvertiserForUser(userId: string): Promise<Advertiser | null> {
  return repository.findAdvertiserByUserId(userId);
}

/**
 * E7-3: `{ id, userId, displayId, name, kycStatus }` per login that has an
 * advertiser profile, in one query — for the support and dispute desks,
 * composed into their ports by bootstrap.
 */
export const findAdvertiserLabelsForUsers = (userIds: readonly string[]) =>
  repository.findAdvertiserLabelsByUserIds([...new Set(userIds)]);

/** K-B1: `{ id, label, displayId }` per advertiser id, one query — the QR desk's ref column. */
export const findAdvertiserLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

/**
 * QR-15: the person behind the account, as the desk (or an import) sends
 * them. Given a first name, `registerAdvertiser` opens (or adopts) the
 * sign-in account for the number up front — the owner's first sign-in is
 * OTP → terms → home, and the profile gate finds its answers already in.
 */
export type DeskPerson = { firstName?: string; lastName?: string; dateOfBirth?: string; gender?: Gender };

export type RegisterInput = Omit<CreateAdvertiserInput, 'displayId' | 'mobile'> & {
  mobile?: string;
} & DeskPerson;

/**
 * Gate 1, and the only place an advertiser identifier is issued.
 *
 * A wallet is created immediately rather than lazily at first top-up, so that
 * "has no wallet" never has to mean two different things. A non-agency account
 * also gets its single brand here: campaigns belong to a brand, and a direct
 * advertiser should not have to invent one before they can book.
 */
export async function registerAdvertiser(input: RegisterInput): Promise<Advertiser> {
  const { firstName, lastName, dateOfBirth, gender, ...rest } = input;
  // A self-serve signup takes the number from the session, never from the
  // request: the caller proved they hold it by signing in with an OTP, and
  // trusting the body would let anyone open an account against someone else's
  // number. An agent opening an account for a third party supplies it instead,
  // because there is no session belonging to that person yet. QR-15: the
  // number is canonicalised the way the OTP door does it, so the account the
  // desk opens is the one the person later signs in as — one row, not two.
  const mobile = rest.userId
    ? await repository.findUserMobile(rest.userId)
    : rest.mobile
      ? normalizeMobile(rest.mobile)
      : null;

  if (!mobile) {
    throw new ApiError(400, 'BAD_REQUEST', 'A mobile number is required');
  }

  const existing = await repository.findAdvertiserByMobile(mobile);
  if (existing) {
    // An account an agent opened for this number at the door, before its owner
    // ever signed in — and this is that owner arriving. Link it; the wallet and
    // brand were made when the agent opened it.
    if (rest.userId && existing.userId === null) {
      return repository.attachUser(existing.id, rest.userId);
    }
    throw new ApiError(409, 'CONFLICT', 'An advertiser with this mobile already exists');
  }

  // QR-15: a desk onboarding names the person — open (or adopt) their account
  // first, so the sign-in lands on the advertiser's home with nothing to ask.
  let userId = rest.userId ?? null;
  if (userId === null && firstName !== undefined) {
    const account = await repository.ensureAccount({
      mobile,
      displayId: await allocateIdentifier('USER'),
      name: `${firstName} ${lastName ?? ''}`.trim(),
      ...(rest.email ? { email: rest.email } : {}),
      firstName,
      ...(lastName !== undefined ? { lastName } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
      ...(gender !== undefined ? { gender } : {}),
    });
    userId = account.id;
  }

  const displayId = await allocateIdentifier('ADVERTISER');
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  const advertiser = await repository.createAdvertiser(await withCityKey({ ...rest, mobile, displayId, userId }));

  await repository.ensureWallet(advertiser.id);

  if (advertiser.type !== 'AGENCY') {
    await repository.createBrand({
      advertiserId: advertiser.id,
      name: advertiser.companyName ?? advertiser.name,
    });
  }

  return advertiser;
}

/**
 * Gate 2. QR-15: the person's own columns (the names, the date of birth,
 * the gender) go to the account behind the profile, and the email with
 * them; a profile nobody has claimed that the desk gives a first name gets
 * its account opened and linked, the way a fresh onboarding does.
 */
export async function updateProfile(
  id: string,
  patch: Parameters<typeof repository.updateAdvertiser>[1] & DeskPerson
): Promise<Advertiser> {
  const advertiser = await getAdvertiser(id);
  // kycStatus and activatedAt are outcomes of review and acceptance, never of
  // someone editing their own profile.
  const { kycStatus: _kyc, activatedAt: _activated, firstName, lastName, dateOfBirth, gender, ...safe } = patch;
  const person = {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
    ...(gender !== undefined ? { gender } : {}),
  };
  if (Object.keys(person).length > 0 || safe.email) {
    if (advertiser.userId) {
      const held = await repository.findUserPerson(advertiser.userId);
      const name = firstName !== undefined || lastName !== undefined
        ? `${firstName ?? held?.firstName ?? ''} ${lastName ?? held?.lastName ?? ''}`.trim()
        : undefined;
      await repository.updateAccount(advertiser.userId, { ...person, ...(name ? { name } : {}), ...(safe.email ? { email: safe.email } : {}) });
    } else if (firstName !== undefined) {
      const account = await repository.ensureAccount({
        mobile: normalizeMobile(advertiser.mobile),
        displayId: await allocateIdentifier('USER'),
        name: `${firstName} ${lastName ?? ''}`.trim(),
        ...(safe.email ? { email: safe.email } : {}),
        ...person,
      });
      await repository.attachUser(id, account.id);
    }
  }
  return repository.updateAdvertiser(id, await withCityKey(safe));
}

/**
 * Gate 3, called by the KYC module when a case is decided.
 *
 * Activation is attempted on the way through: an advertiser who signed the
 * agreement while KYC was pending becomes active the moment it clears, without
 * anyone having to notice. N3-B: the KYC record's status is mirrored onto
 * `Advertiser.kycStatus` on EVERY status write — PENDING at a submission,
 * NEEDS_INFO at a re-upload ask, VERIFIED / REJECTED at the decision — so the
 * roster, the queue and the booking gate read one thing; only VERIFIED can
 * activate.
 */
export async function applyKycDecision(
  advertiserId: string,
  status: KycStatus
): Promise<Activated> {
  await getAdvertiser(advertiserId);
  const updated = await repository.updateAdvertiser(advertiserId, { kycStatus: status });
  return maybeActivate(updated);
}

/**
 * The same decision, arriving from the KYC module for a record that knows
 * the advertiser only as a `User` (a legacy row with no profile key).
 *
 * Returns null rather than throwing when no profile row exists: a User may
 * carry the ADVERTISER role without one — accounts predating this model, or a
 * KYC case opened before registration — and a KYC review must not fail because
 * of it.
 */
export async function applyKycDecisionByUserId(
  userId: string,
  status: KycStatus
): Promise<Activated | null> {
  const advertiser = await repository.findAdvertiserByUserId(userId);
  if (!advertiser) return null;
  return applyKycDecision(advertiser.id, status);
}

/**
 * Lot B (Q101): what the completion answers with beside the advertiser —
 * the ADVERTISER_ONBOARDED commission recorded for the attributed agent, or
 * null when nothing was recorded on this call.
 */
export type OnboardingIncentive = { id: string; amount: Money } | null;
export type Activated = Advertiser & { incentive: OnboardingIncentive };

/**
 * The advertiser-side twin of the publisher's onboarding commission (Q101).
 * Paid whenever the account carries an agent — the attribution, not whoever
 * pressed the last button. Once per advertiser, at the agent's tier,
 * PENDING_VERIFICATION. A rate that cannot be priced never stops an
 * activation.
 */
async function recordOnboardingCommission(advertiser: Advertiser): Promise<OnboardingIncentive> {
  if (!advertiser.agentId) return null;
  try {
    const tier = (await findAgentTier(advertiser.agentId)) ?? '*';
    const incentive = await recordIncentiveOnce({
      agentId: advertiser.agentId,
      event: 'ADVERTISER_ONBOARDED',
      tier,
      advertiserId: advertiser.id,
      note: `Onboarded ${advertiser.displayId ?? advertiser.id}: ${advertiser.companyName ?? advertiser.name}`,
      // Lot F: the agent's INCENTIVE_RECORDED notice names the account.
      notice: { partyName: advertiser.companyName ?? advertiser.name },
    });
    return { id: incentive.id, amount: money(incentive.amount) };
  } catch (err) {
    logger.warn('Onboarding commission was not recorded', { advertiserId: advertiser.id, err });
    return null;
  }
}

/** KYC verified and the platform agreement accepted. Idempotent. */
async function maybeActivate(advertiser: Advertiser): Promise<Activated> {
  if (advertiser.activatedAt || advertiser.kycStatus !== 'VERIFIED') return { ...advertiser, incentive: null };

  const acceptance = await repository.findAcceptance(advertiser.id, ADVERTISER_PLATFORM);
  if (!acceptance) return { ...advertiser, incentive: null };

  const activated = await repository.updateAdvertiser(advertiser.id, { activatedAt: new Date() });
  return { ...activated, incentive: await recordOnboardingCommission(activated) };
}

/** The roster; E7-3: `q` searches name / company / email / mobile / displayId beside the cursor page. */
export const listAdvertisers = async (query: AdvertiserRosterQuery) => {
  const page = await repository.listAdvertisers(query);
  // QR-14/15: the roster names who onboarded each row, one lookup for the page.
  const rows = (page as { rows?: Advertiser[] }).rows;
  return rows ? { ...page, rows: await withOnboardingFacts(rows) } : page;
};

/**
 * The accounts an agent holds.
 *
 * Scoped by the agent profile behind the session rather than by an id in the
 * query, so an agent cannot read somebody else's book by changing a parameter.
 */
export const listAdvertisersForAgent = (agentId: string) =>
  repository.findAdvertisersForAgent(agentId);
export const advertiserFunnel = () => repository.funnel();
export const advertiserFunnelRows = (query: PageQuery) => repository.funnelRows(query);

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

export type AcceptanceContext = {
  acceptedByUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Gate 4.
 *
 * KYC first: the platform agreement is signed by a verified party or it is
 * signed by nobody in particular. This is the same ordering the publisher side
 * enforces.
 */
export async function acceptPlatformAgreement(
  advertiserId: string,
  ctx: AcceptanceContext
): Promise<Activated> {
  const advertiser = await getAdvertiser(advertiserId);

  // QR-16 (the owner, 17 Sep 2026): the agreement is the advertiser's own
  // click and may come before the verification — an unverified advertiser
  // books and pays; only the launch waits. `maybeActivate` still needs both.

  // Lot D (Q55): the newest click stands unless a live version demands
  // re-acceptance and the click was on an older one — then a new row is
  // written for the live version. A second click on the same version does
  // nothing.
  const [existing, template] = await Promise.all([
    repository.findAcceptance(advertiserId, ADVERTISER_PLATFORM),
    repository.activeTemplate(ADVERTISER_PLATFORM),
  ]);
  if (existing && (existing.templateId === template?.id || isCurrentAcceptance(existing, template))) {
    return { ...advertiser, incentive: null };
  }

  if (!template) {
    throw new ApiError(503, 'NO_ACTIVE_TEMPLATE', 'No advertiser platform agreement is published');
  }

  await repository.createAcceptance({
    templateId: template.id,
    templateKind: ADVERTISER_PLATFORM,
    templateVersion: template.version,
    advertiserId,
    acceptedByUserId: ctx.acceptedByUserId,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return maybeActivate(advertiser);
}

/**
 * The insertion order for one campaign — Lot D (Q123).
 *
 * The document is rendered by `agreements` from the live INSERTION_ORDER
 * template and the campaign's spots as they stand, never from text the client
 * sent, and it checks the campaign is this advertiser's. One acceptance per
 * campaign per template version; `checkout.authorizeCampaign` refuses until
 * the live version has been accepted. The platform agreement comes first,
 * because an insertion order under no platform terms binds nothing.
 */
export async function acceptInsertionOrder(
  advertiserId: string,
  campaignId: string,
  ctx: AcceptanceContext
): Promise<{ accepted: true; templateVersion: number; acceptanceId: string }> {
  await getAdvertiser(advertiserId);

  const [platform, template] = await Promise.all([
    repository.findAcceptance(advertiserId, ADVERTISER_PLATFORM),
    repository.activeTemplate(ADVERTISER_PLATFORM),
  ]);
  if (!isCurrentAcceptance(platform, template)) {
    throw new ApiError(
      403,
      'PLATFORM_AGREEMENT_REQUIRED',
      'Accept the platform agreement before an insertion order'
    );
  }

  return recordInsertionOrder(campaignId, advertiserId, ctx);
}

/* ------------------------------------------------------------------ */
/* Brands                                                              */
/* ------------------------------------------------------------------ */

export async function createBrand(
  advertiserId: string,
  input: { name: string; sector?: Brand['sector']; logoUrl?: string | null; website?: string | null }
): Promise<Brand> {
  await getAdvertiser(advertiserId);
  return repository.createBrand({ advertiserId, ...input });
}

export async function listBrands(advertiserId: string): Promise<Brand[]> {
  await getAdvertiser(advertiserId);
  return repository.listBrands(advertiserId);
}

export async function updateBrand(
  brandId: string,
  patch: Parameters<typeof repository.updateBrand>[1]
): Promise<Brand> {
  const brand = await repository.findBrandById(brandId);
  if (!brand) throw new ApiError(404, 'NOT_FOUND', 'Brand not found');
  return repository.updateBrand(brandId, patch);
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */

export async function getWallet(advertiserId: string): Promise<WalletSnapshot> {
  await getAdvertiser(advertiserId);
  const snapshot = await repository.walletSnapshot(advertiserId);
  if (snapshot) return snapshot;

  await repository.ensureWallet(advertiserId);
  const created = await repository.walletSnapshot(advertiserId);
  if (!created) throw new ApiError(500, 'INTERNAL_ERROR', 'Wallet could not be created');
  return created;
}

export const walletStatement = (advertiserId: string, query: PageQuery) =>
  repository.listWalletEntries(advertiserId, query);

/**
 * The name the ledger gives an advertiser's wallet account, opened on first
 * movement. Kept short: it is a label on a statement, not the record.
 */
const walletLabel = (advertiser: Advertiser) =>
  `${advertiser.companyName ?? advertiser.name} · advertiser`;

/**
 * How the cash side of an advertiser wallet is booked (Lot B, Q30/Q36).
 *
 * Every movement below pairs the wallet leg with ADX's own account, so
 * `verifyLedger` covers advertiser wallets as it already covered publishers.
 * Credits are positive, debits negative, from the account's own point of view:
 *
 *   TOPUP           wallet +          platform:suspense −   until the bank line is matched
 *                                     platform:cash −       for a GATEWAY settlement
 *   CAMPAIGN_SPEND  wallet −          platform:payables +   the whole booking, held for
 *                                                           the publishers; ADX's take is
 *                                                           recognised day by day, when
 *                                                           the accrual splits each day's
 *                                                           gross into net, commission and
 *                                                           tax (payouts/accrual.service)
 *   PACKAGE_SPEND   wallet −          platform:revenue +    ADX's own product, earned at sale
 *   GOODWILL        wallet + (goodwill) platform:goodwill −   an apology with a balance
 *   REFUND          wallet +          platform:payables −   unused media given back
 *   EXPIRY          wallet −          platform:revenue +    breakage
 *
 * The capture is booked entirely to payables rather than split at once,
 * because the revenue model resolves commission per booking *and the accrual
 * already posts it*; splitting at capture as well would count it twice, and
 * a refund of unused days can then come straight back out of payables.
 */

export type TopUpInput = {
  amount: Money;
  method: TopUpMethod;
  /** The bank's UTR for a transfer; the cheque number for a cheque. */
  utr?: string | null;
  receivedAt: Date;
  /** Which ADX bank account it landed in, for reconciliation. */
  bankAccountId?: string | null;
  proofFileId?: string | null;
  /** The gateway's own payment id; required for GATEWAY. */
  paymentId?: string | null;
  note?: string | null;
};

export type TopUpOutcome = {
  topUp: WalletTopUp;
  wallet: WalletSnapshot;
  /** False when the same transfer had already been recorded. */
  created: boolean;
};

/**
 * Ops records money that arrived outside ADX — a transfer with its UTR, a
 * cheque — and the wallet is credited with its double-entry twin against
 * suspense, where it waits for the bank line that proves it (Q41/Q118).
 *
 * Idempotent on the transfer, not on a clock: the same UTR on the same wallet
 * is one top-up however many times it is submitted, and answers 409 so the
 * second person learns it was already done rather than seeing a silent
 * success that credited nothing.
 */
export async function topUp(
  advertiserId: string,
  input: TopUpInput,
  recordedByUserId: string
): Promise<TopUpOutcome> {
  const advertiser = await getAdvertiser(advertiserId);
  assertPositive(input.amount);
  if (input.method === 'BANK_TRANSFER' && !input.utr?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A bank transfer needs its UTR.');
  }
  if (input.method === 'GATEWAY' && !input.paymentId?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A gateway top-up needs the payment id.');
  }

  const wallet = await repository.ensureWallet(advertiserId);
  const utr = input.utr?.trim() || null;
  const paymentId = input.paymentId?.trim() || null;

  const idempotencyKey =
    input.method === 'GATEWAY'
      ? `topup:gateway:${paymentId}`
      : utr
        ? `topup:${wallet.id}:${input.method.toLowerCase()}:${utr}`
        : // A cheque with no number: the day and the amount are the best identity there is.
          `topup:${wallet.id}:cheque:${input.receivedAt.toISOString().slice(0, 10)}:${money(input.amount)}`;

  const result = await move({
    walletId: wallet.id,
    walletLabel: walletLabel(advertiser),
    amount: money(input.amount),
    entryType: 'TOPUP',
    ledgerKind: 'TOPUP',
    idempotencyKey,
    // A gateway settlement is cash ADX holds; a transfer is a claim until the
    // bank statement matches it, and lives in suspense until then.
    counterLegs: [
      {
        accountCode: input.method === 'GATEWAY' ? 'platform:cash' : 'platform:suspense',
        amount: money(new Decimal(input.amount).negated()),
        note: input.method === 'GATEWAY' ? 'Gateway settlement' : `${input.method === 'CHEQUE' ? 'Cheque' : 'Bank transfer'} awaiting reconciliation`,
      },
    ],
    reference: utr ?? paymentId,
    note: input.note ?? null,
    occurredAt: input.receivedAt,
    createdByUserId: recordedByUserId,
  });
  if (!result) throw new ApiError(500, 'INTERNAL_ERROR', 'Wallet could not be credited');

  if (!result.created) {
    // The movement already happened. Bank transfers and cheques are recorded
    // by a person, so tell them; a gateway replays its webhooks, so answer it
    // with the top-up it already made.
    if (input.method !== 'GATEWAY') {
      throw new ApiError(409, 'CONFLICT', 'This transfer has already been recorded on this wallet', {
        reference: utr ?? null,
      });
    }
    const seen = paymentId ? await repository.findTopUpByPayment(paymentId) : null;
    if (seen) return { topUp: seen, wallet: await getWallet(advertiserId), created: false };
  }

  const topUpRow = await repository.createTopUp({
    walletId: wallet.id,
    amount: money(input.amount),
    method: input.method,
    utr,
    receivedAt: input.receivedAt,
    bankAccountId: input.bankAccountId ?? null,
    proofFileId: input.proofFileId ?? null,
    paymentId,
    note: input.note ?? null,
    recordedByUserId,
    walletEntryId: result.entry?.id ?? null,
    ledgerTransactionId: result.ledgerTransactionId,
    reconciledAt: input.method === 'GATEWAY' ? input.receivedAt : null,
  });

  return { topUp: topUpRow, wallet: await getWallet(advertiserId), created: result.created };
}

/**
 * Lot C's door: the payment gateway confirms a settlement and this credits
 * the wallet against cash. A service function rather than the route on
 * purpose — the route requires a method and a person; the gateway has a
 * webhook and a payment id, and its retries must land once.
 */
export function recordGatewayTopUp(
  advertiserId: string,
  input: { amount: Money; paymentId: string; receivedAt: Date; note?: string | null },
  recordedByUserId: string
): Promise<TopUpOutcome> {
  return topUp(
    advertiserId,
    { amount: input.amount, method: 'GATEWAY', paymentId: input.paymentId, receivedAt: input.receivedAt, note: input.note ?? null },
    recordedByUserId
  );
}

export const listTopUps = (advertiserId: string, query: PageQuery) =>
  repository.listTopUps(advertiserId, query);

/** E6: `GET /finance/top-ups` — the register, money as decimal strings. */
export async function listTopUpsPage(query: TopUpDeskQuery) {
  const page = await repository.listTopUpsPage(query);
  return { ...page, items: page.items.map((row) => ({ ...row, amount: money(row.amount) })) };
}

/** Lot C (Q110): for `payments` — the request a gateway refund is paying. */
export const findRefundRequest = (requestId: string): Promise<RefundRequestDeskRow | null> =>
  repository.findRefundRequest(requestId);

/**
 * Lot B (Q85): for `reconciliation`. A top-up by id, by the UTR the bank
 * line carries, or by the gateway's payment id; and the stamp that says a
 * bank line now explains it (null to take the stamp back on unmatch).
 */
export const findTopUp = (id: string) => repository.findTopUp(id);
export const findTopUpByUtr = (utr: string) => repository.findTopUpByUtr(utr.trim());
export const findTopUpByPaymentId = (paymentId: string) => repository.findTopUpByPayment(paymentId.trim());
export const markTopUpReconciled = (id: string, at: Date | null) => repository.markTopUpReconciled(id, at);

/**
 * Step 1 of the money path: confirmation places a hold.
 *
 * Every gate is checked here rather than at capture, because a campaign that
 * cannot be paid for should fail while the advertiser is still looking at it,
 * not on the morning it was due to go live.
 */
export async function holdForCampaign(
  advertiserId: string,
  campaignId: string,
  amount: Money
): Promise<{ holdId: string }> {
  assertPositive(amount);
  const { wallet } = await assertCanBook(advertiserId, amount);
  assertWalletNotFrozen(wallet);

  const hold = await repository.placeHold({ advertiserId, campaignId, amount });
  if (!hold) {
    throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Wallet balance does not cover this campaign');
  }
  return { holdId: hold.id };
}

/**
 * Pays for a package out of the advertiser's wallet.
 *
 * Every gate a booking passes applies here too — an account that may not book
 * may not buy a plan either. The funds check itself is made again inside the
 * movement, on the row being debited, so two taps cannot both spend the same
 * balance. Idempotent on the sale.
 */
export async function payForPackage(
  advertiserId: string,
  saleId: string,
  amount: Money,
  note: string
): Promise<{ paid: boolean }> {
  assertPositive(amount);
  const advertiser = await getAdvertiser(advertiserId);
  const { wallet } = await assertCanBook(advertiserId, amount);
  assertWalletNotFrozen(wallet);
  const row = await repository.ensureWallet(advertiserId);

  const result = await move({
    walletId: row.id,
    walletLabel: walletLabel(advertiser),
    amount: money(new Decimal(amount).negated()),
    entryType: 'PACKAGE_DEBIT',
    ledgerKind: 'PACKAGE_SPEND',
    idempotencyKey: `package-debit:${saleId}`,
    spendGoodwillFirst: true,
    requireFunds: true,
    counterLegs: [{ accountCode: 'platform:revenue', amount: money(amount), note: 'Package sale' }],
    reference: saleId,
    note,
  });
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  return { paid: true };
}

/**
 * Step 2: the campaign starts and the hold becomes a debit. Idempotent.
 *
 * Goodwill is spent before settled balance, the hold is marked CAPTURED and
 * the CAMPAIGN_SPEND legs are posted — all in the one movement, which is also
 * where a frozen wallet is refused (Lot A: a freeze stops every debit, and a
 * capture is one).
 */
export async function captureCampaignHold(holdId: string): Promise<{ captured: boolean }> {
  const hold = await repository.findHoldById(holdId);
  if (!hold) throw new ApiError(404, 'NOT_FOUND', 'Hold not found');
  if (hold.status === 'CAPTURED') return { captured: true };
  if (hold.status === 'RELEASED') {
    throw new ApiError(409, 'CONFLICT', 'This hold was released and cannot be captured');
  }

  const wallet = await findWallet(hold.walletId);
  if (!wallet?.advertiserId) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  const advertiser = await getAdvertiser(wallet.advertiserId);

  const result = await move({
    walletId: hold.walletId,
    walletLabel: walletLabel(advertiser),
    amount: money(new Decimal(hold.amount).negated()),
    entryType: 'CAMPAIGN_DEBIT',
    ledgerKind: 'CAMPAIGN_SPEND',
    idempotencyKey: `campaign-capture:${hold.id}`,
    spendGoodwillFirst: true,
    captureHoldId: hold.id,
    campaignId: hold.campaignId,
    counterLegs: [
      {
        accountCode: 'platform:payables',
        amount: money(hold.amount),
        note: 'Booked media, owed to publishers as it is delivered',
      },
    ],
    note: 'Campaign started',
  });
  return { captured: result !== null };
}

/** Cancelled before it started. A release, never a refund. Idempotent. */
export async function releaseCampaignHold(holdId: string): Promise<{ released: boolean }> {
  const hold = await repository.findHoldById(holdId);
  if (!hold) throw new ApiError(404, 'NOT_FOUND', 'Hold not found');
  if (hold.status === 'RELEASED') return { released: true };
  if (hold.status === 'CAPTURED') {
    throw new ApiError(409, 'CONFLICT', 'This hold was already captured');
  }

  const released = await repository.releaseHold(holdId);
  return { released: released !== null };
}

/**
 * Where the supply-side enforcement ladder pays out.
 *
 * A publisher whose verification lapsed mid-campaign forfeits the daily earning
 * to the advertiser; this is the receiving end. Split across several affected
 * advertisers in the ratio of what each paid — the caller does the split, this
 * credits one share.
 *
 * `idempotencyKey` is the caller's: a lapse is `(campaign, day)`, and a
 * retried sweep must credit it once. An admin issuing one by hand has no
 * natural key, so a fresh one is minted and a double tap is two credits —
 * which is what the audit row is for.
 */
export async function creditGoodwill(
  advertiserId: string,
  amount: Money,
  campaignId?: string | null,
  note?: string | null,
  options: { idempotencyKey?: string; byUserId?: string | null } = {}
): Promise<WalletSnapshot> {
  const advertiser = await getAdvertiser(advertiserId);
  assertPositive(amount);
  const wallet = await repository.ensureWallet(advertiserId);

  const result = await move({
    walletId: wallet.id,
    walletLabel: walletLabel(advertiser),
    amount: money(amount),
    entryType: 'GOODWILL_CREDIT',
    ledgerKind: 'GOODWILL',
    idempotencyKey: options.idempotencyKey ?? `goodwill:${wallet.id}:${randomUUID()}`,
    isGoodwill: true,
    campaignId: campaignId ?? null,
    counterLegs: [
      {
        accountCode: 'platform:goodwill',
        amount: money(new Decimal(amount).negated()),
        note: 'Goodwill issued',
      },
    ],
    note: note ?? 'Goodwill credit for a lapsed listing',
    createdByUserId: options.byUserId ?? null,
  });
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  return getWallet(advertiserId);
}

/**
 * The refund desk releasing a campaign's unused value back to the wallet
 * (Lot B, Q41). Called by `campaigns` once finance has decided; the money
 * comes back out of payables, where the capture put it. A credit, so it lands
 * on a frozen wallet too — the advertiser is owed it either way.
 */
export async function creditCampaignRefund(input: {
  advertiserId: string;
  campaignId: string;
  campaignRefundId: string;
  amount: Money;
  note: string;
  byUserId: string;
}): Promise<{ ledgerTransactionId: string; walletEntryId: string | null; created: boolean }> {
  const advertiser = await getAdvertiser(input.advertiserId);
  assertPositive(input.amount);
  const wallet = await repository.ensureWallet(input.advertiserId);

  const result = await move({
    walletId: wallet.id,
    walletLabel: walletLabel(advertiser),
    amount: money(input.amount),
    entryType: 'REFUND',
    ledgerKind: 'REFUND',
    idempotencyKey: `campaign-refund:${input.campaignRefundId}`,
    campaignId: input.campaignId,
    counterLegs: [
      {
        accountCode: 'platform:payables',
        amount: money(new Decimal(input.amount).negated()),
        note: 'Unused media released back to the advertiser',
      },
    ],
    reference: input.campaignRefundId,
    note: input.note,
    createdByUserId: input.byUserId,
  });
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  return {
    ledgerTransactionId: result.ledgerTransactionId,
    walletEntryId: result.entry?.id ?? null,
    created: result.created,
  };
}


/*
 * Agreement templates are written by the `agreements` module alone (Lot D):
 * the legacy GET/POST /advertisers/agreements/templates pair, which published
 * and activated in one step without stamping `activatedAt`, is retired — the
 * console uses /agreements/templates.
 */

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

/**
 * A refund is support-mediated and admin-approved, never self-service. The
 * advertiser wallet holds credit for future bookings; a refund is the exception
 * to that, and the whole path is described in the platform agreement so the
 * posture is one the advertiser accepted rather than discovered.
 */

export const refundableAmount = (advertiserId: string) =>
  repository.refundableAmount(advertiserId);

export const listRefundRequests = (
  query: PageQuery,
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'PAID' | 'FAILED'
) => repository.listRefundRequests(query, status);

/**
 * The desk's queue, on the list contract (Lot B). E6: every row carries
 * `advertiser { id, displayId, name }` and its money as a decimal string.
 */
export const listRefundRequestsPage = async (query: ListQuery & { advertiserId?: string | undefined }) => {
  const page = await repository.listRefundRequestsPage(query);
  return { ...page, items: page.items.map((row) => ({ ...row, amount: money(row.amount) })) };
};

/**
 * E6: `GET /advertisers/:id/wallet/refund-requests` — the advertiser's own
 * requests (the owner, or their agent under a live grant), on the list
 * contract. The same rows the desk sees, scoped to the one wallet.
 */
export const listAdvertiserRefundRequests = (advertiserId: string, query: ListQuery) =>
  listRefundRequestsPage({ ...query, advertiserId });

export type RefundRequestInput = {
  amount: Money;
  reason: RefundReason;
  note: string;
  ticketId?: string | null;
  /**
   * Lot B (Q41): where the money goes. Wallet credit is the default and needs
   * nothing more; cash out — a bank transfer, or a return to the card it came
   * from — needs the consumer's recorded agreement, because that is the
   * consumer-protection line: ADX may prefer credit, but may not impose it.
   */
  destination?: RefundDestination;
  consentNote?: string | null;
  /** The VERIFIED payout method a BANK_TRANSFER goes to. */
  payoutMethodId?: string | null;
};

/** Raised by support on the advertiser's behalf. Freezes the amount. */
export async function requestRefund(
  advertiserId: string,
  input: RefundRequestInput,
  raisedByUserId: string
): Promise<WalletRefundRequest> {
  const advertiser = await getAdvertiser(advertiserId);
  assertPositive(input.amount);

  const destination = input.destination ?? 'WALLET_CREDIT';
  const consentNote = input.consentNote?.trim() || null;
  if (destination !== 'WALLET_CREDIT' && !consentNote) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'A refund paid out in cash needs the advertiser\'s recorded consent (consentNote).'
    );
  }
  // Lot C (Q110): back to the card or UPI it came from — only when a captured
  // gateway payment with enough left exists to return it to. `payments`
  // answers through the port and does the return once the desk approves.
  if (destination === 'ORIGINAL_METHOD') {
    const refundable = originalMethodRefund ? await originalMethodRefund.refundable(advertiserId, money(input.amount)) : false;
    if (!refundable) {
      throw new ApiError(
        409,
        'GATEWAY_NOT_CONFIGURED',
        originalMethodRefund
          ? 'This advertiser has no captured gateway payment with enough left to return this amount to. Use a bank transfer.'
          : 'Refunds to the original payment method need the payment gateway, which is not configured yet. Use a bank transfer.'
      );
    }
  }

  let payoutMethodId: string | null = null;
  if (destination === 'BANK_TRANSFER') {
    if (!input.payoutMethodId) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A bank transfer needs the payout method to send to.');
    }
    const method = await findPayoutMethod(input.payoutMethodId);
    // Somebody else's method reads as missing, never as forbidden.
    if (!method || !advertiser.userId || method.userId !== advertiser.userId) {
      throw new ApiError(404, 'NOT_FOUND', 'Payout method not found');
    }
    if (method.status !== 'VERIFIED') {
      throw new ApiError(400, 'BAD_REQUEST', 'That payout method has not been verified yet.');
    }
    payoutMethodId = method.id;
  }

  // One open request at a time. Two would each hold their own slice of the
  // same balance and the second could never be honoured in full.
  const open = await repository.findOpenRefundRequest(advertiserId);
  if (open) {
    throw new ApiError(409, 'CONFLICT', 'This wallet already has a refund request open');
  }

  const cap = await repository.refundableAmount(advertiserId);
  if (Number(input.amount) > Number(cap)) {
    throw new ApiError(
      422,
      'BAD_REQUEST',
      `At most ${cap} can be refunded: settled balance less open holds, capped at what was paid in`
    );
  }

  const request = await repository.createRefundRequest({
    advertiserId,
    amount: input.amount,
    reason: input.reason,
    note: input.note,
    ticketId: input.ticketId ?? null,
    raisedByUserId,
    destination,
    consentNote,
    payoutMethodId,
  });
  if (!request) {
    throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'The wallet no longer covers this refund');
  }
  return request;
}

/**
 * Approved or rejected by an admin.
 *
 * The decider may not be the raiser. There is no distinct support role on the
 * API yet — support staff and approvers are both ADMIN — so four-eyes is
 * enforced on the user rather than the role. That is a weaker control than a
 * capability check and should be replaced by one, but it is not nothing: it
 * stops one person moving money out on their own say-so.
 *
 * What approval does depends on the destination (Lot B):
 *   WALLET_CREDIT   the hold is released and the money stays spendable —
 *                   the request records that ADX answered with credit;
 *   BANK_TRANSFER   the hold becomes a REFUND debit through `wallets.move`
 *                   (wallet − / payables +) and the request waits APPROVED
 *                   for finance to pay it and record the UTR;
 *   ORIGINAL_METHOD the same REFUND debit as a bank transfer (Lot C, Q110);
 *                   the request waits APPROVED for finance to send it back
 *                   through `POST /payments/:id/refund { refundRequestId }`,
 *                   which marks it PAID with the gateway's refund id.
 */
export async function decideRefund(
  requestId: string,
  approve: boolean,
  decidedByUserId: string,
  decisionNote?: string
): Promise<WalletRefundRequest> {
  const request = await repository.findRefundRequest(requestId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Refund request not found');
  if (request.status !== 'PENDING') {
    throw new ApiError(409, 'CONFLICT', `This request is already ${request.status.toLowerCase()}`);
  }
  if (request.raisedByUserId === decidedByUserId) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'A refund must be approved by someone other than the person who raised it'
    );
  }

  if (!approve || request.destination === 'WALLET_CREDIT') {
    const decided = await repository.decideRefundRequest({
      requestId,
      status: approve ? 'APPROVED' : 'REJECTED',
      hold: 'RELEASE',
      decidedByUserId,
      decisionNote: decisionNote ?? null,
    });
    if (!decided) throw new ApiError(409, 'CONFLICT', 'This request was decided by someone else');
    return decided;
  }

  // BANK_TRANSFER and ORIGINAL_METHOD: the frozen amount leaves the wallet
  // now, as a REFUND debit owed to the advertiser until finance pays it.
  // Through `move`, so a frozen wallet refuses it and the books get their
  // legs in the same act.
  const wallet = await findWallet(request.walletId);
  if (!wallet?.advertiserId) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  const advertiser = await getAdvertiser(wallet.advertiserId);

  const result = await move({
    walletId: request.walletId,
    walletLabel: walletLabel(advertiser),
    amount: money(new Decimal(request.amount).negated()),
    entryType: 'REFUND',
    ledgerKind: 'REFUND',
    idempotencyKey: `refund:${request.id}`,
    captureHoldId: request.holdId,
    counterLegs: [
      { accountCode: 'platform:payables', amount: money(request.amount), note: 'Refund owed to the advertiser' },
    ],
    reference: request.id,
    note: decisionNote ?? request.note,
    createdByUserId: decidedByUserId,
  });
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');

  const decided = await repository.decideRefundRequest({
    requestId,
    status: 'APPROVED',
    hold: 'LEAVE',
    decidedByUserId,
    decisionNote: decisionNote ?? null,
    ledgerTransactionId: result.ledgerTransactionId,
  });
  if (!decided) throw new ApiError(409, 'CONFLICT', 'This request was decided by someone else');
  return decided;
}

/**
 * Finance paid the transfer and has the UTR the bank line will show.
 *
 * The obligation is discharged against cash: payables − / cash +. No wallet
 * leg — the wallet was debited at approval — so this posts to the ledger
 * directly, keyed on the request.
 */
export async function markRefundPaid(
  requestId: string,
  input: { railReference: string; byUserId: string },
  now = new Date()
): Promise<RefundRequestDeskRow> {
  const railReference = input.railReference.trim();
  if (!railReference) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A payment needs its UTR or transfer reference.');
  }
  const request = await repository.findRefundRequest(requestId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Refund request not found');
  if (request.status === 'PAID') return request;
  if (request.status !== 'APPROVED' || request.destination === 'WALLET_CREDIT') {
    throw new ApiError(409, 'CONFLICT', 'Only an approved bank-transfer or original-method refund can be marked paid.');
  }

  const amount = money(request.amount);
  const [payables, cash] = await Promise.all([
    platformAccountId('platform:payables'),
    platformAccountId('platform:cash'),
  ]);
  const { transaction } = await postLedger(
    {
      kind: 'REFUND',
      idempotencyKey: `refund-paid:${request.id}`,
      legs: [
        { accountId: payables, amount: money(new Decimal(amount).negated()), reference: request.id, note: 'Refund paid' },
        { accountId: cash, amount, reference: request.id, note: `Refund paid, UTR ${railReference}` },
      ],
      occurredAt: now,
      createdByUserId: input.byUserId,
      note: `Refund ${request.id} paid`,
    },
    now
  );

  return repository.updateRefundRequest(requestId, {
    status: 'PAID',
    paidAt: now,
    paidByUserId: input.byUserId,
    // Lot C: a return through the gateway is not a payout rail; the gateway's
    // refund id is the reference and the rail stays unset.
    rail: request.destination === 'ORIGINAL_METHOD' ? request.rail : (request.rail ?? 'MANUAL_NEFT'),
    railReference,
    ledgerTransactionId: request.ledgerTransactionId ?? transaction.id,
  });
}

/**
 * The transfer bounced. The money goes back where it came from.
 *
 * A fresh movement rather than an edit: the approval's REFUND debit stays on
 * the record and this returns the balance (wallet + / payables −), keyed on
 * the request so a retried click returns it once. Written as a REFUND credit
 * so the paid-in cap `refundableAmount` reads counts it back in.
 */
export async function failRefund(
  requestId: string,
  input: { reason: string; byUserId: string },
  now = new Date()
): Promise<RefundRequestDeskRow> {
  const reason = input.reason.trim();
  if (!reason) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the transfer failed.');
  const request = await repository.findRefundRequest(requestId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Refund request not found');
  if (request.status === 'FAILED') return request;
  if (request.status !== 'APPROVED' || request.destination === 'WALLET_CREDIT') {
    throw new ApiError(409, 'CONFLICT', 'Only an approved bank-transfer or original-method refund in flight can fail.');
  }

  const wallet = await findWallet(request.walletId);
  if (!wallet?.advertiserId) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  const advertiser = await getAdvertiser(wallet.advertiserId);

  await move({
    walletId: request.walletId,
    walletLabel: walletLabel(advertiser),
    amount: money(request.amount),
    entryType: 'REFUND',
    ledgerKind: 'ADJUSTMENT',
    idempotencyKey: `refund-failed:${request.id}`,
    counterLegs: [
      { accountCode: 'platform:payables', amount: money(new Decimal(request.amount).negated()), note: 'Refund returned' },
    ],
    reference: request.id,
    note: `Refund ${request.id} failed: ${reason}`,
    createdByUserId: input.byUserId,
    occurredAt: now,
  });

  return repository.updateRefundRequest(requestId, {
    status: 'FAILED',
    decisionNote: [request.decisionNote, `Failed: ${reason}`].filter(Boolean).join(' — '),
  });
}

/** Support pulling its own request back before anyone decided. */
export async function withdrawRefund(requestId: string): Promise<WalletRefundRequest> {
  const withdrawn = await repository.withdrawRefundRequest(requestId);
  if (!withdrawn) {
    throw new ApiError(409, 'CONFLICT', 'Only an open request can be withdrawn');
  }
  return withdrawn;
}

/* ------------------------------------------------------------------ */
/* Dormancy                                                            */
/* ------------------------------------------------------------------ */

/** Credit lapses after this long with no movement in either direction. */
export const CREDIT_DORMANCY_MONTHS = 12;

/**
 * Expires credit on wallets that have seen no activity for the dormancy window.
 *
 * The clock runs from the last movement, not from the age of each individual credit: any
 * top-up or spend resets it for the whole balance. That is the reading the
 * agreement describes, and the one that does not punish an active advertiser
 * for an old deposit.
 *
 * Idempotent — an expired wallet has nothing left to expire, and its activity
 * stamp is reset so it is not reconsidered on the next sweep.
 */
export async function expireDormantCredit(
  now = new Date(),
  batchSize = 500
): Promise<{ expired: number }> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - CREDIT_DORMANCY_MONTHS);
  const due = await repository.findDormantWallets(cutoff, batchSize);

  let expired = 0;
  for (const wallet of due) {
    const total = new Decimal(wallet.balance).plus(wallet.goodwill);
    if (total.lessThanOrEqualTo(0)) continue;
    const advertiser = await repository.findAdvertiserById(wallet.advertiserId);
    if (!advertiser) continue;

    try {
      // One movement per wallet rather than one for the batch: a sweep that
      // fails halfway should leave the wallets it already settled alone.
      // Goodwill first, then balance — the debit takes everything, and the
      // day in the key makes a re-run of the same sweep a no-op.
      const result = await move({
        walletId: wallet.id,
        walletLabel: walletLabel(advertiser),
        amount: money(total.negated()),
        entryType: 'EXPIRY',
        ledgerKind: 'EXPIRY',
        idempotencyKey: `expiry:${wallet.id}:${now.toISOString().slice(0, 10)}`,
        spendGoodwillFirst: true,
        counterLegs: [{ accountCode: 'platform:revenue', amount: money(total), note: 'Expired credit' }],
        note: `Credit expired after ${CREDIT_DORMANCY_MONTHS} months without activity`,
        occurredAt: now,
      });
      if (result?.created) expired += 1;
    } catch (error) {
      // A frozen wallet is under review; its credit waits for the outcome
      // rather than lapsing underneath it.
      if (error instanceof ApiError && error.code === 'WALLET_FROZEN') {
        logger.info('Dormant credit left on a frozen wallet', { walletId: wallet.id });
        continue;
      }
      throw error;
    }
  }

  return { expired };
}

/**
 * Lot A FREEZE_WALLET, checked explicitly on the two paths that take money out
 * of an advertiser wallet — a hold and a package debit — rather than trusted
 * to the funds check, which would report a frozen wallet as merely short.
 */
function assertWalletNotFrozen(wallet: WalletSnapshot | null): void {
  if (wallet?.frozenAt) {
    throw new ApiError(409, 'WALLET_FROZEN', 'This wallet is frozen; money cannot leave it', {
      frozenAt: wallet.frozenAt,
    });
  }
}

/** A platform account's id, for the one posting here that has no wallet leg. */
const platformAccountId = async (code: 'platform:payables' | 'platform:cash'): Promise<string> =>
  (await platformAccount(code)).id;

/**
 * Lot C (Q110): whether a refund can go back to the original payment method
 * — i.e. the advertiser has a captured gateway payment with enough left to
 * return. Answered by `payments`, which cannot be imported here (it reads
 * this module for the wallet), so bootstrap registers it. Unregistered, the
 * answer is "no" and ORIGINAL_METHOD keeps refusing 409 GATEWAY_NOT_CONFIGURED.
 */
export type OriginalMethodRefundPort = {
  refundable(advertiserId: string, amount: Money): Promise<boolean>;
};

let originalMethodRefund: OriginalMethodRefundPort | null = null;

export function registerOriginalMethodRefundPort(port: OriginalMethodRefundPort | null): void {
  originalMethodRefund = port;
}

function assertPositive(amount: Money): void {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Amount must be greater than zero');
  }
}
