import { randomInt } from 'crypto';
import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { Decimal, money as toMoney, type Money } from '../../shared/money';
import type { CampaignRefundStatus, Prisma } from '../../shared/database';
import { getPlatformSettings } from '../app-config';
import { isFeatureEnabled } from '../feature-flags';
import { assertCityAllows, cityKeyFor } from '../pricing';
import { assertVisitOutcome } from '../visits';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CampaignAggregate, CampaignPatch, CampaignRow } from './campaigns.repository';
import type { ListCampaignsQuery } from './campaigns.schema';
import { currentCreatives } from './moderation.service';

/**
 * A campaign, from the first question to the last.
 *
 * The seventeen screens of DR 02's booking flow are one long form, and this
 * holds the answers. Three things shape everything here:
 *
 *   A draft is saved from step one. Seventeen steps on a phone is a flow people
 *   abandon and come back to, so every screen PATCHes and `step` records where
 *   they stopped.
 *
 *   Nothing is validated as a whole until it has to be. Asking for a budget on
 *   step 2 because the schema wants one is how a wizard becomes unusable; the
 *   completeness check runs at review, and names what is missing.
 *
 *   Who is asking matters. The same flow runs in the advertiser's own app and
 *   in an agent's, and an agent may only act for advertisers they hold.
 */

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

/**
 * The steps, in the order DR 02 draws them. Branch screens share their parent's
 * number — "Step 12 of 17" appears on all four creative-path screens — so this
 * is the spine, not the screen count.
 */
export const CAMPAIGN_STEPS = [
  'BRAND',
  'GOAL',
  'AWARENESS',
  'TARGETING_METHOD',
  'TARGET_AREA',
  'STRATEGY',
  'PERSONA',
  'TRIGGERS',
  'BUDGET_AND_DATES',
  'MATCHING_INVENTORY',
  'CART',
  'CREATIVE',
  'TRACKING',
  'FULFILMENT',
  'REVIEW',
  'AUTHORIZE',
  'LIVE',
] as const;

export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];
export const TOTAL_STEPS = CAMPAIGN_STEPS.length;

/** 1-based, as the step counter prints it. */
export const stepNumber = (step: CampaignStep): number => CAMPAIGN_STEPS.indexOf(step) + 1;

/* ------------------------------------------------------------------ */
/* Who may act                                                         */
/* ------------------------------------------------------------------ */

export type Actor = {
  userId: string;
  isAdmin: boolean;
  /** The advertiser this user *is*, when they are one. */
  advertiserId: string | null;
  /** The agent profile this user *is*, when they are one. */
  agentId: string | null;
};

/**
 * Whether this actor may see and change this campaign.
 *
 * An advertiser owns their campaigns. An agent may act on the ones they created,
 * which is narrower than "campaigns of advertisers I onboarded" on purpose: an
 * agent who once opened an account does not thereby get to edit every campaign
 * that advertiser has run since.
 */
export function assertMayAct(campaign: { advertiserId: string; agentId: string | null }, actor: Actor): void {
  if (actor.isAdmin) return;
  if (actor.advertiserId && campaign.advertiserId === actor.advertiserId) return;
  if (actor.agentId && campaign.agentId === actor.agentId) return;
  throw new ApiError(403, 'FORBIDDEN', 'This campaign belongs to someone else.');
}

/* ------------------------------------------------------------------ */
/* Reference                                                           */
/* ------------------------------------------------------------------ */

/** ADX-CMP-2026-482913, as the Campaign Live screen prints it. */
export async function nextReference(now = new Date()): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const reference = `ADX-CMP-${now.getFullYear()}-${randomInt(100_000, 999_999)}`;
    if (!(await repository.referenceExists(reference))) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a campaign reference');
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export async function createDraft(input: {
  advertiserId: string;
  brandId?: string | null;
  name?: string | null;
  /** Lot B (Q1): the visit this campaign is being made on, when the agent is on one. */
  visitId?: string | null;
  actor: Actor;
}): Promise<CampaignRow> {
  const { advertiserId, actor } = input;

  if (!actor.isAdmin) {
    if (actor.advertiserId && actor.advertiserId === advertiserId) {
      // Their own campaign.
    } else if (actor.agentId) {
      const context = await repository.advertiserContext(advertiserId);
      if (!context) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
      if (context.agentId !== actor.agentId) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'You can only build campaigns for advertisers you look after.'
        );
      }
    } else {
      throw new ApiError(403, 'FORBIDDEN', 'Only an advertiser or their agent can start a campaign.');
    }
  }

  // A visit is the agent's own, in progress or completed today — the visits
  // module says which, before anything is written.
  const agentId = actor.isAdmin ? null : actor.agentId;
  if (input.visitId) await assertVisitOutcome(input.visitId, agentId);

  return repository.createCampaign({
    advertiserId,
    brandId: input.brandId ?? null,
    // Recorded when an agent runs the flow, which is what makes it an assisted
    // booking rather than a self-serve one — and what the agent is paid on.
    agentId,
    visitId: input.visitId ?? null,
    createdByUserId: actor.userId,
    name: input.name?.trim() || 'Untitled campaign',
    reference: await nextReference(),
  });
}

