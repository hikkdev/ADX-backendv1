import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { z } from 'zod';
import type { OrderMilestoneType, OrderMilestoneStatus } from '../generated/prisma';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MilestoneRequirement =
  | { kind: 'photo'; label: string }
  | { kind: 'checklist_item'; label: string }
  | { kind: 'qr_scan' }
  | { kind: 'location_checkin' }
  | { kind: 'contact_details_visible' };

export type EvidenceInput = {
  kind: string;
  label?: string;
  value: string;
};

// contact_details_visible is informational only — not submittable as evidence
const VALID_EVIDENCE_KINDS = ['photo', 'checklist_item', 'qr_scan', 'location_checkin'] as const;

const requirementRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), label: z.string() }),
  z.object({ kind: z.literal('checklist_item'), label: z.string() }),
  z.object({ kind: z.literal('qr_scan') }),
  z.object({ kind: z.literal('location_checkin') }),
  z.object({ kind: z.literal('contact_details_visible') }),
]);

function parseRequirements(raw: unknown): MilestoneRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const parsed = requirementRowSchema.safeParse(r);
    return parsed.success ? [parsed.data as MilestoneRequirement] : [];
  });
}

// ─── Template CRUD ────────────────────────────────────────────────────────────

export async function createOrderMilestoneTemplate(data: {
  title: string;
  description?: string;
  type: OrderMilestoneType;
  requirements: MilestoneRequirement[];
  estimatedDurationMins?: number;
}) {
  return prisma.orderMilestoneTemplate.create({ data: { ...data, requirements: data.requirements as object[] } });
}

export async function listOrderMilestoneTemplates(isActive?: boolean) {
  return prisma.orderMilestoneTemplate.findMany({
    where: isActive !== undefined ? { isActive } : {},
    orderBy: { createdAt: 'asc' },
  });
}

export async function getOrderMilestoneTemplate(id: string) {
  const t = await prisma.orderMilestoneTemplate.findUnique({ where: { id } });
  if (!t) throw new ApiError(404, 'NOT_FOUND', 'Milestone template not found');
  return t;
}

export async function updateOrderMilestoneTemplate(id: string, patch: {
  title?: string;
  description?: string;
  requirements?: MilestoneRequirement[];
  estimatedDurationMins?: number;
  isActive?: boolean;
}) {
  await getOrderMilestoneTemplate(id);
  const { requirements, ...rest } = patch;
  return prisma.orderMilestoneTemplate.update({
    where: { id },
    data: { ...rest, ...(requirements ? { requirements: requirements as object[] } : {}) },
  });
}

// ─── Plan CRUD ────────────────────────────────────────────────────────────────

export async function createMilestonePlan(data: { name: string; description?: string }) {
  return prisma.milestonePlan.create({ data });
}

