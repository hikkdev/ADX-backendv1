import type {
  MilestonePlan,
  OrderMilestone,
  OrderMilestoneTemplate,
  OrderMilestoneType,
} from '../../shared/database';
import type { EvidenceInput, MilestoneRequirement } from './order-milestones.types';

export type NewTemplate = {
  title: string;
  description?: string;
  type: OrderMilestoneType;
  requirements: MilestoneRequirement[];
  estimatedDurationMins?: number;
};

export type TemplatePatch = {
  title?: string;
  description?: string;
  requirements?: MilestoneRequirement[];
  estimatedDurationMins?: number;
  isActive?: boolean;
};

export type PlanItemInput = { templateId: string; order: number; isOptional?: boolean };

export type NewOrderMilestone = {
  orderId: string;
  templateId: string;
  order: number;
  isOptional: boolean;
  dueDate?: Date;
  notes?: string;
};

export type OrderMilestonePatch = {
  assignedAgentId?: string;
  order?: number;
  dueDate?: Date | null;
  notes?: string;
  status?: 'SKIPPED' | 'DISPATCHED';
};

/** Milestone joined to the parent order's status, for finalised-order guards. */
export type MilestoneWithOrderStatus = OrderMilestone & {
  template: OrderMilestoneTemplate;
  orderRecord: { status: string };
};

export interface OrderMilestonesRepository {
  // Templates
  createTemplate(data: NewTemplate): Promise<OrderMilestoneTemplate>;
  listTemplates(isActive?: boolean): Promise<OrderMilestoneTemplate[]>;
  findTemplate(id: string): Promise<OrderMilestoneTemplate | null>;
  findTemplatesByIds(ids: string[]): Promise<OrderMilestoneTemplate[]>;
  updateTemplate(id: string, patch: TemplatePatch): Promise<OrderMilestoneTemplate>;

  // Plans
  createPlan(data: { name: string; description?: string }): Promise<MilestonePlan>;
  listPlans(): Promise<MilestonePlan[]>;
  findPlan(id: string): Promise<MilestonePlan | null>;
  findPlanWithItems(id: string): Promise<(MilestonePlan & { items: unknown[] }) | null>;
  updatePlan(
    id: string,
    patch: { name?: string; description?: string; isActive?: boolean },
  ): Promise<MilestonePlan>;
  /** Deletes and recreates a plan's items in one transaction. */
  replacePlanItems(planId: string, items: PlanItemInput[]): Promise<unknown>;

  // Per-order milestones
  findForOrder(orderId: string): Promise<unknown[]>;
  countForOrder(orderId: string): Promise<number>;
  findLastOrderIndex(orderId: string): Promise<number | null>;
  createForOrder(data: NewOrderMilestone): Promise<unknown>;
  createManyForOrder(
    rows: {
      orderId: string;
      templateId: string;
      planId: string;
      order: number;
      isOptional: boolean;
      assignedAgentId: string | null;
    }[],
  ): Promise<unknown>;
  findWithOrderStatus(milestoneId: string): Promise<MilestoneWithOrderStatus | null>;
  updateMilestone(milestoneId: string, patch: OrderMilestonePatch): Promise<unknown>;
  /** Deletes only while still PENDING or DISPATCHED; returns rows removed. */
  deleteIfRemovable(milestoneId: string): Promise<number>;

  // Agent execution
  findForAgent(agentId: string): Promise<unknown[]>;
  findDetail(milestoneId: string): Promise<(OrderMilestone & { template: unknown }) | null>;
  start(milestoneId: string): Promise<unknown>;
  /** Flips to COMPLETED and stores evidence atomically. */
  complete(milestoneId: string, evidence: EvidenceInput[]): Promise<unknown>;
}
