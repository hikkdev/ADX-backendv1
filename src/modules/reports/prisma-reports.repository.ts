import type { OnboardingBoardRow } from './reports.repository';
import { Prisma, prisma } from '../../shared/database';
import { countsFrom, listArgs, type ListQuery } from '../../shared/pagination';
import {
  MAILED_KEY,
  REPORT_RUN_STATUSES,
  SCHEDULE_STATUSES,
  type AdvertiserRefundRow,
  type AdvertiserSpendRow,
  type AgentCommissionRow,
  type BookingRow,
  type CampaignMetricRow,
  type DeliveryCountRow,
  type DisputeRow,
  type FraudCaseRow,
  type FunnelRow,
  type KycAgeingRow,
  type ListingRow,
  type NewReportRun,
  type NewReportSchedule,
  type PlatformSummary,
  type PublisherEarningsRow,
  type PublisherPayoutRow,
  type ReportData,
  type ReportRunPatch,
  type ReportSchedulePatch,
  type ReportsRepository,
  type RunFilter,
  type ScheduleFilter,
  type SupportTicketRow,
  type Window,
} from './reports.repository';

const ZERO = new Prisma.Decimal(0);
const between = (window: Window) => ({ gte: window.start, lt: window.end });
const orderBy = (page: ListQuery) => ({ createdAt: page.sort === 'oldest' ? ('asc' as const) : ('desc' as const) });
const insensitive = (value: string) => ({ equals: value, mode: 'insensitive' as const });

/* ── The module's own tables ─────────────────────────────────────── */

function runWhere(filter: RunFilter, withStatus: boolean): Prisma.ReportRunWhereInput {
  return {
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.scheduleId ? { scheduleId: filter.scheduleId } : {}),
    ...(filter.q ? { kind: { contains: filter.q, mode: 'insensitive' } } : {}),
    ...(withStatus && filter.status?.length ? { status: { in: [...filter.status] } } : {}),
  };
}

function scheduleWhere(filter: ScheduleFilter, withStatus: boolean): Prisma.ReportScheduleWhereInput {
  const enabled = withStatus && filter.status?.length === 1 ? filter.status[0] === 'ENABLED' : undefined;
  return {
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { kind: { contains: filter.q, mode: 'insensitive' } }] } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