export async function listMilestonePlans() {
  return prisma.milestonePlan.findMany({
    include: { items: { include: { template: true }, orderBy: { order: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getMilestonePlan(id: string) {
  const plan = await prisma.milestonePlan.findUnique({
    where: { id },
    include: { items: { include: { template: true }, orderBy: { order: 'asc' } } },
  });
  if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Milestone plan not found');
  return plan;
}

export async function updateMilestonePlan(id: string, patch: { name?: string; description?: string; isActive?: boolean }) {
  await getMilestonePlan(id);
  return prisma.milestonePlan.update({ where: { id }, data: patch });
}

export async function replacePlanItems(planId: string, items: { templateId: string; order: number; isOptional?: boolean }[]) {
  await getMilestonePlan(planId);

  const orders = items.map((i) => i.order);
  if (new Set(orders).size !== orders.length) throw new ApiError(400, 'BAD_REQUEST', 'Duplicate order values are not allowed');

  const templateIds = items.map((i) => i.templateId);
  const templates = await prisma.orderMilestoneTemplate.findMany({ where: { id: { in: templateIds } } });
  if (templates.length !== templateIds.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more templateIds not found');
  const inactive = templates.filter((t) => !t.isActive);
  if (inactive.length > 0) throw new ApiError(400, 'BAD_REQUEST', `Inactive templates cannot be added to a plan: ${inactive.map((t) => t.id).join(', ')}`);

  return prisma.$transaction(async (tx) => {
    await tx.milestonePlanItem.deleteMany({ where: { planId } });
    return tx.milestonePlanItem.createMany({
      data: items.map((i) => ({ planId, templateId: i.templateId, order: i.order, isOptional: i.isOptional ?? false })),
    });
  });
}

// ─── Order Milestone Management ───────────────────────────────────────────────

export async function getOrderMilestones(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  return prisma.orderMilestone.findMany({
    where: { orderId },
    include: { template: true, assignedAgent: { include: { user: true } }, evidence: true },
    orderBy: { order: 'asc' },
  });
}

export async function addMilestoneToOrder(orderId: string, data: {
  templateId: string;
  order?: number;
  isOptional?: boolean;
  dueDate?: Date;
  notes?: string;
}) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot add milestones to a finalized order');
  }

  // Validate template exists and is active (I7)
  const template = await prisma.orderMilestoneTemplate.findUnique({ where: { id: data.templateId } });
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Milestone template not found');
  if (!template.isActive) throw new ApiError(400, 'BAD_REQUEST', 'Milestone template is not active');

  let milestoneOrder = data.order;
  if (milestoneOrder === undefined) {
    const last = await prisma.orderMilestone.findFirst({ where: { orderId }, orderBy: { order: 'desc' } });
    milestoneOrder = (last?.order ?? 0) + 1;
  }

  return prisma.orderMilestone.create({
    data: {
      orderId,
      templateId: data.templateId,
      order: milestoneOrder,
      isOptional: data.isOptional ?? false,
      dueDate: data.dueDate,
      notes: data.notes,
      status: 'PENDING',
    },
    include: { template: true },
  });
}

export async function updateOrderMilestone(milestoneId: string, patch: {
  assignedAgentId?: string;
  order?: number;
  dueDate?: Date | null;
  notes?: string;
  status?: 'SKIPPED';
}) {
  const milestone = await prisma.orderMilestone.findUnique({
    where: { id: milestoneId },
    include: { orderRecord: { select: { status: true } } },
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (['COMPLETED', 'CANCELLED'].includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot modify milestones on a finalized order');
  }

  if (patch.assignedAgentId) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: patch.assignedAgentId }, select: { id: true } });
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  }

  if (patch.status === 'SKIPPED') {
    if (!['PENDING', 'DISPATCHED', 'IN_PROGRESS'].includes(milestone.status)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Only PENDING, DISPATCHED, or IN_PROGRESS milestones can be skipped');
    }
    // SKIPPED takes priority — no auto-dispatch side-effect
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: { status: 'SKIPPED', order: patch.order, dueDate: patch.dueDate, notes: patch.notes },
      include: { template: true, assignedAgent: { include: { user: true } } },
    });
  }

  // Auto-set DISPATCHED when assigning an agent to a PENDING milestone
  const statusUpdate = patch.assignedAgentId && milestone.status === 'PENDING' ? { status: 'DISPATCHED' as const } : {};

  return prisma.orderMilestone.update({
    where: { id: milestoneId },
    data: { ...patch, ...statusUpdate },
    include: { template: true, assignedAgent: { include: { user: true } } },
  });
}

export async function removeOrderMilestone(milestoneId: string) {
  const milestone = await prisma.orderMilestone.findUnique({
    where: { id: milestoneId },
    include: { orderRecord: { select: { status: true } } },
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (['COMPLETED', 'CANCELLED', 'VERIFICATION'].includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot remove milestones from an order in this state');
  }

  // Atomic delete — only succeeds if status is still PENDING or DISPATCHED
  const result = await prisma.orderMilestone.deleteMany({
    where: { id: milestoneId, status: { in: ['PENDING', 'DISPATCHED'] } },
  });
  if (result.count === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Only PENDING or DISPATCHED milestones can be removed');
  }
}

// ─── Auto-assignment ──────────────────────────────────────────────────────────

export async function autoAssignMilestones(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: true },
  });
  if (!order) return;

  // Idempotency: skip if milestones already exist for this order
  const existing = await prisma.orderMilestone.count({ where: { orderId } });
  if (existing > 0) return;

  // Use the listing directly from the order
  const listing = await prisma.listing.findUnique({
    where: { id: order.listingId },
  });

  let planId: string | null = listing?.planId ?? null;

  // Fall back to category default from AppConfig
  if (!planId && listing?.category) {
    const config = await prisma.appConfig.findUnique({ where: { key: 'categoryPlans' } });
    if (config?.value && typeof config.value === 'object' && !Array.isArray(config.value)) {
      const candidate = (config.value as Record<string, unknown>)[listing.category];
      if (typeof candidate === 'string') planId = candidate;
    }
  }

  if (!planId) return;

  const plan = await prisma.milestonePlan.findUnique({
    where: { id: planId },
    include: { items: { orderBy: { order: 'asc' } } },
  });
  if (!plan || !plan.isActive) return;

  await prisma.orderMilestone.createMany({
    data: plan.items.map((item) => ({
      orderId,
      templateId: item.templateId,
      planId,
      order: item.order,
      isOptional: item.isOptional,
      assignedAgentId: order.agentId,
      status: 'DISPATCHED' as OrderMilestoneStatus,
    })),
  });
}

