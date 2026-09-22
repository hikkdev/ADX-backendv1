import { Router } from 'express';

import { authenticate, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { verifyCaptcha } from '../../shared/security';
import {
  agentQrInboundHandler,
  feedsStatusHandler,
  getFeedRunHandler,
  googleLeadWebhookHandler,
  linkedinLeadWebhookHandler,
  listFeedRunsHandler,
  listReferralsHandler,
  metaLeadWebhookHandler,
  metaVerifyHandler,
  myReferralLinkHandler,
  myReferralsHandler,
  referHandler,
  referralInboundHandler,
  runFeedHandler,
  siteQrInboundHandler,
  webInboundHandler,
} from './sources.controller';
import {
  assignInPolygonHandler,
  claimLeadHandler,
  createTerritoryHandler,
  createZoneHandler,
  heatHandler,
  listTerritoriesHandler,
  listZonesHandler,
  mapHandler,
  patchTerritoryHandler,
  patchZoneHandler,
  releaseLeadHandler,
} from './map.controller';
import {
  answerCallHandler,
  callbackHandler,
  callHandler,
  callLogHandler,
  callStatusHandler,
  channelFunnelHandler,
  channelsHandler,
  createSequenceHandler,
  enrolHandler,
  getSequenceHandler,
  googleBusinessWebhookHandler,
  gupshupWebhookHandler,
  inboxHandler,
  interaktWebhookHandler,
  ivrChoiceHandler,
  ivrHandler,
  listSequencesHandler,
  messagesHandler,
  metaVerifyHandler as outreachMetaVerifyHandler,
  metaWebhookHandler as outreachMetaWebhookHandler,
  missedCallHandler,
  patchSequenceHandler,
  previewStepHandler,
  requireChannelToken,
  sendHandler,
  stopSequenceHandler,
  teleQueueHandler,
  threadHandler,
  touchHandler,
} from './outreach.controller';
import {
  getInviteHandler,
  issueInviteHandler,
  landingAcceptProposalHandler,
  landingCallbackHandler,
  landingCopyHandler,
  landingHandler,
  landingLinkHandler,
  landingOtpHandler,
  landingSlotHandler,
  landingVerifyHandler,
  listProposalsHandler,
  markProposalHandler,
  sendProposalHandler,
} from './landing.controller';
// LH10: the integrity desk's handlers, as one namespace — the desk's doors are eight.
import * as integrity from './integrity.controller';
import {
  adminLeadsHandler,
  bookVisitHandler,
  captureLeadHandler,
  convertLeadHandler,
  createLeadHandler,
  flagHotHandler,
  funnelHandler,
  getLeadHandler,
  importLeadsHandler,
  leadsNearHandler,
  listSourcesHandler,
  logContactHandler,
  markEngagedHandler,
  markLostHandler,
  markProposedHandler,
  moveStageHandler,
  patchLeadHandler,
  patchSourceHandler,
  rescoreLeadHandler,
} from './leads.controller';

export const leadRouter = Router();

/* LH3: the public doors — the website form (captcha where configured), the
 * SITE QR poster, the agent's card, a referral link. Registered above
 * `authenticate` because the people at them have no account yet. */
leadRouter.post('/inbound/web', verifyCaptcha, asyncHandler(webInboundHandler));
leadRouter.post('/inbound/site/:qrId', asyncHandler(siteQrInboundHandler));
leadRouter.post('/inbound/agent/:qrId', asyncHandler(agentQrInboundHandler));
leadRouter.post('/inbound/referral/:code', asyncHandler(referralInboundHandler));

leadRouter.use(authenticate);

/* LH3: referrals — any signed-in publisher, advertiser or agent. */
leadRouter.post('/referrals', asyncHandler(referHandler));
leadRouter.get('/referrals/me', asyncHandler(myReferralsHandler));
leadRouter.get('/referrals/me/link', asyncHandler(myReferralLinkHandler));
leadRouter.get('/referrals', requireRole('ADMIN'), asyncHandler(listReferralsHandler));

/* LH4: the agent's street capture — a photographed wall or shop, on their own list. */
leadRouter.post('/capture', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), asyncHandler(captureLeadHandler));

