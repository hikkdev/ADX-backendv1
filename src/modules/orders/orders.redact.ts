import type { ORDER_RISK_COLUMNS } from '../../shared/database';
import { LISTING_PUBLISHER_RECORD_KEYS } from '../../shared/listing-vocabulary';

/**
 * Order fraud screening (2 Oct 2026): the risk and hold columns, by name — the
 * client's `ORDER_RISK_COLUMNS`, spelt out here because a module reads
 * `shared/database` for types only. The check below fails to compile when
 * the two lists part.
 */
export const ORDER_RISK_FIELDS = [
  'riskScore',
  'riskSignals',
  'riskBand',
  'riskScoredAt',
  'riskReviewStatus',
  'riskReviewedById',
  'riskReviewedAt',
  'riskReviewNote',
  'riskClearedSignalKeys',
  'heldAt',
  'heldById',
  'holdReason',
  'fraudCaseId',
] as const satisfies readonly (keyof typeof ORDER_RISK_COLUMNS)[];
type UnlistedRiskField = Exclude<keyof typeof ORDER_RISK_COLUMNS, (typeof ORDER_RISK_FIELDS)[number]>;
const everyRiskFieldListed: [UnlistedRiskField] extends [never] ? true : never = true;
void everyRiskFieldListed;

/**
 * Order fraud screening (the owner, 2 Oct 2026): what a party sees on an
 * order ADX has held for review. Never "fraud", in any party-facing copy.
 */
export const ORDER_REVIEW_NOTICE = "Your order is being reviewed — we'll update you shortly.";

/** The neutral line for a party, or null when the order is not held. */
export const reviewNoticeFor = (hold: { heldAt: Date | null } | null | undefined): string | null => (hold?.heldAt ? ORDER_REVIEW_NOTICE : null);

/**
 * 26 Sep 2026: the completion code and its hash leave the persona reads. The
 * plain code is kept on the row so support can read it back (the admin
 * console's reads keep it); the publisher is given it by notification, and
 * the agent must hear it from the publisher — that is the whole proof.
 * Before this `GET /orders/my` answered it to the publisher, the advertiser
 * and the agent alike, and `GET /orders/:id` to anyone who could read the order.
 */
export function withoutCompletionCode<T extends object>(row: T): Omit<T, 'completionOtp' | 'completionOtpPlain'> {
  const { completionOtp: _hash, completionOtpPlain: _plain, ...rest } = row as T & { completionOtp?: unknown; completionOtpPlain?: unknown };
  return rest as Omit<T, 'completionOtp' | 'completionOtpPlain'>;
}

/**
 * Order fraud screening (2 Oct 2026): the risk and hold columns off a row.
 * The client's global omit keeps them off every default read already; this
 * is the belt on a party's answer, as `withoutCompletionCode` is for the code.
 */
export function withoutRisk<T extends object>(row: T): T {
  const copy = { ...(row as Record<string, unknown>) };
  for (const key of ORDER_RISK_FIELDS) delete copy[key];
  return copy as T;
}

/**
 * How the caller stands to an order — set by the read gate, one flag per
 * relationship, because one login can be more than one of them (an
 * advertiser booking their own spot, an agent who also publishes).
 */
export type OrderViewer = { admin: boolean; advertiser: boolean; publisher: boolean; agent: boolean };

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function without(row: unknown, keys: readonly string[]): unknown {
  if (!isRow(row)) return row;
  const copy: Row = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

/** An agent row with its person's number taken off. */
function withoutAgentNumber(agent: unknown): unknown {
  if (!isRow(agent) || !isRow(agent.user)) return agent;
  return { ...agent, user: without(agent.user, ['mobile']) };
}

/**
 * 2 Oct 2026: the contact fields of `GET /orders/:id`, by who is asking. The
 * repository's `select` already keeps every secret and every private column
 * out; this takes off the two phone numbers (and the publisher's address)
 * from the parties that have no use for them.
 *
 *  - The installer's number (`agent.user.mobile`) is the publisher's: their
 *    booking's Installer card and Track screen call the agent.
 *  - The publisher's number and address (`listing.publisher.mobile`,
 *    `.address`) are the agent's: the pickup card prints the address and the
 *    travel step calls the publisher. The publisher keeps their own.
 *  - The offered agents' numbers (`agentAssignments[].agent.user.mobile`) are
 *    ADX's alone — the console's offer history.
 *
 * ADX reads the aggregate whole. The advertiser gets names only.
 *
 * Order fraud screening: no party gets a risk or hold column; every party
 * gets `reviewNotice` — the neutral line when `hold` says the order is held,
 * null otherwise.
 */
export function orderDetailFor<T extends object>(order: T, viewer: OrderViewer, hold?: { heldAt: Date | null } | null): T & { reviewNotice?: string | null } {
  if (viewer.admin) return order;
  const row = withoutRisk(order) as Row;
  // Order fraud screening: a held order says so in one neutral line, and nothing else about why.
  row.reviewNotice = reviewNoticeFor(hold);
  if (!viewer.publisher) row.agent = withoutAgentNumber(row.agent);
  if (Array.isArray(row.agentAssignments)) {
    row.agentAssignments = row.agentAssignments.map((offer) =>
      isRow(offer) ? { ...offer, agent: withoutAgentNumber(offer.agent) } : offer,
    );
  }
  if (!viewer.agent && !viewer.publisher && isRow(row.listing)) {
    row.listing = { ...row.listing, publisher: without(row.listing.publisher, ['mobile', 'address']) };
  }
  // LD-1: the publisher's own statement to ADX about the spot stays theirs (and the desk's).
  if (!viewer.publisher && isRow(row.listing)) row.listing = without(row.listing, LISTING_PUBLISHER_RECORD_KEYS);
  return row as T;
}
