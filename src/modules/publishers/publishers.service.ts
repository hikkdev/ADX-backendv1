import type { Request } from 'express';
import { onboardingFactsOf, type OnboardingFacts } from '../../shared/onboarding';
import type { Gender, OnboardingSource } from '../../shared/database';
import { dateOfBirthToDate, dateOfBirthToString, normalizeMobile } from '../../shared/validation';
import { settleOnboardingIfReady } from './onboarding/publisher-onboarding.service';
import { ApiError } from '../../shared/errors';
import { allocateIdentifier } from '../identifiers';
import { kycUserLabels } from '../kyc';
import { withCityKey } from '../pricing';
import { createNotification } from '../notifications';
import { initiateDigioKyc } from './kyc/digio.service';
import {
  assertResubmissionCarriesDocuments,
  clearReviewsForResubmission,
  kycCaseDetail,
  kycReviewsFor,
  pinKycManifest,
  reviewKyc as reviewKycAtDesk,
  splitKycSubmission,
} from './kyc/kyc-desk.service';
import type { KycStatus, PartySizeBand } from '../../shared/database';
import { prismaPublishersRepository as repository } from './prisma-publishers.repository';
import { logActivity } from '../../shared/audit';
import { slaAge } from '../../shared/time';
import { KYC_QUEUE_STATES, deriveKycState, kycStateCounts, kycSummaryOf, type KycQueueState } from '../../shared/kyc-state';
import { toListPage } from '../../shared/pagination';
import type { PublisherRosterQuery } from './publishers.schema';
import { getPlatformSettings } from '../app-config';
import { assertAgentMayWrite, assertAgentOwnsPublisher } from './publishers.policy';
import type {
  KycDocuments,
  NewPublisher,
  PublisherPatch,
  KycQueueFilter,
  KycQueueRowWithSla,
} from './publishers.repository';

/**
 * QR-13: the person's fields the desk may send beside the publisher's — as
 * the app's `PATCH /users/me` would take them.
 */
export type DeskPerson = { firstName?: string; lastName?: string; dateOfBirth?: string; gender?: Gender };

/** The four basics the readiness rule counts — with them in, the account opens complete. */
function basicsIn(row: { name: string | null; email: string | null; address: string | null }, dateOfBirth: Date | string | null | undefined): boolean {
  return Boolean(row.name && row.email && row.address && dateOfBirth);
}

/**
 * QR-14: the stamp, with the person named — what the detail read and the
 * roster answer as `onboarding`. One name lookup for a page of rows.
 */
export async function withOnboardingFacts<T extends { onboardedVia: OnboardingSource | null; onboardedById: string | null; onboardedByRole: string | null; onboardedAt: Date | null }>(
  rows: T[],
): Promise<(T & { onboarding: OnboardingFacts })[]> {
  const ids = rows.map((r) => r.onboardedById).filter((id): id is string => Boolean(id));
  // No stamp names anyone (a page of self-signups, or rows older than QR-14): nothing to look up.
  const names = ids.length > 0 ? await repository.userLabels(ids) : new Map<string, string | null>();
  // A row read without the stamp columns (an older fixture, a narrow select) is left as it is.
  return rows.map((row) =>
    'onboardedVia' in row ? { ...row, onboarding: onboardingFactsOf(row, row.onboardedById ? (names.get(row.onboardedById) ?? null) : null) } : (row as T & { onboarding: OnboardingFacts }),
  );
}