/* LH3: the directory feeds — status, a run, the runs. */
leadRouter.get('/feeds', requireRole('ADMIN'), asyncHandler(feedsStatusHandler));
leadRouter.get('/feeds/runs', requireRole('ADMIN'), asyncHandler(listFeedRunsHandler));
leadRouter.get('/feeds/runs/:runId', requireRole('ADMIN'), asyncHandler(getFeedRunHandler));
leadRouter.post('/feeds/:key/run', requireRole('ADMIN'), asyncHandler(runFeedHandler));

/* The agent's own list. Not role-gated beyond a session: a publisher-side and
 * an advertiser-side agent both work leads, and `?side=` is how they differ.
 * Ops reads the same rows through /leads below. */
leadRouter.get('/near', asyncHandler(leadsNearHandler));

/* LH5: the hunting map — a viewport for every agent of the side and for
 * ops (clusters above sixty square kilometres, pins below); the heat is
 * demand over supply; territories (D8) and priority zones (D7) are the
 * desk's rows; "assign from the polygon" is the desk's bulk move. */
leadRouter.get('/map', asyncHandler(mapHandler));
leadRouter.get('/map/heat', asyncHandler(heatHandler));
leadRouter.post('/map/assign', requireRole('ADMIN'), asyncHandler(assignInPolygonHandler));
leadRouter.get('/territories', requireRole('ADMIN'), asyncHandler(listTerritoriesHandler));
leadRouter.post('/territories', requireRole('ADMIN'), asyncHandler(createTerritoryHandler));
leadRouter.patch('/territories/:territoryId', requireRole('ADMIN'), asyncHandler(patchTerritoryHandler));
/* LH10: the integrity desk — the flags, the QA samples, an agent's quality
 * score, and the three sweeps by hand. ADMIN only: a flag is about an agent,
 * and a score nobody has reviewed is not the agent's to read. */
leadRouter.get('/flags', requireRole('ADMIN'), asyncHandler(integrity.listFlagsHandler));
leadRouter.post('/flags/:flagId/decide', requireRole('ADMIN'), asyncHandler(integrity.decideFlagHandler));
leadRouter.post('/flags/scan', requireRole('ADMIN'), asyncHandler(integrity.scanIntegrityHandler));
leadRouter.get('/qa', requireRole('ADMIN'), asyncHandler(integrity.listQaHandler));
leadRouter.post('/qa/:sampleId/review', requireRole('ADMIN'), asyncHandler(integrity.reviewQaHandler));
leadRouter.post('/qa/sample', requireRole('ADMIN'), asyncHandler(integrity.sampleQaHandler));
leadRouter.get('/quality/:agentId', requireRole('ADMIN'), asyncHandler(integrity.agentQualityHandler));
leadRouter.post('/clawbacks/run', requireRole('ADMIN'), asyncHandler(integrity.runClawbacksHandler));

leadRouter.get('/priority-zones', requireRole('ADMIN'), asyncHandler(listZonesHandler));
leadRouter.post('/priority-zones', requireRole('ADMIN'), asyncHandler(createZoneHandler));
leadRouter.patch('/priority-zones/:zoneId', requireRole('ADMIN'), asyncHandler(patchZoneHandler));

