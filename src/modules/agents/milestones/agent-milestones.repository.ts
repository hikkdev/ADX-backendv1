import type {
  AgentMilestone,
  MilestoneTemplate,
  MilestoneType,
  TrainingResource,
} from '../../../shared/database';

export type NewMilestoneTemplate = {
  type: MilestoneType;
  title: string;
  description: string;
  target: number;
  rewardAmount?: number;
};

export type NewTrainingResource = {
  title: string;
  category: string;
  duration?: string;
  subtitle?: string;
  topic?: string;
  status?: string;
  statusVariant?: string;
  videoUrl?: string;
  documentUrl?: string;
};

export type AgentMilestoneWithTemplate = AgentMilestone & { template: MilestoneTemplate };

export interface AgentMilestonesRepository {
  findActiveTemplates(): Promise<MilestoneTemplate[]>;
  /** Idempotent: creates the agent's row for a template if it has none yet. */
  ensureAgentMilestone(agentId: string, templateId: string): Promise<unknown>;
  findForAgent(agentId: string): Promise<AgentMilestoneWithTemplate[]>;
  findIncompleteForAgent(agentId: string): Promise<AgentMilestoneWithTemplate[]>;
  updateProgress(id: string, progress: number, completed: boolean): Promise<unknown>;
  createTemplate(data: NewMilestoneTemplate): Promise<MilestoneTemplate>;
  findTrainingResources(opts: {
    category?: string;
    search?: string;
  }): Promise<TrainingResource[]>;
  createTrainingResource(data: NewTrainingResource): Promise<TrainingResource>;
}