export async function createPublisher(data: NewPublisher & DeskPerson) {
  // Allocated here rather than in the repository so every creation path goes
  // through one place, and so the repository stays pure data access.
  const displayId = await allocateIdentifier('PUBLISHER');
  const { firstName, lastName, dateOfBirth, gender, ...publisher } = data;
  // QR-13: the same number the OTP door canonicalises to, so the account the
  // desk opens is the one the person signs in as.
  const mobile = normalizeMobile(publisher.mobile);
  let userId: string | undefined;
  if (firstName !== undefined) {
    // A desk onboarding: open (or adopt) the account first, so the sign-in
    // lands on the publisher's home with nothing left to ask.
    const account = await repository.ensureAccount({
      mobile,
      displayId: await allocateIdentifier('USER'),
      name: `${firstName} ${lastName ?? ''}`.trim(),
      ...(publisher.email !== undefined ? { email: publisher.email } : {}),
      firstName,
      ...(lastName !== undefined ? { lastName } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
      ...(gender !== undefined ? { gender } : {}),
    });
    userId = account.id;
  }
  const complete = userId !== undefined && basicsIn({ name: publisher.name, email: publisher.email ?? null, address: publisher.address ?? null }, dateOfBirth);
  // Lot X-B: the city key rides with the typed city (null for a town the catalogue lacks).
  return repository.create(
    await withCityKey({
      ...publisher,
      mobile,
      displayId,
      ...(userId !== undefined ? { userId } : {}),
      // QR-13: with every basic in, the onboarding is done the day the desk does it — the
      // app's readiness card agrees, and the agreement row shows rather than the setup prompt.
      ...(complete ? { onboardingStatus: 'ONBOARDING_COMPLETE' as const, activatedAt: new Date() } : {}),
    }),
  );
}

/**
 * QR-13: the desk's edit — everything the ladder collects, the person's
 * fields written to their account. A publisher with no account yet who is
 * given a first name gets one opened, the way the desk onboarding does.
 */
/** AG-5: the band is ADX's judgement, set from the desk alone — the withdrawal ladder and the agent grade both read it. */
export async function setPublisherBand(publisherId: string, adminId: string, sizeBand: PartySizeBand, req?: Request) {
  const publisher = await repository.findById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  const updated = await repository.update(publisherId, { sizeBand });
  await logActivity(adminId, 'PUBLISHER_BAND_SET', { req, targetType: 'Publisher', targetId: publisherId, module: 'publishers', metadata: { from: publisher.sizeBand, to: sizeBand } });
  return updated;
}

export async function updatePublisherAtDesk(publisherId: string, adminId: string, input: PublisherPatch & DeskPerson) {
  const publisher = await repository.findById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  const { firstName, lastName, dateOfBirth, gender, ...patch } = input;
  const person = {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirthToDate(dateOfBirth) } : {}),
    ...(gender !== undefined ? { gender } : {}),
  };
  let userId = publisher.userId as string | null;
  if (Object.keys(person).length > 0 || patch.email !== undefined) {
    if (userId) {
      // The detail include selects the person's names (QR-13); the repository's row type predates them.
      const held = publisher.user as { firstName?: string | null; lastName?: string | null } | null;
      const name = firstName !== undefined || lastName !== undefined
        ? `${firstName ?? held?.firstName ?? ''} ${lastName ?? held?.lastName ?? ''}`.trim()
        : undefined;
      await repository.updateAccount(userId, { ...person, ...(name ? { name } : {}), ...(patch.email !== undefined ? { email: patch.email } : {}) });
    } else if (firstName !== undefined) {
      const account = await repository.ensureAccount({
        mobile: normalizeMobile(publisher.mobile),
        displayId: await allocateIdentifier('USER'),
        name: `${firstName} ${lastName ?? ''}`.trim(),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...person,
      });
      userId = account.id;
      await repository.attachUser(publisherId, userId);
    }
  }
  const updated = await repository.update(publisherId, await withCityKey(patch));
  await settleOnboardingIfReady(publisherId);
  await logActivity(adminId, 'PUBLISHER_UPDATED_BY_ADMIN', undefined, { publisherId, fields: Object.keys(input) });
  return updated;
}

export async function getPublishersForAgent(agentId: string, category?: string) {
  return repository.findForAgent(agentId, category);
}

/** The whole roster, for ADX. An agent gets their own list from the same route. E10-1: `q` narrows it. */
export async function getAllPublishers(category?: string, q?: string) {
  return repository.findAllForAdmin(category, q);
}

/** E10-1: the roster on the list contract — `{ items, total, page, pageSize, counts }`, the chips by KYC status. */
export async function getPublisherRoster(query: PublisherRosterQuery) {
  const { items, total, counts } = await repository.findRosterPage(query);
  // QR-14: the roster names who onboarded each row.
  return toListPage(await withOnboardingFacts(items as never[]), total, counts, query);
}

/**
 * Loads a publisher the calling agent owns, with its KYC and listings.
 *
 * Unknown publisher is 404; someone else's publisher is 403 — both inherited,
 * see publishers.policy.
 */
/**
 * One publisher, for somebody entitled to read them.
 *
 * The ownership rule is the agent's: they see the publishers they onboarded
 * and no others. ADX is not an agent and never will be, so an `isAdmin` caller
 * skips the check rather than failing it — without this, ops was refused from
 * its own console and `/publishers/[id]` 403'd in live mode.
 */
