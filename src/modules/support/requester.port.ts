/**
 * E7-3: who raised the ticket — the party record behind the login, the
 * balance in their wallet and the orders they have running. What the
 * console's requester rail draws beside a thread.
 *
 * A port rather than imports because the answers live in `publishers`,
 * `advertisers`, `agents`, `wallets`, `listings` and `orders`, and this
 * module sits underneath `account-lifecycle` and `ops` with a dependency list
 * of five; six more edges here is how the next cycle closes.
 * `bootstrap/register-modules.ts` fills it from those modules' indexes (the
 * same party composition fills `disputes`' port). Unregistered — a unit test,
 * a process that never mounted the modules — every lookup answers nothing:
 * the queue still lists, the rail still opens, the party and the numbers are
 * null.
 */
export type RequesterPartyType = 'PUBLISHER' | 'ADVERTISER' | 'AGENT';

export type RequesterParty = {
  type: RequesterPartyType;
  id: string;
  displayId: string | null;
  name: string | null;
  kycStatus: string | null;
};

export interface RequesterPort {
  /** Every party record behind each id, in one round trip; an id with none is absent. */
  partiesForUsers(userIds: readonly string[]): Promise<Map<string, RequesterParty[]>>;
  /** The settled balance of the party's wallet as a decimal string; null when there is none. */
  walletBalance(party: RequesterParty): Promise<string | null>;
  /** Orders still running with this login on either side of them. */
  openOrders(userId: string, party: RequesterParty | null): Promise<number>;
}

let port: RequesterPort | null = null;

export function registerRequesterPort(implementation: RequesterPort): void {
  port = implementation;
}

/** Tests only. */
export function resetRequesterPort(): void {
  port = null;
}

export async function requesterPartiesFor(userIds: readonly string[]): Promise<Map<string, RequesterParty[]>> {
  const unique = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!port || unique.length === 0) return new Map();
  return port.partiesForUsers(unique);
}

export async function requesterWalletBalance(party: RequesterParty | null): Promise<string | null> {
  if (!port || !party) return null;
  return port.walletBalance(party);
}

export async function requesterOpenOrders(userId: string, party: RequesterParty | null): Promise<number> {
  if (!port) return 0;
  return port.openOrders(userId, party);
}
