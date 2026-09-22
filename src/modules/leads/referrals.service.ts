import { randomBytes } from 'crypto';
import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { getPlatformSettings } from '../app-config';
import { ensureWallet, move } from '../wallets';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { toLeadCard } from './leads.service';
import { inboundLead } from './inbound.service';

/**
 * LH3 (D9): referrals. A live publisher or advertiser (or an agent) refers
 * a business from the app — a name, a number, the side — and it lands as
 * a lead on the referral source, attributed to them; when that lead
 * ACTIVATES (the retention watch), the referrer's wallet is credited the
 * referral amount, once per referred account. An agent's referral earns
 * no wallet credit (agents are paid through the incentive rates; D9 names
 * the two customer sides).
 *
 * Every account also has one link (`/j/r/<code>`), minted on first ask,
 * that a stranger can open — LH7's landing page takes it from there; until
 * then `POST /leads/inbound/referral/:code` is the door behind it.
 */

export type ReferrerKindValue = 'PUBLISHER' | 'ADVERTISER' | 'AGENT';
export type Referrer = { kind: ReferrerKindValue; id: string };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** An 8-character code over the confusable-free alphabet. */
export function mintCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** The link a referrer shares — `${PUBLIC_WEB_URL}/j/r/<code>` (the D6 domain when it is pointed). */
export function referralUrl(code: string): string {
  const base = (env.PUBLIC_WEB_URL ?? env.BASE_URL ?? 'https://adx.in').replace(/\/$/, '');
  return `${base}/j/r/${code}`;
}

export async function myReferralLink(referrer: Referrer): Promise<{ code: string; url: string }> {
  const existing = await repository.findReferralLink(referrer.kind, referrer.id);
  if (existing) return { code: existing.code, url: referralUrl(existing.code) };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await repository.createReferralLink({ referrerKind: referrer.kind, referrerId: referrer.id, code: mintCode() });
      return { code: created.code, url: referralUrl(created.code) };
    } catch (error) {
      // A code collision (one in a billion) or a racing first ask: the unique refuses and the loop reads again.
      const again = await repository.findReferralLink(referrer.kind, referrer.id);
      if (again) return { code: again.code, url: referralUrl(again.code) };
      if (attempt === 4) throw error;
    }
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not mint a referral code');
}

export type ReferInput = {
  side: 'PUBLISHER' | 'ADVERTISER';
  businessName: string;
  contactName?: string | undefined;
  phone: string;
  city?: string | undefined;
  message?: string | undefined;
};

/** "Refer a business" from the app: the lead, attributed; the referral row that pays later. */
export async function refer(referrer: Referrer, input: ReferInput) {
  const link = await myReferralLink(referrer);
  const linkRow = await repository.findReferralLinkByCode(link.code);
  if (!linkRow) throw new ApiError(500, 'INTERNAL_ERROR', 'Referral link missing');
  const answer = await inboundLead(
    { ...input, channel: 'OTHER' },
    { sourceKey: 'referral', sourceKind: 'REFERRAL', assignedAgentId: referrer.kind === 'AGENT' ? referrer.id : null, note: `Referred by ${referrer.kind.toLowerCase()} ${referrer.id}` },
  );
  if (answer.created) await repository.createReferral({ linkId: linkRow.id, referrerKind: referrer.kind, referrerId: referrer.id, leadId: answer.leadId });
  const lead = await repository.findById(answer.leadId);
  return { ...answer, lead: lead ? toLeadCard(lead as never, null) : null, alreadyKnown: !answer.created };
}

/** A stranger opened a referral link and left a number (`POST /leads/inbound/referral/:code`). */
export async function referralCodeInbound(code: string, input: ReferInput) {
  const linkRow = await repository.findReferralLinkByCode(code.trim().toUpperCase());
  if (!linkRow) throw new ApiError(404, 'NOT_FOUND', 'That referral link is not in use');
  const answer = await inboundLead(
    { ...input, channel: 'LINK' },
    { sourceKey: 'referral', sourceKind: 'REFERRAL', assignedAgentId: linkRow.referrerKind === 'AGENT' ? linkRow.referrerId : null, note: `Came through a referral link (${linkRow.referrerKind.toLowerCase()})` },
  );
  if (answer.created) await repository.createReferral({ linkId: linkRow.id, referrerKind: linkRow.referrerKind, referrerId: linkRow.referrerId, leadId: answer.leadId });
  return answer;
}

