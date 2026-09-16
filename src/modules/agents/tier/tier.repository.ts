import type { AgentTier, AgentTierEvent, TierLevel } from '../../../shared/database';

export type TierProfile = {
  id: string;
  userId: string;
  city: string | null;
  tier: AgentTier;
  tierLevel: TierLevel;
  tierPinnedAt: Date | null;
};

export type NewTierEvent = {
  agentId: string;
  fromTier: AgentTier;
  fromLevel: TierLevel;
  toTier: AgentTier;
  toLevel: TierLevel;
  reason: string;
  byUserId?: string | null;
  at: Date;
};

export interface TierRepository {
  findProfile(agentId: string): Promise<TierProfile | null>;
  findProfileByUser(userId: string): Promise<TierProfile | null>;
  /** The rung, written back on read — or pinned by ops (`pinnedAt` set) until unpinned (null). */
  writeRung(agentId: string, tier: AgentTier, level: TierLevel, pinnedAt: Date | null): Promise<void>;
  createEvent(data: NewTierEvent): Promise<AgentTierEvent>;
  /** The newest promotion nobody has dismissed yet, for the GOLD Achieved screen. */
  findUnacknowledged(agentId: string): Promise<AgentTierEvent | null>;
  findEvent(eventId: string): Promise<AgentTierEvent | null>;
  acknowledge(eventId: string, at: Date): Promise<AgentTierEvent>;
  listEvents(agentId: string, limit: number): Promise<AgentTierEvent[]>;
}