/* LH6: the outreach hub — channel states, the two queues, the funnel by channel, the sequence editor. */
leadRouter.get('/outreach/channels', asyncHandler(channelsHandler));
leadRouter.get('/outreach/inbox', asyncHandler(inboxHandler));
leadRouter.get('/outreach/tele-queue', requireRole('ADMIN'), asyncHandler(teleQueueHandler));
leadRouter.get('/outreach/funnel', requireRole('ADMIN'), asyncHandler(channelFunnelHandler));
leadRouter.get('/sequences', requireRole('ADMIN'), asyncHandler(listSequencesHandler));
leadRouter.post('/sequences', requireRole('ADMIN'), asyncHandler(createSequenceHandler));
leadRouter.get('/sequences/preview', requireRole('ADMIN'), asyncHandler(previewStepHandler));
leadRouter.get('/sequences/:sequenceId', requireRole('ADMIN'), asyncHandler(getSequenceHandler));
leadRouter.patch('/sequences/:sequenceId', requireRole('ADMIN'), asyncHandler(patchSequenceHandler));
/* LH7: the invite landing's copy per side — the ladder in force, for the flow editor. */
leadRouter.get('/landing-copy', requireRole('ADMIN'), asyncHandler(landingCopyHandler));

/* ADMIN's desk. Declared before '/:leadId' so "near" and the bare list are
 * never read as an id. */
leadRouter.get('/', requireRole('ADMIN'), asyncHandler(adminLeadsHandler));
leadRouter.post('/', requireRole('ADMIN'), asyncHandler(createLeadHandler));
leadRouter.post('/import', requireRole('ADMIN'), asyncHandler(importLeadsHandler));

/* LH2: the funnel — aggregates by stage, source, agent, city, category, channel. */
leadRouter.get('/funnel', requireRole('ADMIN'), asyncHandler(funnelHandler));

/* LH1: the sources — a record per door, with its learned quality. */
leadRouter.get('/sources', requireRole('ADMIN'), asyncHandler(listSourcesHandler));
leadRouter.patch('/sources/:sourceId', requireRole('ADMIN'), asyncHandler(patchSourceHandler));

leadRouter.get('/:leadId', asyncHandler(getLeadHandler));
leadRouter.post('/:leadId/contact', asyncHandler(logContactHandler));
leadRouter.post('/:leadId/visit', asyncHandler(bookVisitHandler));
leadRouter.post('/:leadId/convert', asyncHandler(convertLeadHandler));
/* LH1: the agent's "this one is hot", and the desk's "score it now". */
leadRouter.post('/:leadId/flag-hot', asyncHandler(flagHotHandler));
/* LH5 (D3): the agent's claim on a pin, and letting it go. */
leadRouter.post('/:leadId/claim', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), asyncHandler(claimLeadHandler));
leadRouter.post('/:leadId/release', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), asyncHandler(releaseLeadHandler));
leadRouter.post('/:leadId/rescore', requireRole('ADMIN'), asyncHandler(rescoreLeadHandler));
/* LH2: the agent's next steps — they replied, a proposal went out, it is lost — and the desk's stage move. */
leadRouter.post('/:leadId/engaged', asyncHandler(markEngagedHandler));
leadRouter.post('/:leadId/proposed', asyncHandler(markProposedHandler));
leadRouter.post('/:leadId/lost', asyncHandler(markLostHandler));
leadRouter.patch('/:leadId/stage', requireRole('ADMIN'), asyncHandler(moveStageHandler));
/* LH6: the unified thread, the composer, the touch log, the calls, the callback, the sequence on this lead. */
leadRouter.get('/:leadId/thread', asyncHandler(threadHandler));
leadRouter.get('/:leadId/messages', asyncHandler(messagesHandler));
leadRouter.post('/:leadId/messages', asyncHandler(sendHandler));
leadRouter.post('/:leadId/touch', asyncHandler(touchHandler));
leadRouter.post('/:leadId/call', asyncHandler(callHandler));
leadRouter.post('/:leadId/call-log', asyncHandler(callLogHandler));
leadRouter.post('/:leadId/callback', asyncHandler(callbackHandler));
leadRouter.post('/:leadId/sequence', asyncHandler(enrolHandler));
leadRouter.delete('/:leadId/sequence', asyncHandler(stopSequenceHandler));
/* LH7 (D6): the invite link and the proposals. */
leadRouter.get('/:leadId/invite', asyncHandler(getInviteHandler));
leadRouter.post('/:leadId/invite', asyncHandler(issueInviteHandler));
leadRouter.get('/:leadId/proposals', asyncHandler(listProposalsHandler));
leadRouter.post('/:leadId/proposals', asyncHandler(sendProposalHandler));
leadRouter.post('/:leadId/proposals/:proposalId/accept', asyncHandler(markProposalHandler));
leadRouter.patch('/:leadId', requireRole('ADMIN'), asyncHandler(patchLeadHandler));