export function referralView(row: { id: string; referrerKind: string; referrerId: string; leadId: string; creditAmount: unknown; creditedAt: Date | null; createdAt: Date; lead?: { displayId: string | null; businessName: string; stage: string; status: string; side: string; city: string | null } }, referrer?: { name: string; mobile: string | null } | null) {
  return {
    id: row.id,
    referrerKind: row.referrerKind,
    referrerId: row.referrerId,
    referrer: referrer ?? null,
    leadId: row.leadId,
    lead: row.lead ? { displayId: row.lead.displayId, businessName: row.lead.businessName, stage: row.lead.stage, status: row.lead.status, side: row.lead.side, city: row.lead.city } : null,
    creditAmount: row.creditAmount === null || row.creditAmount === undefined ? null : money(row.creditAmount as never),
    creditedAt: row.creditedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function myReferrals(referrer: Referrer) {
  const link = await myReferralLink(referrer);
  const rows = await repository.listReferralsBy(referrer.kind, referrer.id);
  const credited = rows.filter((row) => row.creditedAt).reduce((sum, row) => sum + Number(row.creditAmount ?? 0), 0);
  return { link, referrals: rows.map((row) => referralView(row)), totals: { referred: rows.length, activated: rows.filter((row) => row.lead.stage === 'ACTIVATED' || row.lead.stage === 'RETAINED').length, credited: money(credited) } };
}

/** The desk's list, every referrer named. */
export async function listReferrals() {
  const rows = await repository.listReferrals(200);
  const labels = new Map<string, { name: string; mobile: string | null } | null>();
  const out = [];
  for (const row of rows) {
    const key = `${row.referrerKind}:${row.referrerId}`;
    if (!labels.has(key)) labels.set(key, await repository.referrerLabel(row.referrerKind, row.referrerId));
    out.push(referralView(row, labels.get(key)));
  }
  return out;
}

/**
 * D9: the referrer's wallet credit on the referred lead's activation —
 * once, at the setting's figure, through the wallet's own double-entry
 * door with the referral as the idempotency key. Called by the retention
 * watch; an agent referrer takes nothing here.
 */
export async function creditReferralOnActivation(leadId: string): Promise<{ credited: boolean; amount: string | null }> {
  const referral = await repository.findReferralForLead(leadId);
  if (!referral || referral.creditedAt) return { credited: false, amount: null };
  if (referral.referrerKind === 'AGENT') return { credited: false, amount: null };
  const amount = (await getPlatformSettings()).leads.referralCredit;
  if (amount <= 0) return { credited: false, amount: null };
  const label = await repository.referrerLabel(referral.referrerKind, referral.referrerId);
  try {
    const wallet = await ensureWallet({ kind: referral.referrerKind, id: referral.referrerId }, label?.name ?? referral.referrerId);
    const result = await move({
      walletId: wallet.id,
      walletLabel: label?.name ?? referral.referrerId,
      amount: money(amount),
      entryType: 'REFERRAL',
      ledgerKind: 'GOODWILL',
      idempotencyKey: `referral:${referral.id}`,
      counterLegs: [{ accountCode: 'platform:goodwill', amount: money(-amount), note: 'Referral credit' }],
      note: `Referral credit — the business you referred is live on ADX`,
      createdByUserId: null,
    });
    const entryId = result && typeof result === 'object' && 'entry' in result ? ((result as { entry?: { id?: string } }).entry?.id ?? null) : null;
    await repository.markReferralCredited(referral.id, { creditAmount: money(amount), creditedAt: new Date(), walletEntryId: entryId });
    return { credited: true, amount: money(amount) };
  } catch (err) {
    logger.warn('Referral credit was not paid', { leadId, referralId: referral.id, err });
    return { credited: false, amount: null };
  }
}