export async function getOwnedPublisher(
  publisherId: string,
  userId: string,
  options: { isAdmin?: boolean } = {},
) {
  const publisher = await repository.findById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!options.isAdmin) await assertAgentOwnsPublisher(userId, publisher.agentId);
  // Lot F: the KYC row carries the desk's per-document decisions — the same
  // rows the manifest's partial mode draws — so the agent's capture screen
  // can light the flagged tiles on the on-behalf read.
  // N3-B: `kyc` also carries `state` and `kycId`, derived the way the queue
  // derives them, so the party page and the queue agree; a publisher with no
  // record yet (none today — the row is made with the account) answers the
  // six-column summary with `state` AWAITING_DOCUMENTS.
  const summary = kycSummaryOf(publisher.kyc, publisher.kycStatus);
  const kyc = publisher.kyc ? { ...publisher.kyc, ...(await kycReviewsFor(publisher.kyc)), state: summary.state, kycId: summary.kycId } : { ...summary, status: null };
  // QR-14: who onboarded them, named.
  const [stamped] = await withOnboardingFacts([publisher]);
  return withDetailFacts({ ...stamped!, kyc });
}

/**
 * E6: the two facts the console's suspend dialog and account banner asked
 * for — `user { closedAt, closeReason } | null` (null when no account backs
 * the profile yet) and `openOrders`, the non-terminal orders across the
 * publisher's listings, which is what STOP_OPEN_WORK would cancel.
 */
type PersonRow = { displayId?: string | null; firstName?: string | null; lastName?: string | null; dateOfBirth?: Date | null; gender?: string | null; avatarUrl?: string | null; consentAcceptedAt?: Date | null };
export type DetailPerson = { displayId: string | null; firstName: string | null; lastName: string | null; dateOfBirth: string | null; gender: string | null; avatarUrl: string | null; consentAcceptedAt: Date | null };

export function withDetailFacts<T extends { listings?: { _count?: { orders: number } }[]; user?: ({ closedAt: Date | null; closeReason: string | null } & PersonRow) | null }>(
  publisher: T,
): T & { user: { closedAt: Date | null; closeReason: string | null } | null; person: DetailPerson | null; openOrders: number } {
  const openOrders = (publisher.listings ?? []).reduce((sum, listing) => sum + (listing._count?.orders ?? 0), 0);
  const user = publisher.user ? { closedAt: publisher.user.closedAt, closeReason: publisher.user.closeReason } : null;
  // QR-13: the person behind the account, for the desk's Edit details drawer.
  const person: DetailPerson | null = publisher.user && 'firstName' in publisher.user
    ? {
        displayId: publisher.user.displayId ?? null,
        firstName: publisher.user.firstName ?? null,
        lastName: publisher.user.lastName ?? null,
        dateOfBirth: dateOfBirthToString(publisher.user.dateOfBirth ?? null),
        gender: publisher.user.gender ?? null,
        avatarUrl: publisher.user.avatarUrl ?? null,
        consentAcceptedAt: publisher.user.consentAcceptedAt ?? null,
      }
    : null;
  return { ...publisher, user, ...(person ? { person } : {}), openOrders } as never;
}

/**
 * Lot B (Q13): read by `invoices`. The publisher behind a session, for
 * `POST /publishers/me/invoices`; and the billing facts a payment advice
 * prints — name, GSTIN, state — for one publisher id. Neither joins.
 */
export const findPublisherForUser = (userId: string) => repository.findByUserId(userId);

/**
 * E7-3: `{ id, userId, displayId, name, kycStatus }` per login that has a
 * publisher profile, in one query — for the support and dispute desks, which
 * name the party behind a user id and reach it through the ports bootstrap
 * fills.
 */
export const findPublisherLabelsForUsers = (userIds: readonly string[]) =>
  repository.findLabelsByUserIds([...new Set(userIds)]);

/** K-B1: `{ id, label, displayId }` per publisher id, one query — the QR desk's ref column. */
export const findPublisherLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

export async function findPublisherBilling(publisherId: string): Promise<{
  id: string;
  userId: string | null;
  name: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
} | null> {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) return null;
  return {
    id: publisher.id,
    userId: publisher.userId,
    name: publisher.name,
    gstin: publisher.gstin,
    address: publisher.address,
    city: publisher.city,
    state: publisher.state,
  };
}

/**
 * Lot J (B2): for `payments` — who a publisher's gateway order names (the
 * prefill on the checkout page, the customer the adapter is given) and the
 * login its payment notices go to. Contact facts only; nothing about KYC or
 * the roster.
 */
export async function findPublisherContact(publisherId: string): Promise<{
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  mobile: string;
} | null> {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) return null;
  return { id: publisher.id, userId: publisher.userId, name: publisher.name, email: publisher.email, mobile: publisher.mobile };
}

