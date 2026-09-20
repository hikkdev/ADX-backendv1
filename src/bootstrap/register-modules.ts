import { Router } from 'express';
import { healthHandler, readyHandler } from './health';
import { pingDatabase } from '../shared/database';
// Lot G (answer 144): the health routes' feature declaration, loaded with the bootstrap.
import './features';
import { asyncHandler } from '../shared/http';
import { registerServerErrorAlertPort } from '../shared/errors';
import { logger } from '../shared/logging';
import { env } from '../config/env';

import { authRouter, registerPermissionResolver, registerMobileTombstonePort } from '../modules/auth';
import { userRouter, listAdminUserIds, findUserLabels, ensureSystemUser } from '../modules/users';
import { accountLifecycleRouter, wasMobileErased } from '../modules/account-lifecycle';
import { rolesConfigRouter, ensureSystemRoles, permissionsFor } from '../modules/access-control';
import { accessGrantRouter, registerAccessGrantsModule, liveGrantFor, findAccessGrantLabels } from '../modules/access-grants';
import { employeeRouter, findEmployeeByUserId, employeeExists } from '../modules/employees';
import { hrRouter, ensureHolidays, ensureDepartments } from '../modules/hr';
import { scheduleRouter } from '../modules/schedule';
import { workRouter } from '../modules/work';
import { qrRouter, registerQrRefLabelPort } from '../modules/qr';
import { geoRouter, appGeoRouter } from '../modules/geo';
import {
  orderRouter,
  publisherBookingRouter,
  registerCreativeGatePort,
  findOpenOrdersForAdvertiserUser,
  findOpenOrdersForListings,
  getAgentOrderIdsAwaitingWork,
  findOrderLabels,
} from '../modules/orders';
import {
  milestoneTemplateRouter,
  milestonePlanRouter,
  orderMilestoneRouter,
  agentMilestoneRouter,
} from '../modules/order-milestones';
import {
  listingRouter,
  savedSpacesRouter,
  similarListingsHandler,
  updateListing,
  unpublishListing,
  getListingsForPublisher,
  findListingLabels,
} from '../modules/listings';
import { supplyRouter } from '../modules/supply';
import { identifierRouter } from '../modules/identifiers';
import {
  advertiserRouter,
  refundDeskRouter,
  topUpDeskRouter,
  registerAdvertiserModule,
  getAdvertiserForUser,
  findAdvertiserLabelsForUsers,
  findAdvertiserLabels,
} from '../modules/advertisers';
import { campaignRouter, campaignRefundRouter, creativeGateForOrder, registerSpotReviewPort } from '../modules/campaigns';
import { packageRouter } from '../modules/packages';
import { pricingRouter, registerListingRepricePort } from '../modules/pricing';
import { revenueRouter, commissionForListing, runningSubscriptionForPublisher } from '../modules/revenue';
import {
  publisherRouter,
  digioWebhookHandler,
  onUnmatchedDigioWebhook,
  registerPublisherModule,
  registerPublisherSummaryPort,
  findPublisherForUser,
  findPublisherLabelsForUsers,
  findPublisherLabels,
} from '../modules/publishers';
import { agentRouter, milestoneRouter, findAgentProfile, findAgentLabelsForUsers, findAgentLabels } from '../modules/agents';
import { trainingRouter } from '../modules/training';
import { agreementRouter, ensureAgreementDrafts } from '../modules/agreements';
import { earningsRouter } from '../modules/earnings';
import { aiRouter } from '../modules/ai';
import { rateCardRouter, raisePriceCase, registerListingEnforcementPort } from '../modules/rate-cards';
import { priceModelRouter } from '../modules/price-model';
import { payoutRouter, financeRouter, registerCommissionResolverPort, registerPayoutUserLabelPort } from '../modules/payouts';
import { reconciliationRouter } from '../modules/reconciliation';
import {
  printPartnerRouter,
  printJobRouter,
  printQuoteRequestsRouter,
  printPartnerKycRouter,
  handlePrintPartnerDigioWebhook,
  registerPrintPartnersModule,
} from '../modules/print-partners';
import {
  notificationRouter,
  commsRouter,
  commsWebhookRouter,
  deviceRouter,
  createNotification,
  ensureTemplates,
  broadcastFlagsChanged,
} from '../modules/notifications';
import { announcementRouter } from '../modules/announcements';
import { supportRouter, registerRequesterPort, supportAttachmentViewer, type RequesterParty } from '../modules/support';
import { disputeRouter, disputePartiesForEvidenceFile, registerPartyLookupPort } from '../modules/disputes';
import { findWalletFor } from '../modules/wallets';
import { money } from '../shared/money';
import { fraudRouter, installThumbnailDecoder } from '../modules/fraud';
import { leadRouter, leadClusters } from '../modules/leads';
import { registerLeadLayerPort, registerAgentReviewPort } from '../modules/agents';
import { reviewPartyRouter, reviewRouter, recentAgentReviews, reviewIdsForCampaignSpots } from '../modules/reviews';
import { visitRouter, agentDayRouter, visitsForPublisher } from '../modules/visits';
import { legalRouter } from '../modules/legal';
import { safetyRouter } from '../modules/safety';
import { onboardingRouter } from '../modules/onboarding';
import {
  advertiserKycRouter,
  userKycRouter,
  agentKycRouter,
  employeeKycRouter,
  handleAdvertiserDigioWebhook,
  handleAgentDigioWebhook,
  handleEmployeeDigioWebhook,
  registerEmployeeLookupPort,
  registerKycUserLabelPort,
} from '../modules/kyc';
import { uploadRouter, filesRouter, registerFileAccessPort } from '../modules/uploads';
import { integrationsRouter } from '../modules/integrations';
import { brandingRouter } from '../modules/branding';
import { appStatusRouter, configRouter, platformSettingsRouter } from '../modules/app-config';
import { opsRouter, registerPostgresProbe } from '../modules/ops';
import { reportsRouter } from '../modules/reports';
import { auditRouter } from '../modules/audit';
import { adminOverviewRouter } from '../modules/admin-overview';
import { sectionOverviewsRouter } from '../modules/section-overviews';
import { partyImportsRouter } from '../modules/party-imports';
import { suspensionRouter } from '../modules/suspension';
import {
  appFlagsRouter,
  flagRouter,
  registerFlagUserLabelPort,
  registerFlagChangePort,
  registerFlagSubjectCityPort,
  ensureFeatureRegistry,
} from '../modules/feature-flags';
import {
  invoiceFinanceRouter,
  advertiserInvoiceRouter,
  publisherInvoiceRouter,
  statementRouter,
  registerInvoicesModule,
} from '../modules/invoices';
import { paymentRouter, advertiserPaymentRouter, paymentWebhookRouter, registerPaymentsModule } from '../modules/payments';