/**
 * Lot D (Q104): one spot of one campaign, with the little the reviews module
 * needs to decide whether it may be reviewed — whose campaign it is, and
 * whether the spot ran to the end. Null when either id is unknown.
 */
export async function findCampaignSpotForReview(
  campaignId: string,
  spotId: string,
): Promise<{
  campaign: { id: string; reference: string; name: string; advertiserId: string; agentId: string | null; status: CampaignAggregate['status'] };
  spot: { id: string; listingId: string; status: CampaignAggregate['spots'][number]['status']; title: string };
} | null> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) return null;
  const spot = campaign.spots.find((candidate) => candidate.id === spotId);
  if (!spot) return null;
  return {
    campaign: {
      id: campaign.id,
      reference: campaign.reference,
      name: campaign.name,
      advertiserId: campaign.advertiserId,
      agentId: campaign.agentId,
      status: campaign.status,
    },
    spot: { id: spot.id, listingId: spot.listingId, status: spot.status, title: spot.listing.title },
  };
}

export async function getCampaign(id: string, actor: Actor): Promise<CampaignAggregate> {
  const campaign = await repository.findCampaign(id);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  assertMayAct(campaign, actor);
  return campaign;
}

/**
 * E6: the refund standing against a campaign — the one `cancelCampaign`
 * recorded after capture (Lot B, Q41) — as GET /campaigns/:id carries it.
 * Null when nothing was owed or the campaign was never cancelled.
 */
export type CampaignRefundSummary = {
  id: string;
  amount: Money;
  status: CampaignRefundStatus;
  reason: string;
  releasedAt: Date | null;
};

export async function campaignRefundSummary(campaignId: string): Promise<CampaignRefundSummary | null> {
  const refund = await repository.findCampaignRefundByCampaign(campaignId);
  if (!refund) return null;
  return {
    id: refund.id,
    amount: toMoney(refund.amount),
    status: refund.status,
    reason: refund.reason,
    releasedAt: refund.releasedAt,
  };
}

export async function listCampaigns(
  actor: Actor,
  filter: { status?: CampaignAggregate['status'][]; search?: string; limit?: number }
) {
  return repository.listCampaigns({
    // An admin sees everything; everyone else sees only their own side of it.
    ...(actor.isAdmin
      ? {}
      : actor.advertiserId
        ? { advertiserId: actor.advertiserId }
        : { agentId: actor.agentId ?? '__none__' }),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.search ? { search: filter.search } : {}),
    limit: Math.min(filter.limit ?? 50, 200),
  });
}

/**
 * The campaign list as both screens draw it: a page, its total, and a count
 * per chip.
 *
 * `listCampaigns` above stays as it is — analytics folds over the whole set
 * and has no use for a page. This is the API's read.
 *
 * `search` and `q` are the same field; the alias is folded here so nothing
 * downstream has to know there were ever two names for it.
 */
export async function listCampaignsPage(actor: Actor, query: ListCampaignsQuery) {
  const q = query.q ?? query.search;
  const { items, total, counts } = await repository.listCampaignsPage({
    ...(actor.isAdmin
      ? // Only ADX may narrow to somebody else's advertiser; for everyone else
        // the scope below IS their identity and the parameter is ignored.
        (query.advertiserId ? { advertiserId: query.advertiserId } : {})
      : actor.advertiserId
        ? { advertiserId: actor.advertiserId }
        : { agentId: actor.agentId ?? '__none__' }),
    ...(query.status ? { status: query.status as never } : {}),
    ...(q ? { q } : {}),
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
  });
  return toListPage(items, total, counts, query);
}

/** Only a draft takes edits. After payment the brief is what was paid for. */
function assertDraft(campaign: { status: string }): void {
  if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_PAYMENT') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This campaign has been paid for. Changes to a running campaign go through support.'
    );
  }
}

