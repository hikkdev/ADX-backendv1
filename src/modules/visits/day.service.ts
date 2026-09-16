import { dayWindowIST } from '../../shared/time';
import { getAgentMilestones } from '../order-milestones';
import { getAgentOrdersInWindow } from '../orders';
import { requireAgentProfile } from '../agents';
import { visitKindLabel } from './visits.schema';
import { outcomesFor, visitsInRange, visitsToday, type VisitCard } from './visits.service';

/**
 * GET /agents/me/day — the agent's day in one call.
 *
 * Lives in `visits` rather than `agents` because it is composed of visits:
 * `visits` already reads `agents` for the profile, and `agents` reading back
 * for the day would close a cycle that breaks at runtime under CommonJS. The
 * URL stays under /agents/me because that is where an agent's own things live;
 * bootstrap mounts this module's second router there.
 *
 * Before this the app read `/agents/me` for two integers, `/agent/milestones`
 * for the whole open queue and `/orders/my` for every order, then merged them
 * on the phone against two different time fields, re-implementing the +05:30
 * boundary that the server already computes. Now the day is assembled here,
 * against `dayWindowIST`, and the phone reads one answer.
 *
 * Three kinds of thing, one list, sorted by when: a job (an order with a slot
 * today), a site visit (an OrderMilestone the agent holds), and a field visit
 * (an onboarding or renewal call that is not on an order).
 */
export type DayEntry = {
  kind: 'JOB' | 'SITE_VISIT' | 'FIELD_VISIT';
  id: string;
  title: string;
  where: string | null;
  at: string | null;
  status: string;
  /** Lot B (Q1), field visits only: "1 sale, 1 campaign launched", or null. */
  outcome?: string | null;
  /** E7-2, field visits only: the visit's own kind (ONBOARDING … AUDIT), so the card can draw the chip without parsing the title. */
  visitKind?: string;
  /** E7-2, field visits only: the drive the visit belongs to, or null. */
  campaignTag?: string | null;
};

export type AgentDay = {
  date: string;
  entries: DayEntry[];
  counts: { jobs: number; siteVisits: number; fieldVisits: number };
};

/**
 * Lot E (Q99): a day-view row with a console link — what the staff diary
 * overlays for a person who is also an agent. Same three kinds, same fold.
 */
export type OverlayEntry = DayEntry & { link: string };

type Window = { start: Date; end: Date };
type OrderRow = { id: string; campaignName?: string | null; status: string; slotTime?: Date | null; listing?: { address?: string | null } };
type MilestoneRow = {
  id: string;
  orderId?: string;
  status: string;
  scheduledStart?: Date | null;
  dueDate?: Date | null;
  template?: { title?: string };
  order?: { listing?: { address?: string | null } };
};

/* ── the fold: three tables onto one row shape ─────────────────────────── */

const foldJobs = (orders: OrderRow[]): OverlayEntry[] =>
  orders.map((order) => ({
    kind: 'JOB',
    id: order.id,
    title: order.campaignName ?? 'Order',
    where: order.listing?.address ?? null,
    at: order.slotTime?.toISOString() ?? null,
    status: order.status,
    link: `/orders/${order.id}`,
  }));

/**
 * The open queue is not date-bound; the window keeps what is due inside it
 * or already in hand, and leaves the rest for the queue screen.
 */
const foldSiteVisits = (milestones: MilestoneRow[], window: Window): OverlayEntry[] =>
  milestones
    .filter((m) => {
      const due = m.scheduledStart ?? m.dueDate ?? null;
      return m.status === 'IN_PROGRESS' || (due !== null && due >= window.start && due < window.end);
    })
    .map((m) => ({
      kind: 'SITE_VISIT' as const,
      id: m.id,
      title: m.template?.title ?? 'Site visit',
      where: m.order?.listing?.address ?? null,
      at: (m.scheduledStart ?? m.dueDate)?.toISOString() ?? null,
      status: m.status,
      link: m.orderId ? `/orders/${m.orderId}/milestones/${m.id}` : `/agent/milestones/${m.id}`,
    }));

/**
 * What came of each visit, counted off the sales and campaigns that name it.
 * A count that cannot be read prints nothing rather than failing the day.
 */
async function foldFieldVisits(visits: VisitCard[]): Promise<OverlayEntry[]> {
  const outcomes = await Promise.all(
    visits.map((visit) => outcomesFor(visit.id).then((o) => o.summary).catch(() => null)),
  );
  return visits.map((visit, index) => ({
    kind: 'FIELD_VISIT',
    id: visit.id,
    title: `${visitKindLabel(visit.kind)} · ${visit.businessName}`,
    where: visit.locality ?? visit.city,
    at: visit.scheduledFor,
    status: visit.status,
    outcome: outcomes[index] ?? null,
    visitKind: visit.kind,
    campaignTag: visit.campaignTag,
    link: `/visits/${visit.id}`,
  }));
}

/** Unslotted first — a request with no time needs answering before the day starts — then by time. */
const byWhen = (a: DayEntry, b: DayEntry): number => {
  if (a.at === null && b.at !== null) return -1;
  if (a.at !== null && b.at === null) return 1;
  return (a.at ?? '').localeCompare(b.at ?? '');
};

export async function getAgentDay(userId: string, now = new Date()): Promise<AgentDay> {
  const me = await requireAgentProfile(userId);
  const window = dayWindowIST(now);

  const [orders, milestones, fieldVisits] = await Promise.all([
    getAgentOrdersInWindow(me.id, window),
    getAgentMilestones(me.id),
    visitsToday(me.id, now),
  ]);

  const jobs = foldJobs(orders as OrderRow[]);
  const site = foldSiteVisits(milestones as MilestoneRow[], window);
  const field = await foldFieldVisits(fieldVisits);

  // The phone's day view never carried links; the shape stays as it was.
  const entries: DayEntry[] = [...jobs, ...site, ...field].sort(byWhen).map(({ link: _link, ...entry }) => entry);

  return {
    date: window.start.toISOString().slice(0, 10),
    entries,
    counts: { jobs: jobs.length, siteVisits: site.length, fieldVisits: field.length },
  };
}

/**
 * Lot E (Q99): the same fold over a range, for `schedule`'s overlay — the
 * agent's field visits, site visits and jobs between two dates, read-only,
 * each row carrying where the console goes to open it. `include` says which
 * tables to ask at all: a diary of staff meetings does not need the orders
 * table walked for every agent on the grid.
 *
 * Lives here for the reason the day does: `visits` already reads `agents`,
 * `orders` and `order-milestones`, and `schedule` reads `visits` — one
 * direction, no cycle.
 */
export async function agentWorkInWindow(
  agentProfileId: string,
  window: Window,
  include: { visits: boolean; milestones: boolean; jobs: boolean },
  now = new Date(),
): Promise<OverlayEntry[]> {
  const [orders, milestones, fieldVisits] = await Promise.all([
    include.jobs ? getAgentOrdersInWindow(agentProfileId, window) : Promise.resolve([]),
    include.milestones ? getAgentMilestones(agentProfileId) : Promise.resolve([]),
    include.visits ? visitsInRange(agentProfileId, window, now) : Promise.resolve([]),
  ]);
  const rows = [
    ...foldJobs(orders as OrderRow[]),
    ...foldSiteVisits(milestones as MilestoneRow[], window),
    ...(await foldFieldVisits(fieldVisits)),
  ];
  return rows.sort(byWhen);
}