export const prismaReportsRepository: ReportsRepository = {
  createRun(data: NewReportRun) {
    return prisma.reportRun.create({
      data: {
        kind: data.kind,
        format: data.format,
        scheduleId: data.scheduleId,
        requestedById: data.requestedById,
        filters: data.filters ?? Prisma.JsonNull,
      },
    });
  },

  updateRun(id: string, patch: ReportRunPatch) {
    return prisma.reportRun.update({ where: { id }, data: patch });
  },

  findRun(id: string) {
    return prisma.reportRun.findUnique({ where: { id } });
  },

  async recordMailed(id: string, mailed: { to: number; at: Date }) {
    // G11-2: no column for it yet — merged under the reserved key of the
    // filters JSON, the declared filters untouched (schema need: two columns).
    const row = await prisma.reportRun.findUniqueOrThrow({ where: { id }, select: { filters: true } });
    const filters = row.filters && typeof row.filters === 'object' && !Array.isArray(row.filters) ? (row.filters as Prisma.JsonObject) : {};
    return prisma.reportRun.update({
      where: { id },
      data: { filters: { ...filters, [MAILED_KEY]: { to: mailed.to, at: mailed.at.toISOString() } } },
    });
  },

  async listRuns(filter: RunFilter, page: ListQuery) {
    const where = runWhere(filter, true);
    const [items, total, groups] = await Promise.all([
      prisma.reportRun.findMany({ where, orderBy: { startedAt: page.sort === 'oldest' ? 'asc' : 'desc' }, ...listArgs(page) }),
      prisma.reportRun.count({ where }),
      prisma.reportRun.groupBy({ by: ['status'], where: runWhere(filter, false), _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, REPORT_RUN_STATUSES) };
  },

  createSchedule(data: NewReportSchedule) {
    return prisma.reportSchedule.create({
      data: {
        kind: data.kind,
        name: data.name,
        cadence: data.cadence,
        format: data.format,
        recipients: data.recipients,
        filters: data.filters ?? Prisma.JsonNull,
        enabled: data.enabled,
        createdById: data.createdById,
        nextRunAt: data.nextRunAt,
      },
    });
  },

  findSchedule(id: string) {
    return prisma.reportSchedule.findUnique({ where: { id } });
  },

  async listSchedules(filter: ScheduleFilter, page: ListQuery) {
    const where = scheduleWhere(filter, true);
    const [items, total, enabledCount, disabledCount] = await Promise.all([
      prisma.reportSchedule.findMany({ where, orderBy: orderBy(page), ...listArgs(page) }),
      prisma.reportSchedule.count({ where }),
      prisma.reportSchedule.count({ where: { ...scheduleWhere(filter, false), enabled: true } }),
      prisma.reportSchedule.count({ where: { ...scheduleWhere(filter, false), enabled: false } }),
    ]);
    const counts: Record<string, number> = {};
    for (const status of SCHEDULE_STATUSES) counts[status] = status === 'ENABLED' ? enabledCount : disabledCount;
    return { items, total, counts };
  },

  updateSchedule(id: string, patch: ReportSchedulePatch) {
    const { filters, ...rest } = patch;
    return prisma.reportSchedule.update({
      where: { id },
      data: { ...rest, ...(filters !== undefined ? { filters: filters ?? Prisma.JsonNull } : {}) },
    });
  },

  async deleteSchedule(id: string) {
    await prisma.reportSchedule.delete({ where: { id } });
  },

  findDueSchedules(now: Date) {
    return prisma.reportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' } });
  },

  findRunsStartedSince(since: Date) {
    return prisma.reportRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: 'desc' } });
  },

  async enabledScheduleRecipients() {
    const rows = await prisma.reportSchedule.findMany({ where: { enabled: true }, select: { recipients: true } });
    return rows.map((row) => row.recipients);
  },

  async adminEmails() {
    const rows = await prisma.user.findMany({
      where: { isActive: true, closedAt: null, email: { not: null }, roles: { some: { role: 'ADMIN' } } },
      select: { email: true },
    });
    return rows.map((row) => row.email).filter((email): email is string => Boolean(email));
  },
};

/* ── The twelve reads ────────────────────────────────────────────── */

const sum = (value: Prisma.Decimal | null | undefined) => value ?? ZERO;