/**
 * The three branch answers, as the wizard sends them: a discriminant, and on the
 * arms that have one, its config.
 *
 * They arrive whole rather than flattened so the type and its detail can never
 * be saved apart from one another, and so the rule below can compare what was
 * chosen against what is stored.
 */
export type BranchBlocks = {
  trigger?: { triggerType: CampaignRow['triggerType']; triggerConfig?: unknown };
  creative?: { creativePath: NonNullable<CampaignRow['creativePath']>; creativeConfig?: unknown };
  tracking?: { trackingMethod: CampaignRow['trackingMethod']; trackingConfig?: unknown };
};

/**
 * What a branch save should do to the config column beside it. `undefined`
 * means leave what is stored alone.
 *
 * The wizard asks each branch question in two moves — choose the path on step
 * 12 or 13, then fill its detail on the screen that follows — so a save
 * carrying only the discriminant is the normal shape of the first move, not an
 * instruction to blank the second. Writing `null` for an absent config erased
 * the advertiser's typed destination URL, HTML5 endpoint or weather conditions
 * every time they stepped back onto the choosing screen and saved again, which
 * is one tap from the review screen's "Change".
 *
 * A changed discriminant still clears: a QR destination means nothing once the
 * method is VANITY_OR_PROMO. The arms that carry no config at all — NONE,
 * STATIC_IMAGES, VIDEO_OR_MOTION — need no special case, because reaching one
 * is always a change of discriminant and the schema refuses to send a config
 * alongside them, so nothing can be left stranded under one.
 */
function nextBranchConfig(
  supplied: unknown,
  chosen: unknown,
  stored: unknown
): Prisma.InputJsonValue | null | undefined {
  if (supplied !== undefined) return supplied as Prisma.InputJsonValue;
  return chosen === stored ? undefined : null;
}