/**
 * The whole `/api/v1` surface, assembled from module public exports.
 *
 * Nothing here imports a module's internals — only its `index.ts`. Adding an
 * endpoint means adding it to a module's own router, not to this file; this
 * file only decides where a module's router is mounted.
 *
 * REGISTRATION ORDER IS LOAD-BEARING in three places, each marked below.
 * tests/architecture/route-inventory.test.ts compares the resulting tree,
 * in order, against docs/route-inventory.json.
 */

// Supplies the QR module's PublisherOnboardingPort. Must run before any request
// is served: scanning a publisher QR fails loudly without it.
registerPublisherModule();

// Supplies the agents module's LeadLayerPort — the map bubbles on the
// dashboard. Unregistered the layer is empty, which is honest but not the
// product; so it is wired here beside the other ports.
registerLeadLayerPort({ clusters: (scope) => leadClusters(scope) });

// Supplies the agents module's AgentReviewPort (Lot D, Q112) — the "publisher
// rated you" rows on the rating ledger. Inverted because `reviews` imports
// `agents` to write the review snapshot. Unregistered, the ledger carries no
// review rows; the score still does, from the snapshot columns.
registerAgentReviewPort({ recentReviews: (agentId, from) => recentAgentReviews(agentId, from) });

// Supplies the campaigns module's SpotReviewPort (E7-2) — `reviewed` and
// `reviewId` on each spot of GET /campaigns/:id. Inverted for the same
// reason as the port above: `reviews` imports `campaigns` to gate a spot
// review. Unregistered, every spot reads as unreviewed.
registerSpotReviewPort({ reviewIdsForSpots: (spotIds) => reviewIdsForCampaignSpots(spotIds) });

// Supplies the QR module's AccessGrantPort. Same requirement: scanning a
// delegated-access code fails loudly without it rather than logging a
// successful scan that granted nothing.
registerAccessGrantsModule();

// Supplies the QR module's AdvertiserOnboardingPort — the demand side of the
// door-to-door code. Same requirement as the publisher port.
registerAdvertiserModule();

// K-B1: supplies the QR desk's ref-label port — `GET /qr` names what each
// code's refId points at (the spot, the agent, the order, the party, the
// grant) through each module's own batch export, one query per kind per
// page. Inverted because all six import `qr` to mint codes. A kind with no
// resolver (AD) answers `label: null`; nothing fails.
registerQrRefLabelPort({
  SITE: (ids) => findListingLabels(ids),
  AGENT: (ids) => findAgentLabels(ids),
  ORDER: (ids) => findOrderLabels(ids),
  PUBLISHER: (ids) => findPublisherLabels(ids),
  ADVERTISER: (ids) => findAdvertiserLabels(ids),
  ACCESS_GRANT: (ids) => findAccessGrantLabels(ids),
});

// Supplies the invoicing ports `campaigns` and `packages` declare (Lot B,
// Q13): the checkout asks for its invoice, the package sale for its receipt,
// the cancel for its credit note. Inverted because `invoices` reads both
// modules for the lines it prints. Unregistered, bookings still go through
// and the desk's POST /finance/invoices/issue catches up.
registerInvoicesModule();

