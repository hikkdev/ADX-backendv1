/**
 * The signal registry — Lot G (Q118/138).
 *
 * One entry per file; the order here is the order the case page prints.
 * `score = min(1, Σ weight × value)` over the signals that could be computed
 * (a null value — the photo hash without a decoder — is shown but adds
 * nothing). The weights are the table in the README; a change there is a
 * change here.
 */
import { sharedPanSignal } from './shared-pan.signal';
import { sharedBankSignal } from './shared-bank.signal';
import { sharedIpSubnetSignal } from './shared-ip-subnet.signal';
import { sharedPhoneAcrossRolesSignal } from './shared-phone-across-roles.signal';
import { sharedDeviceSignal } from './shared-device.signal';
import { bankNameMismatchSignal } from './bank-name-mismatch.signal';
import { duplicateListingPhotosSignal } from './duplicate-listing-photos.signal';
import { proofFarFromSiteSignal } from './proof-far-from-site.signal';
import { selfDealingSignal } from './self-dealing.signal';
import { commissionFarmingSignal } from './commission-farming.signal';
import { refundDisputeRateSignal } from './refund-dispute-rate.signal';
import { withdrawAfterCreditSignal } from './withdraw-after-credit.signal';
import { listingVelocitySignal } from './listing-velocity.signal';
import type { FraudSignal, LinkedAccount, LinkedParty, ResolvedSubject, SignalContext, StoredSignal } from './types';

/** G13-B: how many compared-against parties a signal keeps on the stored payload. */
export const CANDIDATES_PER_SIGNAL = 20;

export const FRAUD_SIGNALS: readonly FraudSignal[] = [
  sharedPanSignal,
  sharedBankSignal,
  sharedIpSubnetSignal,
  sharedPhoneAcrossRolesSignal,
  sharedDeviceSignal,
  bankNameMismatchSignal,
  duplicateListingPhotosSignal,
  proofFarFromSiteSignal,
  selfDealingSignal,
  commissionFarmingSignal,
  refundDisputeRateSignal,
  withdrawAfterCreditSignal,
  listingVelocitySignal,
];

export const SIGNAL_KEYS = FRAUD_SIGNALS.map((s) => s.key);

/** `min(1, Σ weight × value)`, to three places; a null value adds nothing. */
export function scoreOf(signals: readonly Pick<StoredSignal, 'weight' | 'value'>[]): number {
  const sum = signals.reduce((acc, s) => acc + (s.value === null ? 0 : s.weight * Math.max(0, Math.min(1, s.value))), 0);
  return Math.min(1, Math.round(sum * 1000) / 1000);
}

/** Every signal over the subject; a signal that throws is recorded as not computed rather than failing the score. */
export async function evaluateSignals(
  subject: ResolvedSubject,
  ctx: SignalContext,
  signals: readonly FraudSignal[] = FRAUD_SIGNALS,
): Promise<{ signals: StoredSignal[]; score: number }> {
  const rows: StoredSignal[] = [];
  for (const signal of signals) {
    try {
      const result = await signal.evaluate(subject, ctx);
      rows.push({
        key: signal.key,
        weight: signal.weight,
        value: result.value === null ? null : Math.round(Math.max(0, Math.min(1, result.value)) * 1000) / 1000,
        detail: result.detail,
        ...(result.links && result.links.length ? { links: result.links } : {}),
        ...(result.candidates && result.candidates.length ? { candidates: result.candidates.slice(0, CANDIDATES_PER_SIGNAL) } : {}),
      });
    } catch (err) {
      rows.push({ key: signal.key, weight: signal.weight, value: null, detail: `Not computed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { signals: rows, score: scoreOf(rows) };
}

/** The accounts the shared signals tie the subject to, each with every signal that says so. */
export function foldLinks(signals: readonly StoredSignal[]): LinkedAccount[] {
  const byParty = new Map<string, LinkedAccount>();
  for (const signal of signals) {
    for (const party of signal.links ?? []) {
      const key = `${party.type}:${party.id}`;
      const entry = byParty.get(key) ?? { party, via: [] };
      if (!entry.via.includes(signal.key)) entry.via.push(signal.key);
      if (!entry.party.name && party.name) entry.party = party;
      byParty.set(key, entry);
    }
  }
  return [...byParty.values()].sort((a, b) => b.via.length - a.via.length);
}

/**
 * G13-B: the parties the signals compared the subject against and did not
 * link — distinct, in the order the signals named them, the linked parties
 * taken out. The "Clean" nodes.
 */
export function cleanCandidates(signals: readonly StoredSignal[], linked: readonly LinkedAccount[]): LinkedParty[] {
  const taken = new Set(linked.map((account) => `${account.party.type}:${account.party.id}`));
  const out = new Map<string, LinkedParty>();
  for (const signal of signals) {
    for (const party of signal.candidates ?? []) {
      const key = `${party.type}:${party.id}`;
      if (taken.has(key)) continue;
      const seen = out.get(key);
      if (!seen) out.set(key, party);
      else if (!seen.name && party.name) out.set(key, party);
    }
  }
  return [...out.values()];
}

export type { FraudSignal, FraudSignalIndex, FraudSubject, LinkedAccount, LinkedParty, ResolvedSubject, SignalContext, SignalResult, StoredSignal } from './types';