export async function patchDraft(
  id: string,
  patch: CampaignPatch &
    BranchBlocks & {
      pois?: { label: string; address?: string | null; latitude?: number | null; longitude?: number | null }[];
    },
  actor: Actor
): Promise<CampaignAggregate> {
  const campaign = await repository.findCampaignBare(id);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  assertMayAct(campaign, actor);
  assertDraft(campaign);

  const { pois: sentPois, trigger, creative, tracking, ...fields } = patch;
  let pois = sentPois;

  /*
   * Lot D (Q8/Q107): the markets. The list is the truth and `targetMarket`
   * / `targetLocation` are kept as its first entry for the readers that
   * predate it — the matcher, the list row, the app's MarketArea step. Choosing
   * markets clears the radius and the pins the way that step does, because
   * the matcher prefers a bounding box over a city whenever it can build
   * one. A second market needs the flag; the cap is the platform setting.
   * A patch that still sends the single field alone keeps the list in step.
   */
  if (fields.targetMarkets !== undefined) {
    const seen = new Set<string>();
    const markets = fields.targetMarkets
      .map((market) => market.trim())
      .filter((market) => {
        const key = market.toLowerCase();
        if (!market || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (markets.length > 1 && !(await isFeatureEnabled('multi-market-campaigns', campaign.advertiserId))) {
      throw new ApiError(409, 'FEATURE_OFF', 'One market per campaign for now. Run a second campaign for a second market.');
    }
    const cap = (await getPlatformSettings()).marketplace.maxMarketsPerCampaign;
    if (markets.length > cap) {
      throw new ApiError(400, 'VALIDATION_ERROR', `A campaign can target at most ${cap} market${cap === 1 ? '' : 's'}.`);
    }
    for (const market of markets) await assertCityAllows(market, 'demand');
    fields.targetMarkets = markets;
    fields.targetMarket = markets[0] ?? null;
    fields.targetLocation = markets[0] ?? null;
    if (markets.length > 0) {
      fields.targetLatitude = null;
      fields.targetLongitude = null;
      fields.targetRadiusKm = null;
      pois = [];
    }
  } else if (fields.targetMarket !== undefined) {
    fields.targetMarkets = fields.targetMarket ? [fields.targetMarket] : [];
  }

  if (trigger) {
    fields.triggerType = trigger.triggerType;
    const next = nextBranchConfig(trigger.triggerConfig, trigger.triggerType, campaign.triggerType);
    if (next !== undefined) fields.triggerConfig = next;
  }
  if (creative) {
    fields.creativePath = creative.creativePath;
    const next = nextBranchConfig(
      creative.creativeConfig,
      creative.creativePath,
      campaign.creativePath
    );
    if (next !== undefined) fields.creativeConfig = next;
  }
  if (tracking) {
    fields.trackingMethod = tracking.trackingMethod;
    const next = nextBranchConfig(
      tracking.trackingConfig,
      tracking.trackingMethod,
      campaign.trackingMethod
    );
    if (next !== undefined) fields.trackingConfig = next;
  }

  // Q31 / Lot V: the market a campaign targets has to be one whose rollout
  // stage has demand on. Checked only when the patch names it, so a later
  // screen's save is not refused for a market chosen before ops closed it —
  // and, as everywhere else, a market with no City row at all passes.
  if (fields.targetMarket !== undefined && fields.targetMarket !== null && patch.targetMarkets === undefined) {
    await assertCityAllows(fields.targetMarket, 'demand');
  }
  // Lot X-B: the key beside the market — the first market's `City` row, or
  // null for a typed town or a cleared market. Stamped whenever the market
  // moves, by either field.
  if (fields.targetMarket !== undefined) {
    fields.targetMarketCityId = (await cityKeyFor(fields.targetMarket))?.cityId ?? null;
  }

  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A campaign cannot end before it starts.');
  }

  // Lot B (Q1): naming the visit is gated by the visits module — the actor's
  // own visit, open today. Clearing it is not, and neither is re-saving the
  // one already on the draft.
  if (fields.visitId && fields.visitId !== campaign.visitId) {
    await assertVisitOutcome(fields.visitId, actor.agentId);
  }

  if (Object.keys(fields).length > 0) await repository.updateCampaign(id, fields);
  if (pois) {
    await repository.replacePois(
      id,
      pois.map((poi) => ({
        label: poi.label,
        address: poi.address ?? null,
        latitude: poi.latitude ?? null,
        longitude: poi.longitude ?? null,
      }))
    );
  }

  return (await repository.findCampaign(id))!;
}

export async function discardDraft(id: string, actor: Actor): Promise<void> {
  const campaign = await repository.findCampaignBare(id);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  assertMayAct(campaign, actor);
  if (campaign.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only a draft can be discarded. Cancel a live campaign instead.');
  }
  await repository.deleteCampaign(id);
}

/* ------------------------------------------------------------------ */
/* Completeness                                                        */
/* ------------------------------------------------------------------ */

export type MissingAnswer = { step: CampaignStep; field: string; label: string };

/**
 * What the brief still lacks before it can be priced and paid for.
 *
 * Returned as a list rather than thrown one at a time, so the review screen can
 * say everything that is outstanding instead of sending somebody back around
 * the loop once per field.
 */
export function missingAnswers(campaign: CampaignAggregate): MissingAnswer[] {
  const missing: MissingAnswer[] = [];
  const need = (condition: unknown, step: CampaignStep, field: string, label: string) => {
    if (condition === null || condition === undefined || condition === '') {
      missing.push({ step, field, label });
    }
  };

  need(campaign.brandName, 'BRAND', 'brandName', 'Brand name');
  need(campaign.industry, 'BRAND', 'industry', 'Industry');
  need(campaign.goal, 'GOAL', 'goal', 'Campaign goal');
  need(campaign.awareness, 'AWARENESS', 'awareness', 'Awareness level');
  need(campaign.targetingMethod, 'TARGETING_METHOD', 'targetingMethod', 'Targeting method');

  if (campaign.targetingMethod === 'RADIUS') {
    need(campaign.targetLatitude, 'TARGET_AREA', 'targetLatitude', 'Target location');
    need(campaign.targetRadiusKm, 'TARGET_AREA', 'targetRadiusKm', 'Radius');
  }
  if (campaign.targetingMethod === 'MARKET_OR_DMA') {
    // Lot D (Q107): at least one market, in the list or the single field.
    need((campaign.targetMarkets ?? [])[0] ?? campaign.targetMarket, 'TARGET_AREA', 'targetMarket', 'Market');
  }
  if (campaign.targetingMethod === 'POI_VENUE' && campaign.pois.length === 0) {
    missing.push({ step: 'TARGET_AREA', field: 'pois', label: 'At least one venue' });
  }

  need(campaign.strategy, 'STRATEGY', 'strategy', 'Strategy');
  need(campaign.persona, 'PERSONA', 'persona', 'Audience persona');
  need(campaign.budget, 'BUDGET_AND_DATES', 'budget', 'Budget');
  need(campaign.startDate, 'BUDGET_AND_DATES', 'startDate', 'Start date');
  need(campaign.endDate, 'BUDGET_AND_DATES', 'endDate', 'End date');

  if (campaign.spots.length === 0) {
    missing.push({ step: 'CART', field: 'spots', label: 'At least one spot' });
  }

  need(campaign.creativePath, 'CREATIVE', 'creativePath', 'Creative path');
  need(campaign.fulfilment, 'FULFILMENT', 'fulfilment', 'Print and install choice');

  /*
   * The detail behind a chosen path or method.
   *
   * The patch schema lets a draft carry the choice without its detail, so that
   * picking "ADX design agency" can advance to the screen that collects the
   * brief. This is where the two halves are reconciled: a campaign cannot
   * launch on a path whose detail was never filled in.
   */
  const config = (value: unknown) =>
    value && typeof value === 'object' && Object.keys(value as object).length > 0;

  if (campaign.creativePath === 'DYNAMIC_HTML5' && !config(campaign.creativeConfig)) {
    missing.push({ step: 'CREATIVE', field: 'creativeConfig', label: 'Live feed details' });
  }
  if (campaign.creativePath === 'ADX_DESIGN_AGENCY' && !config(campaign.creativeConfig)) {
    missing.push({ step: 'CREATIVE', field: 'creativeConfig', label: 'Design brief' });
  }
  if (
    campaign.trackingMethod &&
    campaign.trackingMethod !== 'NONE' &&
    !config(campaign.trackingConfig)
  ) {
    missing.push({ step: 'TRACKING', field: 'trackingConfig', label: 'Measurement details' });
  }

  // Artwork is required for the paths that produce it. A design brief or a live
  // feed does not have a file to upload, so those paths are complete without one.
  if (campaign.creativePath === 'STATIC_IMAGES' || campaign.creativePath === 'VIDEO_OR_MOTION') {
    // Lot D (Q44): a re-upload supersedes the row it replaces; count slots, not rows.
    const uploaded = currentCreatives(campaign.creatives).filter((creative) => creative.fileUrl).length;
    if (uploaded < campaign.spots.length) {
      missing.push({
        step: 'CREATIVE',
        field: 'creatives',
        label: `Artwork for ${campaign.spots.length - uploaded} more spot${campaign.spots.length - uploaded === 1 ? '' : 's'}`,
      });
    }
  }

  return missing;
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

export type TriggerPlan = {
  triggerType: CampaignAggregate['triggerType'];
  /** What the four trigger screens collected, exactly as it was recorded. */
  triggerConfig: unknown;
  /**
   * Whether the platform acts on it.
   *
   * Typed as the literal `false`, not `boolean`, so nobody writes a branch
   * against a value that has never been true. Four screens ask for a trigger,
   * the answer is stored, and nothing reads it: there is no scheduler, and
   * delivery has no notion of a campaign that pauses itself. Saying so in the
   * payload is the same trade the package entitlements make (`enforced: false`)
   * and the location-lift panel makes with `UNAVAILABLE` — a promise the
   * platform does not keep is worse than a feature it does not claim.
   */
  enforced: false;
  /** What will actually happen, in words a person can check. */
  basis: string;
};

const TRIGGER_RECORDED =
  'Recorded with the brief and passed to the ADX team, who act on it by hand. ' +
  'Nothing on the platform starts, pauses or boosts a flight from a trigger yet, ' +
  'so the campaign runs to its dates whatever the trigger says.';

const TRIGGER_NONE = 'No trigger was asked for. The campaign runs for the whole of its flight.';

/**
 * What the campaign's trigger will do, which is nothing automatic.
 *
 * Pure, and derived from the row rather than stored beside it, so the answer
 * cannot drift from the answer that was given.
 */
export function triggerPlan(campaign: {
  triggerType: CampaignAggregate['triggerType'];
  triggerConfig: unknown;
}): TriggerPlan {
  const chosen = Boolean(campaign.triggerType) && campaign.triggerType !== 'NONE';
  return {
    triggerType: campaign.triggerType,
    triggerConfig: campaign.triggerConfig ?? null,
    enforced: false,
    basis: chosen ? TRIGGER_RECORDED : TRIGGER_NONE,
  };
}

/**
 * Lot D (Q107): the read carries an advisory warning above one market —
 * inventory is matched across the whole list and the campaign reports as
 * one, which is a trade the advertiser should see stated. Never a refusal.
 */
export function withMarketWarning<T extends { targetMarkets?: string[] | null }>(
  campaign: T,
): T & { multiMarketWarning: boolean } {
  return { ...campaign, multiMarketWarning: (campaign.targetMarkets?.length ?? 0) > 1 };
}

/** How many days the flight runs, inclusive of both ends. */
export { flightDays } from './flight';

/** Decimal from a number or string, for the places the wire sends money. */
export const money = (value: string | number | Prisma.Decimal): Prisma.Decimal =>
  new Decimal(value as never);
