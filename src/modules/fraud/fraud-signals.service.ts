import type { FraudCase } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { getPlatformSettings } from '../app-config';
import { createNotification } from '../notifications';
import { listAdminUserIds } from '../users';
import { findWalletFor } from '../wallets';
import { openOrderExposureFor, type OpenOrderScope } from '../orders';
import { Decimal, money, ZERO, type Money } from '../../shared/money';
import { prismaFraudRepository as repository } from './prisma-fraud.repository';
import { prismaFraudSignalsIndex as index } from './prisma-fraud-signals.repository';
import { openCaseRecord, type Actor } from './fraud.service';
import { SIGNAL_SCAN_KIND, type FraudSubjectType } from './fraud.schema';
import { cleanCandidates, evaluateSignals, foldLinks, FRAUD_SIGNALS, type LinkedAccount, type LinkedParty, type ResolvedSubject, type StoredSignal } from './signals';

/**
 * Fraud signals and the score — Lot G (Q118/138).
 *
 * A signal is one computed fact about a party (`signals/`), scored 0..1 and
 * weighted; the score is `min(1, Σ weight × value)`. It is explainable —
 * every signal carries a line of detail and, where it ties the party to
 * another account, who — and it is never acted on alone: the desk scores a
 * case on demand, the console can scan a party with no case, the nightly
 * job opens a case (kind SIGNAL_SCAN) when a signal runs hot and none is
 * open, and a person decides. Nothing here suspends.
 */

/** The signals whose result can name another account — what `/linked` evaluates. */
const LINKING_SIGNALS = FRAUD_SIGNALS.filter((s) =>
  ['SHARED_PAN', 'SHARED_BANK', 'SHARED_IP_SUBNET', 'SHARED_PHONE_ACROSS_ROLES', 'SHARED_DEVICE', 'DUPLICATE_LISTING_PHOTOS', 'SELF_DEALING'].includes(s.key),
);

const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');
const isDecided = (status: string) => status === 'CONFIRMED' || status === 'DISMISSED';
const scoreString = (score: number) => score.toFixed(3);

/** The subject summary a scan or a case read shows beside the signals — never the PAN itself. */
export type SubjectSummary = { type: ResolvedSubject['type']; id: string; name: string | null; kycStatus: string | null; listingId: string | null };
const summarise = (subject: ResolvedSubject): SubjectSummary => ({
  type: subject.type,
  id: subject.id,
  name: subject.name,
  kycStatus: subject.kycStatus,
  listingId: subject.listingId,
});

async function resolveOr404(subjectType: FraudSubjectType, subjectId: string): Promise<ResolvedSubject> {
  const subject = await index.resolveSubject({ type: subjectType, id: subjectId });
  if (!subject) throw new ApiError(404, 'NOT_FOUND', 'That party does not exist');
  return subject;
}

/** POST /fraud/cases/:caseId/score — recomputed and stored on the case; a decided case keeps the score it was decided on. */
export async function scoreCase(caseId: string, admin: Actor, now = new Date()): Promise<{ before: FraudCase; after: FraudCase }> {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX scores a fraud case');
  const before = await repository.findSummaryById(caseId);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Fraud case not found');
  if (isDecided(before.status)) throw new ApiError(409, 'CONFLICT', 'This case has been decided; its score is part of the record');
  const subject = await resolveOr404(before.subjectType, before.subjectId);
  const { signals, score } = await evaluateSignals(subject, { index, now });
  const after = await repository.update(caseId, { score: scoreString(score), signals, scoredAt: now });
  return { before, after };
}

/** POST /fraud/scan/:subjectType/:subjectId — the signals over a party, stored nowhere. */
export async function scanSubject(subjectType: FraudSubjectType, subjectId: string, now = new Date()) {
  const subject = await resolveOr404(subjectType, subjectId);
  const { signals, score } = await evaluateSignals(subject, { index, now });
  const openCase = await repository.findOpenForSubject(subjectType, subjectId);
  return {
    subject: summarise(subject),
    score: scoreString(score),
    signals,
    scoredAt: now,
    openCase: openCase ? { id: openCase.id, displayId: openCase.displayId, status: openCase.status } : null,
  };
}

