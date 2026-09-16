/**
 * Suspension — the one writer of the five suspension columns, on all four
 * parties, and of `PartySuspensionEvent`.
 *
 * Every other module *reads* those columns where its own work needs the
 * answer — the advertiser booking gate, the agent dispatch sweep, the accrual
 * run, the wallet debit — and none of them writes one. That is what keeps a
 * suspension one act with one record rather than four modules each having
 * their own idea of what "suspended" means.
 *
 * The router is mounted at the API root: the paths hang off the party
 * (`/publishers/:id/suspend`), the code lives here.
 */
export { suspensionRouter } from './suspension.routes';

/**
 * The narrow reads another module may use. `isSuspended` is the yes-or-no a
 * gate wants; `SCOPES_BY_PARTY` is what the console draws its checkboxes from.
 */
export { isSuspended, suspensionOf, SCOPES_BY_PARTY, PARTY_TYPES } from './suspension.service';

/** Used by the console and by `users`' deletion guard, which reports what it found. */
export { suspendParty, reinstateParty } from './suspension.service';
export type {
  SuspensionView,
  SuspensionCaseView,
  SuspensionEffects,
  SuspendInput,
  ReinstateInput,
} from './suspension.service';
export type { PartyType } from './suspension.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