// ─── Agent Execution ──────────────────────────────────────────────────────────

export async function getAgentMilestones(agentId: string) {
  return prisma.orderMilestone.findMany({
    where: {
      assignedAgentId: agentId,
      status: { in: ['DISPATCHED', 'IN_PROGRESS'] },
    },
    include: {
      template: true,
      orderRecord: { include: { listing: { include: { publisher: true } } } },
      evidence: true,
    },
    orderBy: [{ dueDate: 'asc' }, { order: 'asc' }],
  });
}

export async function getMilestoneDetail(milestoneId: string, agentId: string) {
  const milestone = await prisma.orderMilestone.findUnique({
    where: { id: milestoneId },
    include: {
      template: true,
      orderRecord: { include: { listing: { include: { publisher: true } } } },
      evidence: true,
    },
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  return milestone;
}

export async function startMilestone(milestoneId: string, agentId: string) {
  const milestone = await prisma.orderMilestone.findUnique({
    where: { id: milestoneId },
    include: { template: true, orderRecord: { select: { status: true } } },
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  if (['CANCELLED', 'COMPLETED'].includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot work on a milestone for a finalized order');
  }

  // Idempotent: already started by this agent — return current state
  if (milestone.status === 'IN_PROGRESS') return milestone;

  if (milestone.status !== 'DISPATCHED') throw new ApiError(400, 'BAD_REQUEST', 'Milestone must be DISPATCHED to start');

  return prisma.orderMilestone.update({
    where: { id: milestoneId },
    data: { status: 'IN_PROGRESS', startedAt: new Date() },
    include: { template: true },
  });
}

export async function completeMilestone(milestoneId: string, agentId: string, evidence: EvidenceInput[]) {
  const milestone = await prisma.orderMilestone.findUnique({
    where: { id: milestoneId },
    include: { template: true, orderRecord: { select: { status: true } } },
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (milestone.assignedAgentId !== agentId) throw new ApiError(403, 'FORBIDDEN', 'This milestone is not assigned to you');
  if (['CANCELLED', 'COMPLETED'].includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot complete a milestone for a finalized order');
  }
  if (milestone.status !== 'IN_PROGRESS') throw new ApiError(400, 'BAD_REQUEST', 'Milestone must be IN_PROGRESS to complete');

  // Reject evidence with unknown kind values (C6)
  const invalidKinds = evidence.filter((e) => !(VALID_EVIDENCE_KINDS as readonly string[]).includes(e.kind));
  if (invalidKinds.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Invalid evidence kind(s): ${invalidKinds.map((e) => e.kind).join(', ')}`);
  }

  // Dedupe evidence by (kind, label) — last entry wins (C1)
  const evidenceMap = new Map<string, EvidenceInput>();
  for (const e of evidence) {
    const key = `${e.kind}::${e.label ?? ''}`;
    evidenceMap.set(key, e);
  }
  const dedupedEvidence = Array.from(evidenceMap.values());

  const requirements = parseRequirements(milestone.template.requirements);
  const missing: string[] = [];

  for (const req of requirements) {
    if (req.kind === 'contact_details_visible') continue; // informational only

    const submitted = dedupedEvidence.find((e) => {
      if (e.kind !== req.kind) return false;
      if (req.kind === 'photo' || req.kind === 'checklist_item') return e.label === req.label;
      return true;
    });

    if (!submitted) {
      missing.push(req.kind === 'photo' || req.kind === 'checklist_item' ? `${req.kind}: ${req.label}` : req.kind);
      continue;
    }

    // Normalize before comparison: trim + lowercase (C2)
    if (req.kind === 'checklist_item' && submitted.value.trim().toLowerCase() !== 'true') {
      missing.push(`checklist_item: ${req.label} (must be confirmed)`);
    }
  }

  if (missing.length > 0) {
    throw new ApiError(400, 'EVIDENCE_INCOMPLETE', `Missing required evidence: ${missing.join(', ')}`);
  }

  return prisma.$transaction(async (tx) => {
    // Atomic status flip: only succeeds if still IN_PROGRESS (prevents double-completion)
    const updated = await tx.orderMilestone.updateMany({
      where: { id: milestoneId, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new ApiError(409, 'CONFLICT', 'Milestone was already completed by a concurrent request');
    }
    await tx.orderMilestoneEvidence.createMany({
      data: dedupedEvidence.map((e) => ({ milestoneId, kind: e.kind, label: e.label, value: e.value })),
    });
    return tx.orderMilestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { template: true, evidence: true },
    });
  });
}