/** G11-1: a linked account with what is at stake on it. */
export type LinkedAccountExposure = LinkedAccount & {
  /** The party's wallet balance as money; null when it holds no wallet. */
  walletBalance: Money | null;
  /** Its non-terminal orders. */
  openBookings: number;
};

/** G13-B: a party the last scoring compared the subject against and did not link — a "Clean" node. */
export type EvaluatedAccount = { party: LinkedParty; linked: false };

export type LinkedAccountsRead = {
  subject: SubjectSummary;
  linked: LinkedAccountExposure[];
  /**
   * G13-B: from the case's stored signals payload (the last `/score` or the
   * scan that opened it), the candidates no signal linked — the subject and
   * anything linked now taken out. Empty on a case never scored.
   */
  evaluated: EvaluatedAccount[];
  /** G11-1: every linked wallet's balance plus every linked open order's value, as money. */
  valueAtRisk: Money;
  computedAt: Date;
};

/**
 * G11-1: what is at stake on one linked party — its wallet through
 * `wallets`, its open orders through `orders`. A publisher's and an agent's
 * orders hang off their own id; an advertiser's off its login, which the
 * index resolves (`Order.advertiserId` is a User id) — none, no orders.
 */
async function exposureOf(party: LinkedParty): Promise<{ walletBalance: Money | null; openBookings: number; openValue: Decimal }> {
  const scope: OpenOrderScope | null =
    party.type === 'PUBLISHER'
      ? { publisherId: party.id }
      : party.type === 'AGENT'
        ? { agentId: party.id }
        : await index.resolveSubject({ type: 'ADVERTISER', id: party.id }).then((resolved) => (resolved?.userId ? { advertiserUserId: resolved.userId } : null));
  const [wallet, orders] = await Promise.all([findWalletFor({ kind: party.type, id: party.id }), scope ? openOrderExposureFor(scope) : Promise.resolve({ count: 0, value: money(0) })]);
  return { walletBalance: wallet ? money(wallet.balance) : null, openBookings: orders.count, openValue: new Decimal(orders.value) };
}

/**
 * GET /fraud/cases/:caseId/linked — the accounts the shared signals tie the
 * subject to, computed now; G11-1: each with its wallet balance and open
 * bookings, and `valueAtRisk` summed over them. G13-B: beside them, the
 * parties the last scoring compared and cleared, off the stored payload —
 * the graph's "Clean" nodes are a record of what was checked, not a live
 * recompute, so they are read from the case rather than evaluated again.
 */
export async function linkedAccounts(caseId: string, now = new Date()): Promise<LinkedAccountsRead> {
  const fraudCase = await repository.findSummaryById(caseId);
  if (!fraudCase) throw new ApiError(404, 'NOT_FOUND', 'Fraud case not found');
  const subject = await resolveOr404(fraudCase.subjectType, fraudCase.subjectId);
  const { signals } = await evaluateSignals(subject, { index, now }, LINKING_SIGNALS);
  const folded = foldLinks(signals);
  const exposures = await Promise.all(folded.map((account) => exposureOf(account.party)));
  let valueAtRisk = ZERO;
  const linked = folded.map((account, i) => {
    const { walletBalance, openBookings, openValue } = exposures[i]!;
    valueAtRisk = valueAtRisk.plus(walletBalance ?? 0).plus(openValue);
    return { ...account, walletBalance, openBookings };
  });
  const stored = Array.isArray(fraudCase.signals) ? (fraudCase.signals as unknown as StoredSignal[]) : [];
  const self: LinkedAccount = { party: { type: subject.type, id: subject.id, name: subject.name }, via: [] };
  const evaluated: EvaluatedAccount[] = cleanCandidates(stored, [...folded, self]).map((party) => ({ party, linked: false }));
  return { subject: summarise(subject), linked, evaluated, valueAtRisk: money(valueAtRisk), computedAt: now };
}