/* LH3: the lead-form ad webhooks — signed by their providers, idempotent by the provider's lead id. Mounted by bootstrap under /webhooks/leads. */
export const leadWebhookRouter = Router();
leadWebhookRouter.get('/meta', asyncHandler(metaVerifyHandler));
leadWebhookRouter.post('/meta', asyncHandler(metaLeadWebhookHandler));
leadWebhookRouter.post('/google', asyncHandler(googleLeadWebhookHandler));
leadWebhookRouter.post('/linkedin', asyncHandler(linkedinLeadWebhookHandler));

/* LH7: the public landing behind adx.in/j/<code> — no session, the code is the key. Mounted by bootstrap under /j. */
export const leadLandingRouter = Router();
leadLandingRouter.get('/:code', asyncHandler(landingHandler));
leadLandingRouter.post('/:code/otp', asyncHandler(landingOtpHandler));
leadLandingRouter.post('/:code/verify', asyncHandler(landingVerifyHandler));
leadLandingRouter.post('/:code/callback', asyncHandler(landingCallbackHandler));
leadLandingRouter.post('/:code/slot', asyncHandler(landingSlotHandler));
leadLandingRouter.post('/:code/proposals/:proposalId/accept', asyncHandler(landingAcceptProposalHandler));
/* The one door on the landing router that takes a session: the app opened by `adx://join/<code>`. */
leadLandingRouter.post('/:code/link', authenticate, asyncHandler(landingLinkHandler));

/* LH6: the outreach providers' webhooks — Meta (WhatsApp Cloud, Instagram, Messenger, signed), the two BSPs (URL token),
 * Business Messages (signed), telephony (Twilio signed; Exotel / Knowlarity by URL token). Mounted by bootstrap under /webhooks/outreach. */
export const leadOutreachWebhookRouter = Router();
leadOutreachWebhookRouter.get('/meta', asyncHandler(outreachMetaVerifyHandler));
leadOutreachWebhookRouter.post('/meta', asyncHandler(outreachMetaWebhookHandler));
leadOutreachWebhookRouter.post('/gupshup', asyncHandler(requireChannelToken('whatsapp')), asyncHandler(gupshupWebhookHandler));
leadOutreachWebhookRouter.post('/interakt', asyncHandler(requireChannelToken('whatsapp')), asyncHandler(interaktWebhookHandler));
leadOutreachWebhookRouter.post('/google-business', asyncHandler(googleBusinessWebhookHandler));
leadOutreachWebhookRouter.post('/telephony/status', asyncHandler(callStatusHandler));
leadOutreachWebhookRouter.get('/telephony/missed-call', asyncHandler(missedCallHandler));
leadOutreachWebhookRouter.post('/telephony/missed-call', asyncHandler(missedCallHandler));
leadOutreachWebhookRouter.get('/telephony/answer', asyncHandler(answerCallHandler));
leadOutreachWebhookRouter.post('/telephony/answer', asyncHandler(answerCallHandler));
leadOutreachWebhookRouter.get('/telephony/ivr', asyncHandler(ivrHandler));
leadOutreachWebhookRouter.post('/telephony/ivr', asyncHandler(ivrHandler));
leadOutreachWebhookRouter.get('/telephony/ivr/choice', asyncHandler(ivrChoiceHandler));
leadOutreachWebhookRouter.post('/telephony/ivr/choice', asyncHandler(ivrChoiceHandler));
