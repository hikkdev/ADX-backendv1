/**
 * E6: who built and approved a payout batch, by name.
 *
 * `users` sits above this module in the graph (it reaches `advertisers`,
 * which reaches this module for its payout methods), so the name lookup is
 * inverted the way `qr` takes its publisher port: this declares what the
 * reads need, `users.findUserLabels` supplies it, and
 * `bootstrap/register-modules` connects the two. Unregistered — a test, a
 * stripped build — every actor is `{ id, name: null }`.
 */
export type UserLabel = { id: string; name: string | null };
export type UserLabelPort = (ids: readonly string[]) => Promise<Map<string, UserLabel>>;

let registered: UserLabelPort | null = null;

export function registerPayoutUserLabelPort(port: UserLabelPort): void {
  registered = port;
}

export async function userLabels(ids: readonly string[]): Promise<Map<string, UserLabel>> {
  const fallback = new Map<string, UserLabel>(ids.map((id) => [id, { id, name: null }]));
  if (!registered || ids.length === 0) return fallback;
  try {
    const found = await registered(ids);
    for (const [id, label] of found) fallback.set(id, label);
  } catch {
    // A name is decoration on the history; the history still answers.
  }
  return fallback;
}
