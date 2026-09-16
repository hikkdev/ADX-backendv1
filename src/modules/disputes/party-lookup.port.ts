/**
 * E7-3: the party record behind a user id — who a dispute is *against*, as
 * the console's rail names them: the publisher, advertiser or agent record
 * with its display id, not just the login.
 *
 * A port rather than an import because the answer needs `publishers`,
 * `advertisers` and `agents`, and this module's README keeps those out of its
 * dependency list on purpose — a read is not a decision, and three more
 * imports here would be three more edges for the next cycle to close over.
 * `bootstrap/register-modules.ts` fills it from the three modules' label
 * exports; the same composition fills `support`'s port. Unregistered — in a
 * unit test, or in a process that never mounted the modules — every lookup
 * answers nothing, so the read still works and the record is null.
 */
export type PartyRecordType = 'PUBLISHER' | 'ADVERTISER' | 'AGENT';

export type PartyRecord = {
  type: PartyRecordType;
  id: string;
  displayId: string | null;
  name: string | null;
};

export interface PartyLookupPort {
  /** Every party record behind each id, in one round trip; an id with none is absent. */
  partiesForUsers(userIds: readonly string[]): Promise<Map<string, PartyRecord[]>>;
}

let port: PartyLookupPort | null = null;

export function registerPartyLookupPort(implementation: PartyLookupPort): void {
  port = implementation;
}

/** Tests only. */
export function resetPartyLookupPort(): void {
  port = null;
}

export async function partyRecordsForUsers(userIds: readonly string[]): Promise<Map<string, PartyRecord[]>> {
  const unique = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!port || unique.length === 0) return new Map();
  return port.partiesForUsers(unique);
}

/**
 * The one record to print: the type the case names when the login has it
 * (an agent who is also a publisher is *the agent* on an agent's case),
 * else the first.
 */
export function pickPartyRecord(records: PartyRecord[] | undefined, preferred: string | null): PartyRecord | null {
  if (!records || records.length === 0) return null;
  return records.find((record) => record.type === preferred) ?? records[0] ?? null;
}
