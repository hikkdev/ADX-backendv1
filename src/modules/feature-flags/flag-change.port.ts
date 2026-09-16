import { logger } from '../../shared/logging';
import type { FlagState } from './feature-flags.types';

/**
 * Lot G: what happens after a flag moves.
 *
 * The push side — telling the apps to refresh `/app/flags` so a kill switch
 * lands on a phone without waiting for the next cold start — is G6's, and
 * lives above this module in the graph (it reaches the device tokens). So
 * this module declares the event and G6 registers the listener in
 * `bootstrap/register-modules`. Unregistered, a change is still a change:
 * the row moved, the history has it, the next `/app/flags` read sees it.
 */
export interface FlagChangeEvent {
  /** The state after the write. */
  flag: FlagState;
  changeId: string;
  byUserId: string;
  /** True when the write was `POST /flags/:key/rollback`. */
  rollback: boolean;
}

export type FlagChangePort = (event: FlagChangeEvent) => Promise<void> | void;

let registered: FlagChangePort | null = null;

export function registerFlagChangePort(port: FlagChangePort): void {
  registered = port;
}

/** Fires the port after a write. A listener that throws is logged, never surfaced: the flag has already moved. */
export async function emitFlagChange(event: FlagChangeEvent): Promise<void> {
  if (!registered) return;
  try {
    await registered(event);
  } catch (err) {
    logger.warn('flag change listener failed', {
      key: event.flag.key,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}