// Supplies the orders module's PrintJobPort (Lot B, B4b): the print partner's
// address for the PICKUP code and the order read, and the collect-prints step
// marking the job COLLECTED. Inverted because print-partners reads orders to
// gate a job on the order's status. Unregistered, an order has no print job
// and reads and moves exactly as it did before the lot.
registerPrintPartnersModule();

// Supplies the advertisers module's OriginalMethodRefundPort (Lot C, Q110):
// whether a refund request may go back to the card or UPI it came from —
// a captured gateway payment with enough left. Inverted because `payments`
// reads `advertisers` for the wallet. Unregistered, ORIGINAL_METHOD keeps
// answering 409 GATEWAY_NOT_CONFIGURED, exactly as it did before the lot.
registerPaymentsModule();

// Supplies the orders module's CreativeGatePort (Lot D, Q120): whether an
// order's artwork is APPROVED, asked by markPrintReady before the pickup code
// is minted. Inverted because campaigns raises orders at authorisation.
// Unregistered, every order prints — an order with no campaign has no artwork
// to gate — so the wiring is here, beside the print-job port it sits next to.
registerCreativeGatePort({ artworkApprovedFor: (orderId) => creativeGateForOrder(orderId) });

// Supplies the pricing module's ListingRepricePort (Lot E, Q125): a BINDING
// factor writes the listing's rate through `listings.updateListing` — the
// same door a typed rate uses — and, above `maxBindingChangePct`, raises a
// price case through `rate-cards`. Inverted because listings imports pricing
// to classify a spot and rate-cards to gate it. Unregistered, a binding
// apply refuses (503) and an advisory one still records the proposal.
registerListingRepricePort({
  reprice: async ({ listingId, ratePerDay }) => {
    await updateListing(listingId, { ratePerDay });
  },
  raisePriceCase: (input) => raisePriceCase(input),
});

// Supplies the rate-cards module's ListingEnforcementPort (Lot E, Q97): a
// rejected CARD_REVISION case, after its grace and with no order running,
// takes the listing off the market through `listings.unpublishListing`,
// which audits the move and tells the publisher. Inverted because listings
// runs the rate-card gate at publish. Unregistered, the rejection refuses
// (503) rather than leaving a listing live the case said would come down.
registerListingEnforcementPort({
  unpublish: async (input) => {
    await unpublishListing(input.listingId, input);
  },
});

// Supplies the payouts module's CommissionResolverPort — the commission for a
// spot authorised before Lot B stamped one at checkout. Inverted because
// revenue reaches advertisers, which reaches payouts for findPayoutMethod.
// Unregistered, the accrual skips an unstamped spot and logs it rather than
// paying at a rate nobody chose; every stamped spot still accrues.
registerCommissionResolverPort({ resolve: (input) => commissionForListing(input) });

// P-B: the publisher's detail card reads the running subscription and the
// visits made to the publisher through a port, because `revenue` imports
// `publishers` (the plan orders) and `visits` reaches it through `orders` →
// `users`. Unregistered, the card answers no subscription and no visits.
registerPublisherSummaryPort({
  runningSubscription: (publisherId, at) => runningSubscriptionForPublisher(publisherId, at),
  visits: (publisherId, limit) => visitsForPublisher(publisherId, limit),
});

// Supplies the auth module's PermissionResolver — what goes into an access
// token's `perms`. Inverted because access-control needs auth's
// revokeSessions whenever a role changes, and a cycle would be the
// alternative. Unregistered, auth falls back to the launch rule (an ADMIN
// holds everything), which is also what an admin with no role config gets.
registerPermissionResolver((userId, roles) => permissionsFor(userId, roles));

// Supplies the auth module's MobileTombstonePort — whether a number was erased
// on a DPO-approved request before this registration (Q60). Inverted for the
// same reason as the resolver above: account-lifecycle needs revokeSessions
// from auth to close an account. Unregistered, auth answers "no", which only
// costs the activity row beside the new account.
registerMobileTombstonePort({ wasErased: (mobile) => wasMobileErased(mobile) });

