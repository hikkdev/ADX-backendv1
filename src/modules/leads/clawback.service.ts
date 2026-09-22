import { logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { getAgentWithUser } from '../agents';
import { notify } from '../notifications';
import { clawbackIncentive } from '../payouts';
import { prismaIntegrityRepository as repository } from './prisma-integrity.repository';

/**
 * LH10 (the Lead Hunt) — the clawback on an activation that did not last.
 *
 * The catch pays LEAD_ACTIVATED when the account first does business. If,
 * inside `CLAWBACK_DAYS` of that moment, the account closes or its business
 * comes down — the publisher's last ACTIVE listing unpublished, the
 * advertiser left with no live campaign — the reward comes back: a ledger
 * reversal through `payouts.clawbackIncentive` (money that had not moved is
 * simply refused), an audit row, and the agent told what happened and why.
 *
 * Deliberately narrow: only LEAD_ACTIVATED, only inside the window, only the
 * account's own standing. It never touches LEAD_CONVERTED (the account was
 * opened, and it was), the priority top-up (a zone's own budget, keyed on
 * the lead) or anything a person credited by hand.
 */

export const CLAWBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ClawbackResult = { checked: number; reversed: number; amount: string[] };

export async function watchClawbacks(now = new Date()): Promise<ClawbackResult> {
  const since = new Date(now.getTime() - CLAWBACK_DAYS * DAY_MS);
  const leads = await repository.activatedSince(since, 500);
  const amounts: string[] = [];
  let reversed = 0;
  for (const lead of leads) {
    const account = { publisherId: lead.convertedPublisherId, advertiserId: lead.convertedAdvertiserId };
    if (!account.publisherId && !account.advertiserId) continue;
    try {
      const standing = await repository.accountStanding(account);
      if (standing.live && !standing.closed) continue;
      const incentive = await repository.activationIncentiveFor(account);
      if (!incentive) continue;
      const reason = standing.closed
        ? `The account closed within ${CLAWBACK_DAYS} days of the catch`
        : `The account's business came down within ${CLAWBACK_DAYS} days of the catch`;
      await clawbackIncentive(incentive.id, { reason: `${reason} (lead ${lead.displayId ?? lead.id}: ${lead.businessName})` }, now);
      amounts.push(incentive.amount);
      reversed += 1;
      await logActivity('system', 'LEAD_ACTIVATION_CLAWED_BACK', undefined, {
        leadId: lead.id,
        displayId: lead.displayId,
        incentiveId: incentive.id,
        agentId: incentive.agentId,
        amount: incentive.amount,
        status: incentive.status,
        reason,
      });
      await tellTheAgent(incentive.agentId, lead.businessName, incentive.amount, reason);
    } catch (err) {
      logger.warn('A clawback did not go through', { leadId: lead.id, err });
    }
  }
  return { checked: leads.length, reversed, amount: amounts };
}

async function tellTheAgent(agentId: string, businessName: string, amount: string, reason: string): Promise<void> {
  try {
    const profile = await getAgentWithUser(agentId);
    const userId = (profile as { userId?: string } | null)?.userId ?? null;
    if (!userId) return;
    await notify('INCENTIVE_REVERSED', userId, { businessName, amount, reason });
  } catch (err) {
    logger.warn('The clawback notice was not sent', { agentId, err });
  }
}