/** Same check without the joins, for endpoints that only need to authorise. */
export async function assertOwnedPublisher(publisherId: string, userId: string) {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  await assertAgentOwnsPublisher(userId, publisher.agentId);
  return publisher;
}

export async function updatePublisher(
  publisherId: string,
  userId: string,
  data: PublisherPatch,
) {
  const publisher = await getOwnedPublisher(publisherId, userId);
  const { grantId } = await assertAgentMayWrite(userId, publisher);
  const updated = await repository.update(publisherId, await withCityKey(data));
  // Every write under a grant carries the grant id.
  await logActivity(userId, 'PUBLISHER_UPDATED_UNDER_GRANT', undefined, {
    publisherId,
    grantId,
    fields: Object.keys(data),
  });
  return updated;
}

export async function submitKyc(publisherId: string, userId: string, input: KycDocuments & { manifestVersion?: number | undefined }) {
  const publisher = await getOwnedPublisher(publisherId, userId);
  const { grantId } = await assertAgentMayWrite(userId, publisher);
  const { docs, manifestVersion } = splitKycSubmission(input);
  // E9: the same rule as the publisher's own route — nothing attached, nothing written.
  assertResubmissionCarriesDocuments(publisher.kyc, Object.keys(docs));
  // Lot N: the agent's hand on the row — who recorded it, and how.
  const kyc = await repository.submitKyc(publisherId, docs, { recordedById: userId, recordedVia: 'AGENT', method: 'MANUAL' });
  // Lot F: the manifest version is pinned at the first submission, never moved.
  await pinKycManifest(publisherId, manifestVersion);
  // Lot D (Q42): whatever was decided about the fields sent no longer applies.
  await clearReviewsForResubmission(kyc, Object.keys(docs));
  await logActivity(userId, 'PUBLISHER_KYC_SUBMITTED_UNDER_GRANT', undefined, {
    publisherId,
    grantId,
    fields: Object.keys(docs),
  });
  return kyc;
}

/** Admin review — no agent-ownership check, unlike submission. */
/* ── D7: the ADMIN KYC queue ──────────────────────────────────────────────── */

/**
 * Every publisher whose documents are in, oldest first, with who brought
 * them. Self-onboarded publishers (DR 08) arrive with no agent at all and
 * were invisible to ops until this: every other publisher list on the API is
 * an agent's own. N3-B (the owner, 14 Sep 2026): the queue lists PARTIES —
 * every publisher not yet verified plus every publisher with a record —
 * each row carrying its `state` (AWAITING_DOCUMENTS from the moment the
 * account exists, then REQUESTED / PENDING / NEEDS_INFO / REJECTED /
 * VERIFIED) and `kycId`; `counts` is publishers per state over the filter
 * with the state facet removed, beside `escalated` and `requested`.
 */