// E6: the `{ id, name }` behind `byUser` on a flag's change history and
// `createdBy` / `approvedBy` on a payout batch. Both modules sit underneath
// `users` (users → advertisers → payouts; campaigns reads the flags), so the
// lookup is a port each declares and `users.findUserLabels` fills.
// Unregistered, the ids still answer and the names are null.
registerFlagUserLabelPort((ids) => findUserLabels(ids));
registerPayoutUserLabelPort((ids) => findUserLabels(ids));
// G6 (Q103/133): a flag that moved reaches every phone as a silent
// `{ type: 'FLAGS_CHANGED' }` push, so a kill switch lands without a cold
// start. `feature-flags` sits underneath `notifications` in the graph (the
// push side reads the device registry), so it declares the event and the
// listener is wired here. Unregistered, the next `/app/flags` read sees it.
registerFlagChangePort(async (event) => {
  await broadcastFlagsChanged({ key: event.flag.key, changeId: event.changeId });
});
// Lot G (answer 146): the caller's city for a flag rolled out by city. The
// city sits on the party's profile — Publisher, Advertiser or AgentProfile —
// and those modules sit above feature-flags in the graph, so the lookup is
// a port filled from the three profile reads: the first profile with a city
// wins, and a person with none is outside every city rollout.
registerFlagSubjectCityPort(async (userId) => {
  const [publisher, advertiser, agent] = await Promise.all([
    findPublisherForUser(userId),
    getAdvertiserForUser(userId),
    findAgentProfile(userId),
  ]);
  return publisher?.city ?? advertiser?.city ?? agent?.city ?? null;
});
// E7-3: the reviewer / assignee / recorder by name on every KYC case read
// (`kyc` and, through it, `publishers`' desk) — inverted because `users`
// reaches `publishers`, which reaches `kyc`.
registerKycUserLabelPort((ids) => findUserLabels(ids));
// G10 (Q138): the image decoder behind the DUPLICATE_LISTING_PHOTOS signal —
// sharp, reading a listing photo off the local uploads directory or over
// HTTP with a five-second timeout. Registered here rather than inside the
// signal so the arithmetic stays free of I/O and a test can register its own.
installThumbnailDecoder();

/*
 * The six roles the console ships with, created or refreshed at boot.
 *
 * There is no startup hook in this codebase — server.ts binds the port and
 * starts the jobs — and seeding from prisma/seed.ts would only reach a fresh
 * database. So it runs here, once, deliberately NOT awaited: a role catalogue
 * that cannot be written is not a reason to refuse traffic, and the launch
 * rule keeps the console usable until it succeeds. Skipped under NODE_ENV
 * 'test', where importing the app must not write to a database.
 */
if (env.NODE_ENV !== 'test') {
  void ensureSystemRoles().catch((err: unknown) => {
    logger.warn('Could not ensure the system roles', {
      cause: err instanceof Error ? err.message : String(err),
    });
  });
  // E6: the system account the jobs attribute their audit rows to. Same
  // shape as the roles: not awaited, a miss is a warning, and `systemUserId`
  // retries on first use.
  void ensureSystemUser().catch((err: unknown) => {
    logger.warn('Could not ensure the system user', {
      cause: err instanceof Error ? err.message : String(err),
    });
  });
  // E6: a placeholder DRAFT of each agreement kind that has no row at all, so
  // ops have something to edit at /agreements/templates. A draft satisfies
  // no gate, so nothing changes until one is published.
  void ensureAgreementDrafts()
    .then((kinds) => {
      if (kinds.length > 0) logger.info('Seeded placeholder agreement drafts', { kinds });
    })
    .catch((err: unknown) => {
      logger.warn('Could not ensure the agreement drafts', {
        cause: err instanceof Error ? err.message : String(err),
      });
    });
  // Lot E (Q98): the year's holidays, the same way and for the same reason.
  // Idempotent — only the days that are missing are written, and a name ops
  // changed is never rewritten.
  void ensureHolidays()
    .then((inserted) => {
      if (inserted > 0) logger.info('Seeded holidays', { inserted });
    })
    .catch((err: unknown) => {
      logger.warn('Could not ensure the holidays', {
        cause: err instanceof Error ? err.message : String(err),
      });
    });
  // Lot G (Q122): the free `department` strings on Employee rows become
  // Department records once, and the rows are linked. Idempotent — a second
  // boot finds nothing unlinked and writes nothing.
  void ensureDepartments().catch((err: unknown) => {
    logger.warn('Could not ensure the departments', {
      cause: err instanceof Error ? err.message : String(err),
    });
  });
  // Lot E (Q87): the outbound templates — one row per message that already
  // left the platform, written once by key and never overwritten, so nothing
  // goes silent the day the dispatcher boots and nothing ops edited is undone.
  void ensureTemplates().catch((err: unknown) => {
    logger.warn('Could not ensure the notification templates', {
      cause: err instanceof Error ? err.message : String(err),
    });
  });
  // Lot G (answer 144): every feature declared in the codebase becomes a
  // FeatureFlag row — created on unless it launches dark, a REGISTERED row
  // refreshed but never re-switched, a MANUAL row never touched. Until it
  // lands, a declared feature answers from its launch default, so nothing
  // waits on it.
  void ensureFeatureRegistry().catch((err: unknown) => {
    logger.warn('Could not ensure the feature registry', {
      cause: err instanceof Error ? err.message : String(err),
    });
  });
}

// Supplies shared/errors' ServerErrorAlertPort — the 5xx-rate alert. shared/
// cannot import a module, so the fan-out to the admins is composed here from
// the two narrow exports it needs: who the admins are, and how to tell them.
// Lot G (Q130): the five-minute health sample pings Postgres through
// `shared/database`, which a module may only import for types; bootstrap,
// like `health.ts`, may hold the ping and hands it to `ops` here.
registerPostgresProbe(() => pingDatabase());

