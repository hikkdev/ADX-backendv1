import type { MilestoneType } from '../../../shared/database';
import { prismaAgentMilestonesRepository as repository } from './prisma-agent-milestones.repository';
import type { NewMilestoneTemplate, NewTrainingResource } from './agent-milestones.repository';

/**
 * An agent's milestone board.
 *
 * Rows are materialised lazily: every active template the agent has no row for
 * is created on read, so adding a template makes it appear for everyone without
 * a backfill.
 */
export async function getMilestonesForAgent(agentId: string) {
  const templates = await repository.findActiveTemplates();

  await Promise.all(
    templates.map((template) => repository.ensureAgentMilestone(agentId, template.id)),
  );

  return repository.findForAgent(agentId);
}

/**
 * Advances every incomplete milestone of a given type by one, completing any
 * that reach their target.
 */
export async function incrementMilestoneProgress(agentId: string, type: MilestoneType) {
  const milestones = await repository.findIncompleteForAgent(agentId);
  const relevant = milestones.filter((m) => m.template.type === type);

  for (const milestone of relevant) {
    const newProgress = milestone.progress + 1;
    await repository.updateProgress(
      milestone.id,
      newProgress,
      newProgress >= milestone.template.target,
    );
  }
}

export async function createMilestoneTemplate(data: NewMilestoneTemplate) {
  return repository.createTemplate(data);
}

export async function getTrainingResources(opts: { category?: string; search?: string } = {}) {
  return repository.findTrainingResources(opts);
}

export async function createTrainingResource(data: NewTrainingResource) {
  return repository.createTrainingResource(data);
}
