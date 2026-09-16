import type {
  MilestonePlan,
  OrderMilestone,
  OrderMilestoneStatus,
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

export type NewReinstallMilestone = {
  orderId: string;
  templateId: string;
  order: number;
  assignedAgentId: string | null;
  reinstallOfDisputeId: string;
  notes: string;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
};

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
  /* A12: stamped by the service when an assignment is an offer. */
  offeredAt?: Date | null;
  offerExpiresAt?: Date | null;
  acceptedAt?: Date | null;
  rejectionReason?: string | null;
};

/** Milestone joined to the parent order, for the finalised-order guards and the slot window. */
export type MilestoneWithOrderStatus = OrderMilestone & {
  template: OrderMilestoneTemplate;
  orderRecord: { status: string; agentId: string | null; startDate: Date | null; endDate: Date | null };
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

  // Lot D (Q54/Q92): the re-install a dispute raises
  /** The first active template of a type — the INSTALLATION step a re-install is built from. */
  findActiveTemplateByType(type: OrderMilestoneType): Promise<OrderMilestoneTemplate | null>;
  /**
   * A re-install milestone: DISPATCHED as an offer when an agent is named
   * (the window stamped), PENDING and unassigned otherwise, and always
   * carrying the dispute it answers.
   */
  createReinstall(data: NewReinstallMilestone): Promise<OrderMilestone>;
  /** The status of each milestone named — what a dispute reads to say whether its re-install is still pending. */
  findStatuses(milestoneIds: string[]): Promise<{ id: string; status: OrderMilestoneStatus }[]>;

  // Agent execution
  findForAgent(agentId: string): Promise<unknown[]>;
  findDetail(milestoneId: string): Promise<(OrderMilestone & { template: unknown }) | null>;
  start(milestoneId: string): Promise<unknown>;
  /** Flips to COMPLETED and stores evidence atomically. */
  complete(milestoneId: string, evidence: EvidenceInput[]): Promise<unknown>;

  // A12: the offer on a dispatched visit
  accept(milestoneId: string, at: Date): Promise<unknown>;
  /** Back to PENDING, unassigned, the reason kept for ops. */
  reject(milestoneId: string, reason: string): Promise<unknown>;
  schedule(milestoneId: string, start: Date, end: Date): Promise<unknown>;
  /** DISPATCHED and still held by this agent — what STOP_OPEN_WORK returns to ADX. */
  findDispatchedForAgent(agentId: string): Promise<{ id: string; orderId: string }[]>;
  /** Unanswered offers whose window closed in [windowStart, now]. */
  findOfferExpired(windowStart: Date, now: Date): Promise<{ id: string; orderId: string; assignedAgentId: string | null }[]>;
  /** Starts other milestones on the order already hold, so two visits are not booked into one band. */
  findScheduledStartsForOrder(orderId: string, exceptMilestoneId: string): Promise<Date[]>;
}