registerServerErrorAlertPort({
  alertAdmins: async (alert) => {
    const adminIds = await listAdminUserIds();
    const when = alert.windowStartedAt.toISOString().slice(11, 16);
    await Promise.all(
      adminIds.map((userId) =>
        createNotification({
          userId,
          type: 'SYSTEM',
          title: 'Server errors above threshold',
          subtitle: `${alert.count} errors since ${when} UTC`,
          message: `The API returned ${alert.count} server errors in a minute (threshold ${alert.threshold}). Last: ${alert.sample.status} ${alert.sample.code ?? ''} on ${alert.sample.path ?? 'unknown path'}, request ${alert.sample.requestId ?? 'n/a'}.`,
          suggestedAction: 'Check the error sink and the audit log',
        }),
      ),
    );
  },
});

// Supplies kyc's EmployeeLookupPort (Lot D): the row behind a session and an
// id check, for employee KYC. Inverted because `employees` reaches `users`,
// `users` reaches `publishers` for the manifest, and `publishers` reaches
// `kyc` for the desk — an import would close that ring. Unregistered, an
// employee has no KYC to read and none can be recorded: a 404, never a 500.
registerEmployeeLookupPort({
  findByUserId: (userId) => findEmployeeByUserId(userId),
  exists: (employeeId) => employeeExists(employeeId),
});

// Supplies the uploads module's FileAccessPort (Lot D, Q61): whether the
// viewer of a private file is the party's agent under a live PROFILE grant —
// the door-to-door onboarding grant included. Composed here because `uploads`
// sits underneath `payouts` and `invoices`, which `publishers` reaches, so it
// cannot import the four modules the answer needs. Unregistered, only the
// owner and the desk can open a private file.
// Lot F: the same live-grant question also admits an agent's on-behalf
// upload (`POST /upload` naming `ownerUserId`), and a DISPUTE_EVIDENCE file
// opens to the other side of the case it sits on — the parties `disputes`
// names for the file, or their agent under a grant. `uploads` cannot import
// `disputes` (disputes sits above it through orders and wallets), so the
// question is asked here.
const agentMayViewFileFor = async (viewerUserId: string, ownerUserId: string): Promise<boolean> => {
  const agent = await findAgentProfile(viewerUserId);
  if (!agent) return false;
  const [publisher, advertiser] = await Promise.all([findPublisherForUser(ownerUserId), getAdvertiserForUser(ownerUserId)]);
  if (publisher && (await liveGrantFor(agent.id, { publisherId: publisher.id }, 'PROFILE'))) return true;
  if (advertiser && (await liveGrantFor(agent.id, { advertiserId: advertiser.id }, 'PROFILE'))) return true;
  return false;
};

registerFileAccessPort({
  agentMayView: agentMayViewFileFor,
  disputePartyMayView: async (viewerUserId, fileId, holders) => {
    const parties = await disputePartiesForEvidenceFile(fileId, holders);
    if (parties.includes(viewerUserId)) return true;
    for (const partyUserId of parties) {
      if (await agentMayViewFileFor(viewerUserId, partyUserId)) return true;
    }
    return false;
  },
  // Lot I: a SUPPORT_ATTACHMENT is the thread's — the requester opens what
  // ADX attached to their own ticket. `uploads` admits the owner and the
  // desk before it asks; this is the other side.
  supportPartyMayView: supportAttachmentViewer,
});

// E7-3: the party record behind a login — `{ type, id, displayId, name,
// kycStatus }` per user, every record a login holds — composed once from the
// three parties' label exports and handed to both desks that name a person:
// `disputes` (who a case is against) and `support` (who raised a ticket, and
// the rail beside the thread — wallet balance and open orders too). Composed
// here because neither desk may import the six modules the answers live in.
// Unregistered, both reads still answer with the record null.
async function partyRecordsForUsers(userIds: readonly string[]): Promise<Map<string, RequesterParty[]>> {
  const ids = [...userIds];
  const [publishers, advertisers, agents] = await Promise.all([
    findPublisherLabelsForUsers(ids),
    findAdvertiserLabelsForUsers(ids),
    findAgentLabelsForUsers(ids),
  ]);
  const out = new Map<string, RequesterParty[]>();
  const add = (userId: string, record: RequesterParty) => {
    const list = out.get(userId) ?? [];
    list.push(record);
    out.set(userId, list);
  };
  for (const row of publishers) add(row.userId, { type: 'PUBLISHER', id: row.id, displayId: row.displayId, name: row.name, kycStatus: row.kycStatus });
  for (const row of advertisers) add(row.userId, { type: 'ADVERTISER', id: row.id, displayId: row.displayId, name: row.name, kycStatus: row.kycStatus });
  for (const row of agents) add(row.userId, { type: 'AGENT', id: row.id, displayId: row.displayId, name: row.name, kycStatus: row.kycStatus });
  return out;
}

registerPartyLookupPort({ partiesForUsers: partyRecordsForUsers });

