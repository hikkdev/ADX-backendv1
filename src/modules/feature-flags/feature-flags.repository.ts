import type { FeatureFlag, FeatureFlagChange, FeatureKind, FeatureSurface } from '../../shared/database';

/** A flag with the change that last moved it, for the ops screen. */
export type FlagWithLastChange = FeatureFlag & { changes: FeatureFlagChange[] };

/** The switch positions the evaluator caches — every column a rollout rule reads, nothing the console only draws. */
export type FlagStateRow = Pick<
  FeatureFlag,
  'key' | 'enabled' | 'rolloutPercent' | 'variant' | 'variants' | 'rollout' | 'surfaces' | 'source'
>;

/** What the switch was, for `lastGoodState` and for the change row. */
export interface FlagPosition {
  enabled: boolean;
  rolloutPercent: number;
  variant: string | null;
  rollout: unknown;
}

/** What `ensureFeatureRegistry` writes for a declaration. */
export interface RegisteredFlagInput {
  key: string;
  description: string;
  surfaces: FeatureSurface[];
  kind: FeatureKind;
  owner: string;
  variants: string[];
  /** Only read when the row is created. */
  enabled: boolean;
}

/** One write of a batch: the same three arguments `update` takes. */
export interface FlagWriteInput {
  key: string;
  next: FlagPosition & { lastGoodState: FlagPosition };
  change: { byUserId: string; note: string | null; rollbackOfId: string | null };
}

export interface FeatureFlagsRepository {
  /** Every flag, with its most recent change. Alphabetical: it is a short list. */
  list(): Promise<FlagWithLastChange[]>;
  /** Just the switch positions, for the evaluator's cached snapshot. */
  listState(): Promise<FlagStateRow[]>;
  find(key: string): Promise<FeatureFlag | null>;
  /**
   * The flag and its change row in one transaction: a switch that moved with
   * no record of who moved it is exactly what this table exists to prevent.
   * `lastGoodState` is the position before this write, so a rollback has
   * something to restore.
   */
  update(
    key: string,
    next: FlagPosition & { lastGoodState: FlagPosition },
    change: { byUserId: string; note: string | null; rollbackOfId: string | null },
  ): Promise<FlagWithLastChange>;
  /**
   * L-B: every write of a bulk move in ONE transaction — each key's row and
   * its change row exactly as `update` writes them, all landing or none.
   * Answers the rows in the order given, each carrying the change just
   * written. An empty batch writes nothing and answers `[]`.
   */
  updateMany(writes: FlagWriteInput[]): Promise<FlagWithLastChange[]>;
  changes(key: string, limit: number): Promise<FeatureFlagChange[]>;
  /** Creates a REGISTERED row for a declaration the table does not have yet. */
  createRegistered(input: RegisteredFlagInput): Promise<void>;
  /** Refreshes the metadata of a REGISTERED row; never touches enabled, rolloutPercent, variant or rollout. */
  updateRegistered(input: Omit<RegisteredFlagInput, 'enabled'>): Promise<void>;
  /**
   * Lot G: a Lot A flag under its registry key. The old row's switch,
   * rollout and description become the new row (unless the new key already
   * exists, in which case the new row wins), its changes are re-keyed, and
   * the old row is deleted — one transaction. No old row: nothing to do.
   */
  foldLegacy(oldKey: string, newKey: string): Promise<boolean>;
}
