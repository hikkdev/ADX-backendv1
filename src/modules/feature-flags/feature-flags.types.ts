/**
 * The evaluator's vocabulary, in a file of its own so the ports (which fire
 * after a write) and the service (which does the writing) can both name it
 * without importing each other.
 */

/** The rollout rules as stored: every list optional, an empty list meaning no restriction on that axis. */
export type Rollout = { roles?: string[]; cities?: string[]; userIds?: string[] };

export type FlagState = {
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  variant: string | null;
  variants: string[];
  rollout: Rollout | null;
  surfaces: string[];
};

/** Who is asking: the token's subject and roles, and the city bootstrap's port finds for them. */
export type FlagSubject = {
  id?: string | null;
  roles?: readonly string[];
  city?: string | null;
};

export type FlagAnswer = { enabled: boolean; variant: string | null };
