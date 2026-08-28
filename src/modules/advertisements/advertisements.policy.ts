import type { Advertisement } from '../../shared/database';

export type Caller = { userId: string; isAdmin: boolean };

/**
 * Who may see which advertisements.
 *
 * Admins see everyone's, optionally narrowed to one advertiser; everyone else
 * sees only their own, and an explicit advertiserId filter is ignored for them
 * rather than honoured.
 */
export function visibilityFilter(caller: Caller, advertiserIdFilter?: string) {
  if (!caller.isAdmin) return { advertiserId: caller.userId };
  return advertiserIdFilter ? { advertiserId: advertiserIdFilter } : {};
}

/** A non-admin may only reach their own advertisements. */
export function canAccess(caller: Caller, advertisement: Advertisement | null): boolean {
  if (!advertisement) return false;
  return caller.isAdmin || advertisement.advertiserId === caller.userId;
}