/* ── the nightly scan ─────────────────────────────────────────────────────── */

export type ScanReport = {
  scanned: number;
  opened: { caseId: string; displayId: string | null; subjectType: string; subjectId: string; score: string; hot: string[] }[];
  /** Parties that ran hot but already had an open case. */
  alreadyOpen: number;
  threshold: number;
};

const hotSignals = (signals: StoredSignal[], threshold: number) => signals.filter((s) => s.value !== null && s.value > threshold);

/**
 * Every party (bounded per type), evaluated; any signal above the threshold
 * (`fraud.scanThreshold`, default 0.6) with no case open against the party
 * opens one — kind SIGNAL_SCAN, the summary naming the hot signals, the
 * score and signals stored — and tells every admin. It never suspends:
 * that is a decision, and a decision is a person's.
 */
export async function runSignalScan(actorUserId: string, now = new Date(), limitPerType?: number): Promise<ScanReport> {
  const { fraud } = await getPlatformSettings();
  const threshold = fraud.scanThreshold;
  const candidates = await index.scanCandidates(limitPerType ?? fraud.scanLimitPerType);
  const report: ScanReport = { scanned: 0, opened: [], alreadyOpen: 0, threshold };

  for (const candidate of candidates) {
    let subject: ResolvedSubject | null;
    try {
      subject = await index.resolveSubject(candidate);
    } catch {
      subject = null;
    }
    if (!subject) continue;
    report.scanned += 1;
    const { signals, score } = await evaluateSignals(subject, { index, now });
    const hot = hotSignals(signals, threshold);
    if (hot.length === 0) continue;
    if (await repository.findOpenForSubject(candidate.type, candidate.id)) {
      report.alreadyOpen += 1;
      continue;
    }
    const hotKeys = hot.map((s) => s.key);
    const created = await openCaseRecord(
      {
        subjectType: candidate.type,
        subjectId: candidate.id,
        kind: SIGNAL_SCAN_KIND,
        summary: `Nightly signal scan: ${hotKeys.join(', ')} above ${threshold} (score ${scoreString(score)}). ${hot.map((s) => `${s.key}: ${s.detail}`).join(' ')}`.slice(0, 4000),
        openedByUserId: actorUserId,
        assignedToUserId: null,
        disputeId: null,
        score: scoreString(score),
        signals,
        scoredAt: now,
      },
      now,
    );
    await logActivity(actorUserId, 'FRAUD_CASE_OPENED', {
      module: 'fraud',
      targetType: 'FraudCase',
      targetId: created.id,
      metadata: { caseId: created.id, displayId: created.displayId, subjectType: created.subjectType, subjectId: created.subjectId, kind: SIGNAL_SCAN_KIND, score: scoreString(score), hot: hotKeys, source: 'signal-scan' },
    });
    report.opened.push({ caseId: created.id, displayId: created.displayId, subjectType: created.subjectType, subjectId: created.subjectId, score: scoreString(score), hot: hotKeys });
  }

  if (report.opened.length > 0) {
    const admins = await listAdminUserIds().catch(() => [] as string[]);
    await Promise.all(
      admins.map((userId) =>
        createNotification({
          userId,
          type: 'SYSTEM',
          title: `Signal scan opened ${report.opened.length} fraud ${report.opened.length === 1 ? 'case' : 'cases'}`,
          message: report.opened
            .slice(0, 5)
            .map((o) => `${o.displayId ?? o.caseId}: ${o.subjectType} ${o.subjectId} — ${o.hot.join(', ')}`)
            .join('; ')
            .slice(0, 500),
          suggestedAction: 'Open the fraud desk',
          relatedId: report.opened[0]?.caseId,
        }).catch(() => undefined),
      ),
    );
  }
  logger.info('Fraud signal scan finished', { scanned: report.scanned, opened: report.opened.length, alreadyOpen: report.alreadyOpen, threshold });
  return report;
}
