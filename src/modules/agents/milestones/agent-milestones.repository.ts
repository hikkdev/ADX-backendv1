import type {
  AgentMilestone,
  MilestoneTemplate,
  MilestoneType,
} from '../../../shared/database';
import type { Decimal } from '../../../shared/money';

export type NewMilestoneTemplate = {
  type: MilestoneType;
  title: string;
  description: string;
  target: number;
  rewardAmount: Decimal;
  sortOrder: number;
  isActive: boolean;
  windowDays: number | null;
  startsAt: Date | null;
  unlockAfter: number | null;
};

export type MilestoneTemplatePatch = Partial<NewMilestoneTemplate>;

export type AgentMilestoneWithTemplate = AgentMilestone & { template: MilestoneTemplate };

/** A closed or open interval the counters are read inside. */
export type Window = { from: Date | null; to: Date | null };

export interface AgentMilestonesRepository {
  findActiveTemplates(): Promise<MilestoneTemplate[]>;
  findTemplates(): Promise<MilestoneTemplate[]>;
  findTemplate(id: string): Promise<MilestoneTemplate | null>;
  createTemplate(data: NewMilestoneTemplate): Promise<MilestoneTemplate>;
  updateTemplate(id: string, patch: MilestoneTemplatePatch): Promise<MilestoneTemplate>;

  /** The agent by profile id, for the console's read of somebody else's board. */
  findAgent(agentId: string): Promise<{ id: string; userId: string; tier: string } | null>;
  /** Idempotent: creates the agent's row for a template if it has none yet. */
  ensureAgentMilestone(agentId: string, templateId: string): Promise<unknown>;
  findForAgent(agentId: string): Promise<AgentMilestoneWithTemplate[]>;
  findById(id: string): Promise<AgentMilestoneWithTemplate | null>;
  /** The cache write: the derived progress, and the completion the first time it is reached. */
  writeDerived(id: string, data: { progress: number; completedAt?: Date; computedAt: Date }): Promise<unknown>;
  claim(id: string, data: { claimedAt: Date; incentiveId: string }): Promise<AgentMilestoneWithTemplate>;

  /* The counters progress is derived from. None of these are new facts; they
   * are the same rows the ladder, the visits list and the wallet read. */
  countOnboarded(agentId: string, window: Window): Promise<number>;
  countActivity(agentId: string, userId: string, window: Window): Promise<number>;
  sumCreditedIncentives(agentId: string, window: Window): Promise<Decimal>;
  countOnTimeArrivals(agentId: string, window: Window): Promise<number>;
}