registerRequesterPort({
  partiesForUsers: partyRecordsForUsers,
  walletBalance: async (party) => {
    const wallet = await findWalletFor({ kind: party.type, id: party.id });
    return wallet ? money(wallet.balance) : null;
  },
  // The closure review's composition (account-lifecycle): orders on the
  // publisher's listings, orders the login placed as advertiser, jobs the
  // agent is holding — counted once across the three.
  openOrders: async (userId, party) => {
    const [onListings, asAdvertiser, asAgent] = await Promise.all([
      party?.type === 'PUBLISHER'
        ? getListingsForPublisher(party.id).then((listings) => findOpenOrdersForListings(listings.map((listing) => listing.id)))
        : Promise.resolve([]),
      findOpenOrdersForAdvertiserUser(userId),
      party?.type === 'AGENT' ? getAgentOrderIdsAwaitingWork(party.id) : Promise.resolve([]),
    ]);
    return new Set([...onListings, ...asAdvertiser, ...asAgent].map((order) => order.id)).size;
  },
});

export const apiRouter = Router();

apiRouter.get('/health', healthHandler);
// Readiness: pings Postgres and Redis; 503 names the failing part.
apiRouter.get('/health/ready', asyncHandler(readyHandler));

// GET is unauthenticated (the agent app fetches it on boot); the writes are
// ADMIN-only — Q33 retired the x-admin-secret header the flow editor used.
apiRouter.use('/config', configRouter);
// Public like /config, and for the same reason: read before anyone signs in.
apiRouter.use('/app', appStatusRouter);
apiRouter.use('/legal', legalRouter);
// Lot A (Q31): the platform settings row and the feature flags, the two
// documents other modules read on their hot paths. ADMIN-only at the router.
// Lot E (decision 95): the housekeeping read — last dump, last drill,
// retention-due, job heartbeats. Mounted AHEAD of platformSettingsRouter so
// the request is authenticated once, by its own router, rather than passing
// through the settings router's guard first.
apiRouter.use('/settings/system-health', opsRouter);
apiRouter.use('/settings', platformSettingsRouter);
apiRouter.use('/flags', flagRouter);
apiRouter.use('/app/flags', appFlagsRouter);

