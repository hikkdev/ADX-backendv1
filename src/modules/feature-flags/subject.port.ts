/**
 * Lot G (answer 146): the caller's city, for a rollout by city.
 *
 * A token carries the user's id and roles; the city is on the party's profile
 * — `Publisher.city`, `Advertiser.city`, `AgentProfile.city` — and those
 * modules sit above this one in the graph (users → advertisers → payouts →
 * flags). So the lookup is a port this module declares and bootstrap fills
 * from the three profile reads. Unregistered, a caller has no city, and a
 * flag rolled out by city is off for them — the fail-closed answer.
 */
export type SubjectCityPort = (userId: string) => Promise<string | null>;

let registered: SubjectCityPort | null = null;

export function registerFlagSubjectCityPort(port: SubjectCityPort): void {
  registered = port;
}

export async function subjectCity(userId: string): Promise<string | null> {
  if (!registered) return null;
  try {
    return (await registered(userId)) ?? null;
  } catch {
    // A city that cannot be read is no city: the rollout stays closed.
    return null;
  }
}