export async function listKycQueue(filter: KycQueueFilter & { assignedTo?: 'me' | 'none'; viewerUserId?: string }, now = new Date()) {
  const { reviewSlaHours } = (await getPlatformSettings()).kyc;
  // Lot D: `assignedTo` is the query's word, `assignedToId` the column's; a
  // stuck Digio case is one initiated more than a day ago with no webhook.
  const { assignedTo, viewerUserId, ...rest } = filter;
  const repoFilter: KycQueueFilter = {
    ...rest,
    ...(assignedTo === 'me' && viewerUserId ? { assignedToId: viewerUserId } : assignedTo === 'none' ? { assignedToId: null } : {}),
    ...(rest.digioStatus === 'stuck' ? { stuckBefore: new Date(now.getTime() - DIGIO_STUCK_AFTER_MS) } : {}),
  };
  const rows = await repository.findKycQueue(repoFilter);

  // E10-1: the assignee by name beside the id — one lookup for the queue,
  // through the label port `kyc` holds (bootstrap fills it from `users`).
  // G11-1: the escalation's two people ride the same lookup; Lot N: so do
  // who requested the KYC and who recorded it.
  const labels = await kycUserLabels(
    rows.flatMap((row) => [row.kyc?.assignedToId, row.kyc?.escalatedToUserId, row.kyc?.escalatedById, row.kyc?.requestedById, row.kyc?.recordedById]),
  );
  const label = (id: string | null | undefined) => (id ? labels.get(id) ?? { id, name: null } : null);
  const items: KycQueueRowWithSla[] = rows.map((row) => ({
    ...row,
    state: deriveKycState(row.kyc, row.kycStatus),
    kycId: row.kyc?.id ?? null,
    // The clock runs only while the case is PENDING — a party with nothing in has no age.
    ...slaAge(row.kyc?.status === 'PENDING' ? (row.kyc.submittedAt ?? null) : null, reviewSlaHours, now),
    assignedTo: label(row.kyc?.assignedToId),
    escalatedTo: label(row.kyc?.escalatedToUserId),
    escalatedBy: label(row.kyc?.escalatedById),
    requestedBy: label(row.kyc?.requestedById),
    recordedBy: label(row.kyc?.recordedById),
  }));

  // With no sort asked for, the queue is "what needs me now": everything past
  // the SLA first, each half still oldest-submission-first. A named sort is
  // the reviewer saying they want the plain order instead, so it is left
  // exactly as the repository returned it.
  if (!filter.sort) {
    items.sort((a, b) => Number(b.slaBreached) - Number(a.slaBreached));
  }

  // Lot G (Q127/142): the escalated, counted across the queue with the
  // escalated facet removed, so the chip still reads while it is applied.
  const escalated =
    filter.escalated === undefined
      ? items.filter((item) => item.kyc?.escalatedAt).length
      : (await repository.findKycQueue({ ...repoFilter, escalated: true })).length;

  // Lot N: the requested — the desk's asks with nothing submitted yet —
  // counted with that facet forced on, whatever facet the queue is on:
  // those rows are outside the submitted queue, so they are never among
  // `items` unless the facet is applied.
  const requested = await repository.countKycQueue({ ...repoFilter, requested: true, state: undefined, status: undefined });

  // N3-B: the chips — publishers per state over the filter with the state facet (and its aliases) removed.
  const stateBase: KycQueueFilter = { ...repoFilter, state: undefined, status: undefined, requested: undefined };
  const stateCounts = Object.fromEntries(
    await Promise.all(KYC_QUEUE_STATES.map(async (state) => [state, await repository.countKycQueue({ ...stateBase, state })] as const)),
  ) as Record<KycQueueState, number>;

  return {
    items,
    total: items.length,
    breached: items.filter((item) => item.slaBreached).length,
    escalated,
    requested,
    counts: { ...kycStateCounts(stateCounts), escalated, requested },
    slaHours: reviewSlaHours,
  };
}

/** One case for the workbench: the publisher, its documents and every decision on them, its agent, the liveness video. */
export const getKycCase = (publisherId: string) => kycCaseDetail(publisherId);

/** Lot D (Q129): a Digio case with no webhook after this long is `stuck` on the queue. */
export const DIGIO_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The decision. Lot D moved its body to `kyc/kyc-desk.service.ts` — who
 * decided, what they said, the liveness gate, the notification, the audit
 * row — and this is the same door it always was.
 */
export async function reviewKyc(
  publisherId: string,
  status: KycStatus,
  rejectionReason: string | undefined,
  reviewer: { userId: string; note?: string | null; req?: Request },
) {
  return reviewKycAtDesk(publisherId, status, rejectionReason, reviewer);
}

/**
 * The desk restarts a publisher's Digio check.
 *
 * The one thing ops could not do with a Digio case was operate it: a check
 * that lapsed, was cancelled, or came back rejected for a reason the
 * publisher can fix left the desk with only the manual override. This asks
 * Digio for a fresh session on the publisher's own row — the same request
 * their phone makes — records who asked, and tells the publisher to open
 * the app and finish it. A verified publisher has nothing to restart.
 */
export async function restartDigioKyc(publisherId: string, byUserId: string, req?: Request) {
  const publisher = await repository.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (publisher.kycStatus === 'VERIFIED') {
    throw new ApiError(409, 'CONFLICT', 'This publisher is already verified; there is nothing to restart');
  }
  const session = await initiateDigioKyc(publisherId, publisher.name, publisher.email ?? '', publisher.mobile);
  await logActivity(byUserId, 'PUBLISHER_KYC_DIGIO_RESTARTED', req, { publisherId, kycId: session.kycId });
  if (publisher.userId) {
    await createNotification({
      userId: publisher.userId,
      type: 'KYC',
      title: 'Finish your Digio check',
      subtitle: publisher.name,
      message: 'ADX has started a fresh Digio identity check for you. Open the app and finish it — it takes about a minute.',
      relatedId: publisherId,
      relatedType: 'PUBLISHER',
    });
  }
  return { kycId: session.kycId, validTill: session.validTill, digioStatus: 'pending' as const, notified: Boolean(publisher.userId) };
}

export async function getOnboardingStatus(publisherId: string, userId: string) {
  const publisher = await getOwnedPublisher(publisherId, userId);
  return {
    kycStatus: publisher.kycStatus,
    listingsCount: publisher.listings.length,
    kycDocuments: publisher.kyc,
  };
}