// ── Identity ──
apiRouter.use('/auth', authRouter);
// ORDER-SENSITIVE (new in Lot A): closure and erasure hang off /users but are
// owned by account-lifecycle. Mounted AHEAD of userRouter, or that router's
// `GET /:id` would read "closure-cases" and "erasure" as user ids and answer
// 404 from inside its own tree. See modules/account-lifecycle/README.md.
apiRouter.use('/users', accountLifecycleRouter);
// G6 (Q103/133): the phone's push registration — /users/me/devices — owned by
// `notifications`, mounted here beside the lifecycle router for the same
// reason and ahead of userRouter for the same reason.
apiRouter.use('/users', deviceRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/qr', qrRouter);
// Address <-> coordinates and place search, the one door to Google Maps —
// and, Lot V, the geography catalogue and the city rollout.
apiRouter.use('/geo', geoRouter);
// Lot V: the pickers and the typed-name lookup, any signed-in session.
apiRouter.use('/app/geo', appGeoRouter);

// ORDER-SENSITIVE (1/3): this route is deliberately public, and listingRouter
// below applies authenticate() to everything under /listings. Registering it
// after that mount would turn it into a 401.
apiRouter.get('/listings/:id/similar', asyncHandler(similarListingsHandler));

// ORDER-SENSITIVE (new in Lot A): modular suspension. Its paths hang off the
// party — /listings/:id/suspend, /agents/:id/reinstate — so it is mounted
// ahead of those routers, which would otherwise take the request and answer
// 404 from inside their own tree.
apiRouter.use(suspensionRouter);

// ORDER-SENSITIVE (Lot D, Q104/Q112): reviews hang off the parties too —
// /campaigns/:id/spots/:spotId/review, /listings/browse/:id/reviews,
// /orders/:id/rate-agent, /agents/:id/reviews — and are mounted ahead of
// those routers for the same reason as suspension. Every route carries its
// own authenticate. The desk is /reviews, below with the back office.
apiRouter.use(reviewPartyRouter);

// ── Supply and demand ──
apiRouter.use('/orders', orderRouter);
// ORDER-SENSITIVE (Lot B, Q13): a publisher's own invoice to ADX hangs off
// /publishers/me but is owned by `invoices`. Mounted AHEAD of publisherRouter
// so nothing in that tree reads "me" as a publisher id.
apiRouter.use('/publishers/me/invoices', publisherInvoiceRouter);
// G6 (Q110): the publisher's booking report and spot insights hang off
// /publishers/me/bookings but are `orders`' — mounted ahead of
// publisherRouter for the same reason as the invoices.
apiRouter.use('/publishers/me/bookings', publisherBookingRouter);
apiRouter.use('/publishers', publisherRouter);
apiRouter.use('/listings', listingRouter);
// Mounted on its own prefix rather than under /listings: supply owns the
// publisher funnel, agreements, attempts and compliance, not just listings.
apiRouter.use('/supply', supplyRouter);
apiRouter.use('/identifiers', identifierRouter);
// Lot D (Q5): the advertiser's saved spaces, under their account but owned
// by `listings`. Mounted AHEAD of advertiserRouter with its own authenticate
// so the request is authenticated once; the party policy is assertMayActFor.
apiRouter.use('/advertisers', savedSpacesRouter);
// Demand side. Mounted on its own prefix rather than under /advertiser-kyc:
// advertisers own their brands, agreements and wallet, not just their KYC.
apiRouter.use('/advertisers', advertiserRouter);
// Lot B (Q13): the advertiser's invoices, under their account but owned by
// `invoices`. After advertiserRouter, whose tree has no /:id/invoices to
// take the request first; the party policy is the same assertMayActFor.
apiRouter.use('/advertisers', advertiserInvoiceRouter);
// Lot C (Q110): the advertiser's gateway payments, under their account but
// owned by `payments`. Same placement and policy as the invoices above.
apiRouter.use('/advertisers', advertiserPaymentRouter);
// Sits beside supply rather than under /listings: pricing owns the taxonomy,
// market data and surge calendar, and answers about spots that are not yet
// listings at all.
apiRouter.use('/pricing', pricingRouter);
// Separate from /pricing on purpose: pricing decides what a publisher lists at,
// revenue decides what happens to that number. Merging them would make ADX
// unable to change its take rate without re-pricing the market.
apiRouter.use('/revenue', revenueRouter);
apiRouter.use('/earnings', earningsRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/rate-cards', rateCardRouter);
apiRouter.use('/price-model', priceModelRouter);

// The booking flow. Mounted after the modules it calls — advertisers for the
// wallet, revenue for the arithmetic, orders for fulfilment — because a campaign
// is assembled from all three and owns none of them.
apiRouter.use('/campaigns', campaignRouter);

// Advertiser subscriptions, sold by an agent. Beside campaigns rather than
// inside them: a plan is a commercial relationship, a campaign is one booking.
apiRouter.use('/packages', packageRouter);
// Lot C (Q110): the gateway door for both of the above — the intent, the
// client-side confirmation, the register and the refund. After campaigns
// and packages because a payment is for one of them and owns neither.
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/notifications', notificationRouter);
// Lot E (Q87/Q64): the outbound desk — templates and the masked delivery log
// under /comms (its unsubscribe link is the one public route in it), and the
// broadcast desk under /announcements. Both ADMIN at the router.
apiRouter.use('/comms', commsRouter);
apiRouter.use('/announcements', announcementRouter);
apiRouter.use('/support', supportRouter);
apiRouter.use('/disputes', disputeRouter);
// Lot D (Q54/Q92): fraud as a case object — ADMIN at the router; a decision
// reaches the party through the suspension it applies.
apiRouter.use('/fraud', fraudRouter);
apiRouter.use('/leads', leadRouter);
apiRouter.use('/visits', visitRouter);
apiRouter.use('/safety', safetyRouter);

// Delegated access. Mounted after /support because that is where a grant
// starts: a publisher raises a ticket, ADX assigns an agent, and only then does
// the publisher generate the code these routes issue.
apiRouter.use('/access-grants', accessGrantRouter);

// ORDER-SENSITIVE (2/3): agent gamification milestones. Distinct from the
// order-milestone routers directly below — see modules/agents/README.md.
apiRouter.use('/milestones', milestoneRouter);

apiRouter.use('/milestone-templates', milestoneTemplateRouter);
apiRouter.use('/milestone-plans', milestonePlanRouter);

// ORDER-SENSITIVE (3/3): mounted AFTER '/orders', so a request here passes
// through the order router's authenticate() layer first and is authenticated
// twice. Existing behaviour, pinned by the route inventory.
apiRouter.use('/orders/:orderId/milestones', orderMilestoneRouter);
// Lot B (B4b): the order's print job — `/orders/:id/print-job` — owned by
// `print-partners`, mounted after '/orders' for the same reason as the
// milestones above.
apiRouter.use('/orders', printJobRouter);

apiRouter.use('/agent/milestones', agentMilestoneRouter);
apiRouter.use('/training', trainingRouter);
// The party's own money, and ADX's side of it. Split because the second is
// admin-only at the router and the first can never name another party.
apiRouter.use('/payouts', payoutRouter);
apiRouter.use('/finance', financeRouter);
// Lot B (Q41): the refund desk's two queues, under the finance prefix but
// owned by the modules whose tables they read — campaign refunds by
// `campaigns`, wallet refund requests by `advertisers`. Mounted after
// financeRouter, whose authenticate + ADMIN guard they pass through first.
apiRouter.use('/finance/campaign-refunds', campaignRefundRouter);
apiRouter.use('/finance/refund-requests', refundDeskRouter);
// E6: the top-up register, owned by `advertisers` for the same reason.
apiRouter.use('/finance/top-ups', topUpDeskRouter);
// Lot B (Q85): bank statements in, each line explained by one ADX record.
// Its own module — it reads withdrawals, top-ups and the books through
// their indexes — mounted after financeRouter like the queues above.
apiRouter.use('/finance/reconciliation', reconciliationRouter);
// Lot B (Q13): the legal entity, the invoice register, the publishers'
// invoices and the statement run — `invoices`' side of /finance, mounted
// after financeRouter for the same reason as the two queues above. The
// publisher's payment advices sit where their wallet does.
apiRouter.use('/finance', invoiceFinanceRouter);
apiRouter.use('/payouts/wallet/statements', statementRouter);
apiRouter.use('/upload', uploadRouter);
// Lot D (Q61): a file by id — the one door to every private document.
apiRouter.use('/files', filesRouter);
apiRouter.use('/integrations', integrationsRouter);
// QR-11: Settings › Brand & theme — the draft, publish, the release history. ADMIN at the router.
apiRouter.use('/branding', brandingRouter);
apiRouter.use('/onboarding', onboardingRouter);

// ── Back office ──
apiRouter.use('/employees', employeeRouter);
// Lot E (Q98/Q99): the holiday calendar and the people registry, ADMIN at
// the router; and the staff diary beside them, reading `hr` for both and
// `visits` for the field overlay.
apiRouter.use('/hr', hrRouter);
apiRouter.use('/schedule', scheduleRouter);
// Lot AA (Q70): the DR 10 Tasks section — projects, tasks, issues, the board
// and the overview, ADMIN + work.view at the router; `/work/me/*` is any
// employee or agent session, scoped to their own tasks.
apiRouter.use('/work', workRouter);
// Lot B (B4b): the print shops ADX pays, as payees. ADMIN at the router.
apiRouter.use('/print-partners', printPartnerRouter);
// G13-B: the desk's list of quote requests across orders. ADMIN at the router.
apiRouter.use('/print-quote-requests', printQuoteRequestsRouter);
// Lot N: the print partner's KYC desk. ADMIN at the router; the partner's own
// routes are /print-partners/me/kyc on the partner router above.
apiRouter.use('/print-partner-kyc', printPartnerKycRouter);
// The trail every module writes through shared/audit, read back. Admin-only
// at the router; the CSV export is itself a row in it.
apiRouter.use('/audit', auditRouter);
// Lot B (Q30/Q80): the console's month in numbers — bookings, GMV, take
// rate. Read-only, ADMIN at the router, cached a minute.
apiRouter.use('/admin', adminOverviewRouter);
// O-B: one overview read per user section — aggregates only, ADMIN at the
// router, cached a minute per section + window + city.
apiRouter.use('/section-overviews', sectionOverviewsRouter);
// Lot S: the legacy-book import for advertisers, agents, print partners and
// employees — the publisher's importer, generalised. ADMIN at the router;
// every party it creates goes through that party's own creation service.
apiRouter.use('/party-imports', partyImportsRouter);
// Lot G (Q129/Q143): the reports catalogue, runs and schedules. ADMIN at the
// router; `GET /reports/runs/:id/file` carries its own guard (a signed,
// time-limited link a scheduled report's recipient opens, or an admin).
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/roles-config', rolesConfigRouter);
apiRouter.use('/advertiser-kyc', advertiserKycRouter);
apiRouter.use('/user-kyc', userKycRouter);
apiRouter.use('/agent-kyc', agentKycRouter);
// Lot D: the employee record's KYC, the agent record's twin.
apiRouter.use('/employee-kyc', employeeKycRouter);
// Before /agents: the day view is the visits module's, mounted where an
// agent's own things live. Registered first so `me/day` is never read by the
// agents router as an id.
apiRouter.use('/agents/me/day', agentDayRouter);
apiRouter.use('/agents', agentRouter);
// The text each party accepts, versioned; `supply` and `advertisers` record
// the click, this owns the words. See modules/agreements/README.md.
apiRouter.use('/agreements', agreementRouter);
// Lot D (Q104): the reviews desk — every review by subject, hide and unhide.
// ADMIN at the router; the party-facing routes are mounted above.
apiRouter.use('/reviews', reviewRouter);

// Webhook endpoints — no authentication, called by third-party providers.
// One Digio callback for every party: a request id no publisher claims is offered to the advertiser side.
onUnmatchedDigioWebhook(handleAdvertiserDigioWebhook);
// Lot N: and, after the advertiser, to the print partner side.
onUnmatchedDigioWebhook(handlePrintPartnerDigioWebhook);
// N3-B: and to the agent's and the employee's records — the desk's one-click request opens their sessions.
onUnmatchedDigioWebhook(handleAgentDigioWebhook);
onUnmatchedDigioWebhook(handleEmployeeDigioWebhook);
apiRouter.post('/webhooks/digio', asyncHandler(digioWebhookHandler));
// Lot C (Q110): the three payment gateways' callbacks. Signature-checked in
// each adapter over the raw body create-app keeps beside the parsed one
// (the same arrangement the Digio hook relies on); CCAvenue's is a form post.
apiRouter.use('/webhooks', paymentWebhookRouter);
// Lot E (Q128): the SMS rails' delivery reports — /webhooks/msg91 and
// /webhooks/twilio — matched to the delivery log on the provider message id.
apiRouter.use('/webhooks', commsWebhookRouter);