export const prismaReportData: ReportData = {
  async bookings(window, f) {
    const advertiser = f.advertiserId ? { advertiserId: f.advertiserId } : {};
    const agent = f.agentId ? { agentId: f.agentId } : {};
    const [campaigns, packages] = await Promise.all([
      f.kind === 'PACKAGE'
        ? Promise.resolve([])
        : prisma.campaign.findMany({
            where: { paidAt: between(window), ...advertiser, ...agent },
            select: {
              reference: true,
              name: true,
              status: true,
              paidAt: true,
              spotsSubtotal: true,
              gstAmount: true,
              total: true,
              advertiser: { select: { name: true, displayId: true } },
              agent: { select: { displayId: true } },
            },
            orderBy: { paidAt: 'asc' },
          }),
      f.kind === 'CAMPAIGN'
        ? Promise.resolve([])
        : prisma.packageSale.findMany({
            where: { paidAt: between(window), ...advertiser, ...agent },
            select: {
              reference: true,
              packageName: true,
              status: true,
              paidAt: true,
              subtotal: true,
              gstAmount: true,
              total: true,
              advertiser: { select: { name: true, displayId: true } },
              agent: { select: { displayId: true } },
            },
            orderBy: { paidAt: 'asc' },
          }),
    ]);
    const rows: BookingRow[] = [
      ...campaigns.map((c) => ({
        kind: 'CAMPAIGN' as const,
        reference: c.reference,
        name: c.name,
        advertiserDisplayId: c.advertiser.displayId,
        advertiserName: c.advertiser.name,
        agentDisplayId: c.agent?.displayId ?? null,
        paidAt: c.paidAt,
        subtotal: c.spotsSubtotal,
        gst: c.gstAmount,
        total: c.total,
        status: c.status,
      })),
      ...packages.map((p) => ({
        kind: 'PACKAGE' as const,
        reference: p.reference,
        name: p.packageName,
        advertiserDisplayId: p.advertiser.displayId,
        advertiserName: p.advertiser.name,
        agentDisplayId: p.agent?.displayId ?? null,
        paidAt: p.paidAt,
        subtotal: p.subtotal,
        gst: p.gstAmount,
        total: p.total,
        status: p.status,
      })),
    ];
    return rows.sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0));
  },

  async publisherEarnings(window, f) {
    const groups = await prisma.earningAccrual.groupBy({
      by: ['publisherId'],
      where: {
        forDate: between(window),
        ...(f.publisherId ? { publisherId: f.publisherId } : {}),
        ...(f.city ? { publisher: { city: insensitive(f.city) } } : {}),
      },
      _sum: { gross: true, commission: true, taxWithheld: true, net: true },
      _count: { _all: true },
    });
    if (groups.length === 0) return [];
    const publishers = await prisma.publisher.findMany({
      where: { id: { in: groups.map((g) => g.publisherId) } },
      select: { id: true, displayId: true, name: true, city: true },
    });
    const byId = new Map(publishers.map((p) => [p.id, p]));
    const rows: PublisherEarningsRow[] = groups.map((g) => ({
      publisherId: g.publisherId,
      displayId: byId.get(g.publisherId)?.displayId ?? null,
      name: byId.get(g.publisherId)?.name ?? g.publisherId,
      city: byId.get(g.publisherId)?.city ?? null,
      gross: sum(g._sum.gross),
      commission: sum(g._sum.commission),
      taxWithheld: sum(g._sum.taxWithheld),
      net: sum(g._sum.net),
      accrualDays: g._count._all,
    }));
    return rows.sort((a, b) => b.net.comparedTo(a.net));
  },

  async publisherPayouts(window, publisherIds) {
    const paid = await prisma.withdrawalRequest.findMany({
      where: {
        status: 'PAID',
        paidAt: between(window),
        wallet: { publisherId: publisherIds ? { in: [...publisherIds] } : { not: null } },
      },
      select: { netAmount: true, wallet: { select: { publisherId: true } } },
    });
    const byPublisher = new Map<string, PublisherPayoutRow>();
    for (const row of paid) {
      const publisherId = row.wallet.publisherId;
      if (!publisherId) continue;
      const current = byPublisher.get(publisherId) ?? { publisherId, paidCount: 0, paidTotal: ZERO };
      byPublisher.set(publisherId, { publisherId, paidCount: current.paidCount + 1, paidTotal: current.paidTotal.plus(row.netAmount) });
    }
    return [...byPublisher.values()];
  },

  async advertiserSpend(window, f) {
    const advertiserWhere = {
      ...(f.advertiserId ? { advertiserId: f.advertiserId } : {}),
      ...(f.industry ? { advertiser: { industry: insensitive(f.industry) } } : {}),
    };
    const [campaigns, packages] = await Promise.all([
      prisma.campaign.groupBy({
        by: ['advertiserId'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, ...advertiserWhere },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.packageSale.groupBy({
        by: ['advertiserId'],
        where: { paidAt: between(window), status: { not: 'CANCELLED' }, ...advertiserWhere },
        _sum: { total: true },
        _count: { _all: true },
      }),
    ]);
    const ids = [...new Set([...campaigns.map((c) => c.advertiserId), ...packages.map((p) => p.advertiserId)])];
    if (ids.length === 0) return [];
    const advertisers = await prisma.advertiser.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayId: true, name: true, industry: true },
    });
    const campaignById = new Map(campaigns.map((c) => [c.advertiserId, c]));
    const packageById = new Map(packages.map((p) => [p.advertiserId, p]));
    const rows: AdvertiserSpendRow[] = advertisers.map((a) => ({
      advertiserId: a.id,
      displayId: a.displayId,
      name: a.name,
      industry: a.industry,
      campaignsPaid: campaignById.get(a.id)?._count._all ?? 0,
      campaignTotal: sum(campaignById.get(a.id)?._sum.total),
      packagesPaid: packageById.get(a.id)?._count._all ?? 0,
      packageTotal: sum(packageById.get(a.id)?._sum.total),
    }));
    return rows.sort((a, b) => b.campaignTotal.plus(b.packageTotal).comparedTo(a.campaignTotal.plus(a.packageTotal)));
  },

  async advertiserRefunds(window, advertiserIds) {
    const ids = advertiserIds ? { in: [...advertiserIds] } : undefined;
    const [gateway, wallet] = await Promise.all([
      prisma.paymentRefund.findMany({
        where: { status: 'PROCESSED', processedAt: between(window), ...(ids ? { payment: { advertiserId: ids } } : {}) },
        select: { amount: true, payment: { select: { advertiserId: true } } },
      }),
      prisma.walletRefundRequest.findMany({
        where: { status: 'PAID', paidAt: between(window), wallet: { advertiserId: ids ?? { not: null } } },
        select: { amount: true, wallet: { select: { advertiserId: true } } },
      }),
    ]);
    const rows = new Map<string, AdvertiserRefundRow>();
    const bump = (advertiserId: string | null, key: 'gatewayRefunds' | 'walletRefunds', amount: Prisma.Decimal) => {
      if (!advertiserId) return;
      const current = rows.get(advertiserId) ?? { advertiserId, gatewayRefunds: ZERO, walletRefunds: ZERO };
      rows.set(advertiserId, { ...current, [key]: current[key].plus(amount) });
    };
    for (const row of gateway) bump(row.payment.advertiserId, 'gatewayRefunds', row.amount);
    for (const row of wallet) bump(row.wallet.advertiserId, 'walletRefunds', row.amount);
    return [...rows.values()];
  },

  // QR-14: the team onboarding board — every party onboarded in the window, grouped by who did it.
  async onboardingBoard(window, f) {
    const scope = {
      onboardedAt: between(window),
      ...(f.via ? { onboardedVia: f.via } : {}),
      ...(f.role ? { onboardedByRole: f.role } : {}),
    };
    const sevenDays = 7 * 86_400_000;
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.findMany({
        where: { ...scope },
        select: {
          onboardedVia: true,
          onboardedById: true,
          onboardedByRole: true,
          onboardedAt: true,
          onboardingStatus: true,
          kycStatus: true,
          listings: { select: { status: true, updatedAt: true, _count: { select: { orders: true } } } },
        },
      }),
      prisma.advertiser.findMany({
        where: { ...scope },
        select: {
          onboardedVia: true,
          onboardedById: true,
          onboardedByRole: true,
          activatedAt: true,
          kycStatus: true,
          _count: { select: { campaigns: true } },
        },
      }),
    ]);
    const ids = [...new Set([...publishers, ...advertisers].map((r) => r.onboardedById).filter((id): id is string => Boolean(id)))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    const empty = (): OnboardingBoardRow => ({
      actorId: null,
      actorName: null,
      actorRole: null,
      via: { SELF: 0, AGENT: 0, QR: 0, DESK: 0, IMPORT: 0 },
      publishers: 0,
      advertisers: 0,
      onboarded: 0,
      completed: 0,
      liveWithin7d: 0,
      verified: 0,
      firstBooking: 0,
    });
    const rows = new Map<string, OnboardingBoardRow>();
    const rowFor = (actorId: string | null, role: string | null) => {
      const key = actorId ?? 'organic';
      let row = rows.get(key);
      if (!row) {
        row = { ...empty(), actorId, actorName: actorId ? (names.get(actorId) ?? null) : null, actorRole: actorId ? role : null };
        rows.set(key, row);
      }
      return row;
    };
    for (const p of publishers) {
      if (!p.onboardedVia) continue;
      const row = rowFor(p.onboardedById, p.onboardedByRole);
      row.via[p.onboardedVia] += 1;
      row.publishers += 1;
      row.onboarded += 1;
      if (p.onboardingStatus === 'ONBOARDING_COMPLETE') row.completed += 1;
      if (p.kycStatus === 'VERIFIED') row.verified += 1;
      const liveSoon = p.listings.some((l) => l.status === 'ACTIVE' && p.onboardedAt !== null && l.updatedAt.getTime() - p.onboardedAt.getTime() <= sevenDays);
      if (liveSoon) row.liveWithin7d += 1;
      if (p.listings.some((l) => l._count.orders > 0)) row.firstBooking += 1;
    }
    for (const a of advertisers) {
      if (!a.onboardedVia) continue;
      const row = rowFor(a.onboardedById, a.onboardedByRole);
      row.via[a.onboardedVia] += 1;
      row.advertisers += 1;
      row.onboarded += 1;
      if (a.activatedAt) row.completed += 1;
      if (a.kycStatus === 'VERIFIED') row.verified += 1;
      if (a._count.campaigns > 0) row.firstBooking += 1;
    }
    // Most onboarded first; ties by how far they got.
    return [...rows.values()].sort((x, y) => y.onboarded - x.onboarded || y.completed - x.completed || y.liveWithin7d - x.liveWithin7d || (x.actorName ?? '').localeCompare(y.actorName ?? ''));
  },

  async agentCommissions(window, f) {
    const rows = await prisma.agentIncentive.findMany({
      where: {
        createdAt: between(window),
        ...(f.agentId ? { agentId: f.agentId } : {}),
        ...(f.status ? { status: f.status as never } : {}),
        ...(f.event ? { event: f.event as never } : {}),
      },
      select: {
        event: true,
        tier: true,
        amount: true,
        taxWithheld: true,
        netAmount: true,
        status: true,
        createdAt: true,
        verifiedAt: true,
        agent: { select: { displayId: true, user: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): AgentCommissionRow => ({
        agentDisplayId: row.agent.displayId,
        agentName: row.agent.user.name,
        event: row.event,
        tier: row.tier,
        amount: row.amount,
        taxWithheld: row.taxWithheld,
        netAmount: row.netAmount,
        status: row.status,
        createdAt: row.createdAt,
        verifiedAt: row.verifiedAt,
      }),
    );
  },

  async onboardingFunnel(window, f) {
    const city = f.city ? insensitive(f.city) : undefined;
    const publisherScope = city ? { publisher: { city } } : {};
    const advertiserScope = city ? { advertiser: { advertiserProfile: { is: { city } } } } : {};
    const agentScope = city ? { agent: { city } } : {};
    const [
      publishersCreated,
      publisherKycSubmitted,
      publisherKycVerified,
      publisherKycRejected,
      publishersActivated,
      advertisersCreated,
      advertiserKycSubmitted,
      advertiserKycVerified,
      advertiserKycRejected,
      advertisersActivated,
      agentsCreated,
      agentKycSubmitted,
      agentKycVerified,
      agentKycRejected,
    ] = await Promise.all([
      prisma.publisher.count({ where: { createdAt: between(window), ...(city ? { city } : {}) } }),
      prisma.publisherKyc.count({ where: { submittedAt: between(window), ...publisherScope } }),
      prisma.publisherKyc.count({ where: { reviewedAt: between(window), status: 'VERIFIED', ...publisherScope } }),
      prisma.publisherKyc.count({ where: { reviewedAt: between(window), status: 'REJECTED', ...publisherScope } }),
      prisma.publisher.count({ where: { activatedAt: between(window), ...(city ? { city } : {}) } }),
      prisma.advertiser.count({ where: { createdAt: between(window), ...(city ? { city } : {}) } }),
      prisma.advertiserKyc.count({ where: { submittedAt: between(window), ...advertiserScope } }),
      prisma.advertiserKyc.count({ where: { reviewedAt: between(window), status: 'VERIFIED', ...advertiserScope } }),
      prisma.advertiserKyc.count({ where: { reviewedAt: between(window), status: 'REJECTED', ...advertiserScope } }),
      prisma.advertiser.count({ where: { activatedAt: between(window), ...(city ? { city } : {}) } }),
      prisma.agentProfile.count({ where: { createdAt: between(window), ...(city ? { city } : {}) } }),
      prisma.agentKyc.count({ where: { submittedAt: between(window), ...agentScope } }),
      prisma.agentKyc.count({ where: { reviewedAt: between(window), status: 'VERIFIED', ...agentScope } }),
      prisma.agentKyc.count({ where: { reviewedAt: between(window), status: 'REJECTED', ...agentScope } }),
    ]);
    const rows: FunnelRow[] = [
      { party: 'PUBLISHER', created: publishersCreated, kycSubmitted: publisherKycSubmitted, kycVerified: publisherKycVerified, kycRejected: publisherKycRejected, activated: publishersActivated },
      { party: 'ADVERTISER', created: advertisersCreated, kycSubmitted: advertiserKycSubmitted, kycVerified: advertiserKycVerified, kycRejected: advertiserKycRejected, activated: advertisersActivated },
      { party: 'AGENT', created: agentsCreated, kycSubmitted: agentKycSubmitted, kycVerified: agentKycVerified, kycRejected: agentKycRejected, activated: null },
    ];
    return rows;
  },

  async listings(window, f) {
    const rows = await prisma.listing.findMany({
      where: {
        createdAt: between(window),
        ...(f.status ? { status: f.status as never } : {}),
        ...(f.category ? { category: f.category as never } : {}),
        ...(f.city ? { city: insensitive(f.city) } : {}),
      },
      select: {
        displayId: true,
        title: true,
        category: true,
        city: true,
        status: true,
        ratePerDay: true,
        slotsTotal: true,
        createdAt: true,
        publishedAt: true,
        publisher: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): ListingRow => ({
        displayId: row.displayId,
        title: row.title,
        category: row.category,
        city: row.city,
        publisherName: row.publisher?.name ?? null,
        status: row.status,
        ratePerDay: row.ratePerDay,
        slotsTotal: row.slotsTotal,
        createdAt: row.createdAt,
        publishedAt: row.publishedAt,
      }),
    );
  },

  async kycAgeing(asOf, f) {
    const pending = { status: 'PENDING' as const, submittedAt: { not: null, lt: asOf } };
    const want = (type: KycAgeingRow['type']) => !f.type || f.type === type;
    const [publishers, advertisers, agents, users] = await Promise.all([
      want('PUBLISHER')
        ? prisma.publisherKyc.findMany({
            where: pending,
            select: { publisherId: true, method: true, submittedAt: true, assignedToId: true, escalatedAt: true, publisher: { select: { name: true, displayId: true } } },
          })
        : Promise.resolve([]),
      want('ADVERTISER')
        ? prisma.advertiserKyc.findMany({
            where: pending,
            // N3-B: the row is keyed by the Advertiser profile; the user is the legacy key and may be null.
            select: {
              advertiserId: true,
              advertiserProfileId: true,
              method: true,
              submittedAt: true,
              assignedToId: true,
              escalatedAt: true,
              advertiser: { select: { name: true } },
              profile: { select: { displayId: true, name: true, companyName: true } },
            },
          })
        : Promise.resolve([]),
      want('AGENT')
        ? prisma.agentKyc.findMany({
            where: pending,
            select: { agentId: true, submittedAt: true, agent: { select: { displayId: true, user: { select: { name: true } } } } },
          })
        : Promise.resolve([]),
      want('USER')
        ? prisma.userKyc.findMany({ where: pending, select: { userId: true, submittedAt: true, purpose: true, user: { select: { name: true } } } })
        : Promise.resolve([]),
    ]);
    const rows: KycAgeingRow[] = [
      ...publishers.map((row) => ({
        type: 'PUBLISHER' as const,
        partyId: row.publisherId,
        partyLabel: row.publisher.displayId ?? row.publisher.name,
        method: row.method,
        submittedAt: row.submittedAt!,
        assigned: row.assignedToId !== null,
        escalatedAt: row.escalatedAt,
      })),
      // N3-B: the party is the profile (its display id, else its name), the user's name for a legacy row;
      // a record with neither a profile nor a user has no party to report and is skipped.
      ...advertisers.flatMap((row) => {
        const partyId = row.advertiserProfileId ?? row.advertiserId;
        if (!partyId) return [];
        return [
          {
            type: 'ADVERTISER' as const,
            partyId,
            partyLabel: row.profile?.displayId ?? row.profile?.companyName ?? row.profile?.name ?? row.advertiser?.name ?? null,
            method: row.method,
            submittedAt: row.submittedAt!,
            assigned: row.assignedToId !== null,
            escalatedAt: row.escalatedAt,
          },
        ];
      }),
      ...agents.map((row) => ({
        type: 'AGENT' as const,
        partyId: row.agentId,
        partyLabel: row.agent.displayId ?? row.agent.user.name,
        method: null,
        submittedAt: row.submittedAt!,
        assigned: false,
        escalatedAt: null,
      })),
      ...users.map((row) => ({
        type: 'USER' as const,
        partyId: row.userId,
        partyLabel: row.user.name,
        method: row.purpose,
        submittedAt: row.submittedAt!,
        assigned: false,
        escalatedAt: null,
      })),
    ];
    return rows.sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  },

  async supportTickets(window, f) {
    const rows = await prisma.supportTicket.findMany({
      where: {
        createdAt: between(window),
        ...(f.priority ? { priority: f.priority as never } : {}),
        ...(f.status ? { status: f.status as never } : {}),
        ...(f.team ? { team: insensitive(f.team) } : {}),
      },
      select: {
        displayId: true,
        kind: true,
        priority: true,
        status: true,
        team: true,
        createdAt: true,
        updatedAt: true,
        slaFirstResponseDueAt: true,
        firstRespondedAt: true,
        slaResolutionDueAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): SupportTicketRow => ({
        displayId: row.displayId,
        kind: row.kind,
        priority: row.priority,
        status: row.status,
        team: row.team,
        createdAt: row.createdAt,
        firstResponseDueAt: row.slaFirstResponseDueAt,
        firstRespondedAt: row.firstRespondedAt,
        resolutionDueAt: row.slaResolutionDueAt,
        // The ticket has no closedAt of its own; CLOSED is its last change.
        resolvedAt: row.status === 'CLOSED' ? row.updatedAt : null,
      }),
    );
  },

  async disputes(window, f) {
    const rows = await prisma.dispute.findMany({
      where: { createdAt: between(window), ...(f.status ? { status: f.status as never } : {}) },
      select: {
        displayId: true,
        status: true,
        reason: true,
        raisedAs: true,
        againstParty: true,
        createdAt: true,
        resolvedAt: true,
        outcome: true,
        creditedAmount: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row): DisputeRow => ({ ...row }));
  },

  async fraudCases(window, f) {
    const rows = await prisma.fraudCase.findMany({
      where: { createdAt: between(window), ...(f.status ? { status: f.status as never } : {}) },
      select: { displayId: true, status: true, kind: true, subjectType: true, createdAt: true, decidedAt: true, decision: true, score: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row): FraudCaseRow => ({ ...row }));
  },

  async deliveryCounts(window, f) {
    const groups = await prisma.notificationDelivery.groupBy({
      by: ['templateKey', 'channel', 'status'],
      where: {
        createdAt: between(window),
        ...(f.channel ? { channel: f.channel as never } : {}),
        ...(f.templateKey ? { templateKey: f.templateKey } : {}),
      },
      _count: { _all: true },
    });
    return groups
      .map((g): DeliveryCountRow => ({ templateKey: g.templateKey, channel: g.channel, status: g.status, count: g._count._all }))
      .sort((a, b) => (a.templateKey ?? '').localeCompare(b.templateKey ?? '') || a.channel.localeCompare(b.channel) || a.status.localeCompare(b.status));
  },

  async campaignMetrics(window, f) {
    const groups = await prisma.campaignDailyMetric.groupBy({
      by: ['campaignId'],
      where: {
        day: between(window),
        ...(f.campaignId ? { campaignId: f.campaignId } : {}),
        ...(f.advertiserId ? { campaign: { advertiserId: f.advertiserId } } : {}),
      },
      _sum: { spend: true, scans: true, clicks: true, redemptions: true, reachFromSpots: true },
      _max: { spotsLive: true },
      _count: { _all: true },
    });
    if (groups.length === 0) return [];
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: groups.map((g) => g.campaignId) } },
      select: { id: true, reference: true, name: true, status: true, advertiser: { select: { name: true } } },
    });
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    return groups
      .map((g): CampaignMetricRow => {
        const campaign = byId.get(g.campaignId);
        return {
          reference: campaign?.reference ?? g.campaignId,
          name: campaign?.name ?? '',
          advertiserName: campaign?.advertiser.name ?? '',
          status: campaign?.status ?? '',
          days: g._count._all,
          spotsLive: g._max.spotsLive ?? 0,
          spend: sum(g._sum.spend),
          scans: g._sum.scans ?? 0,
          clicks: g._sum.clicks ?? 0,
          redemptions: g._sum.redemptions ?? 0,
          reachFromSpots: g._sum.reachFromSpots ?? 0,
        };
      })
      .sort((a, b) => b.spend.comparedTo(a.spend));
  },

  async platformSummary(window) {
    const paid = { paidAt: between(window), status: { not: 'CANCELLED' as const } };
    const pending = { status: 'PENDING' as const, submittedAt: { not: null } };
    const [
      campaignBookings,
      packageBookings,
      revenue,
      earnings,
      payouts,
      newPublishers,
      newAdvertisers,
      newAgents,
      listingsPublished,
      activeCampaigns,
      kycPublishers,
      kycAdvertisers,
      kycAgents,
      kycUsers,
      ticketsOpened,
      disputesOpened,
      fraudCasesOpened,
      deliveriesSent,
    ] = await Promise.all([
      prisma.campaign.aggregate({ where: paid, _sum: { total: true }, _count: { _all: true } }),
      prisma.packageSale.aggregate({ where: paid, _sum: { total: true }, _count: { _all: true } }),
      prisma.ledgerLeg.aggregate({ where: { account: { code: 'platform:revenue' }, transaction: { occurredAt: between(window) } }, _sum: { amount: true } }),
      prisma.earningAccrual.aggregate({ where: { forDate: between(window) }, _sum: { net: true } }),
      prisma.withdrawalRequest.aggregate({ where: { status: 'PAID', paidAt: between(window) }, _sum: { netAmount: true } }),
      prisma.publisher.count({ where: { createdAt: between(window) } }),
      prisma.advertiser.count({ where: { createdAt: between(window) } }),
      prisma.agentProfile.count({ where: { createdAt: between(window) } }),
      prisma.listing.count({ where: { publishedAt: between(window) } }),
      prisma.campaign.count({ where: { status: { in: ['LIVE', 'PAUSED', 'COMPLETED'] }, startDate: { lt: window.end }, endDate: { gte: window.start } } }),
      prisma.publisherKyc.count({ where: pending }),
      prisma.advertiserKyc.count({ where: pending }),
      prisma.agentKyc.count({ where: pending }),
      prisma.userKyc.count({ where: pending }),
      prisma.supportTicket.count({ where: { createdAt: between(window) } }),
      prisma.dispute.count({ where: { createdAt: between(window) } }),
      prisma.fraudCase.count({ where: { createdAt: between(window) } }),
      prisma.notificationDelivery.count({ where: { createdAt: between(window), status: { in: ['SENT', 'DELIVERED'] } } }),
    ]);
    const summary: PlatformSummary = {
      bookings: campaignBookings._count._all + packageBookings._count._all,
      gmv: sum(campaignBookings._sum.total).plus(sum(packageBookings._sum.total)),
      platformRevenue: sum(revenue._sum.amount),
      publisherEarnings: sum(earnings._sum.net),
      payoutsPaid: sum(payouts._sum.netAmount),
      newPublishers,
      newAdvertisers,
      newAgents,
      listingsPublished,
      activeCampaigns,
      kycPending: kycPublishers + kycAdvertisers + kycAgents + kycUsers,
      ticketsOpened,
      disputesOpened,
      fraudCasesOpened,
      deliveriesSent,
    };
    return summary;
  },
};
