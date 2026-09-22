/**
 * DR 06 — leads.
 *
 * The public surface. `leadClusters` is what the agents module reads to fill
 * the map layer that has been rendering an empty array since the dashboard was
 * built; everything else is reached over HTTP.
 */
export { leadRouter, leadWebhookRouter, leadOutreachWebhookRouter, leadLandingRouter } from './leads.routes';
export { leadClusters } from './leads.service';
/** Lot V: the city wind-down's duty here — every open lead in the city LOST, reason on the thread. */
export { closeOpenLeadsInCity, CITY_WITHDRAWN_LOSS } from './leads.service';
export type { LeadCard } from './leads.service';
/** W-B: the coming-soon waitlist — `geo` creates the lead through this; the phone rule dedupes, the account half of it does not apply. */
export { registerWaitlistLead, WAITLIST_SOURCE } from './leads.service';
export type { WaitlistLeadInput } from './leads.service';
export type { LeadCluster, LeadClusterScope } from './leads.repository';
export { leadPillOf, isOpenLead, LEAD_STATUSES, LEAD_TEMPERATURES } from './leads.schema';
/** LH1: the nightly job's two duties, and the touch other modules record (a visit done, a link opened). */
export { recomputeAll, learnSourceQuality, touchLead, recomputeLead } from './scoring.service';
export { resolveSource } from './leads.service';
/** LH3: the party-imports kit creates and merges leads through these — the console's Create and edit, exactly. */
export { createLead, patchLead } from './leads.service';
/** LH2: the pipeline's system moves (the hourly job), the recycle port LH6 fills, the stamps other modules leave (a link opened, a reply). */
export { watchRetention, recycleDue, advanceStage, stampMoment, registerLeadRecyclePort } from './stages.service';
/** LH9: the funnel over a cohort, as the desk's `/leads/funnel` answers it — the Leads overview carries it, never re-derives it. */
export { funnel as leadFunnel } from './stages.service';
/** LH10: the integrity scan, its flags and the desk's decision. */
export { scanIntegrity, scanLead, listFlags, decideFlag, flagsForLead, LEAD_FLAG_KINDS, LEAD_FLAG_STATUSES, FLAG_LABEL, BURST_PER_HOUR } from './integrity.service';
export type { FlagView, LeadFlagKindValue, LeadFlagStatusValue } from './integrity.service';
/** LH10: the QA draw, its review and the agent's quality score — the console reads this beside the rating. */
export { sampleQa, listQaSamples, reviewQaSample, qualityFor, readVisitEvidence, readCallEvidence, everyNth, PROOF_RADIUS_M, MIN_CALL_SEC, QUALITY_WINDOW_DAYS, MIN_QUALITY_SAMPLE } from './qa.service';
export type { QaSampleView, QualityScore } from './qa.service';
/** LH10: the clawback watch — an activation reward on an account that did not last. */
export { watchClawbacks, CLAWBACK_DAYS } from './clawback.service';
/** LH11: the recycle's fresh sequence — the port LH2 declared and LH6's sequences fill. */
export { registerRecycleSequencing } from './sequences.service';
export type { FunnelRows as LeadFunnelRows } from './leads.repository';
export { LEAD_STAGES, LEAD_LOST_REASONS, nextStepOf, isOpenStage } from './stages.rules';
export type { LeadStageValue, LeadLostReasonValue } from './stages.rules';
/** LH3: the routing's ports — LT-1's last fix for "nearest", LH5's territories — and the referral credit on the catch. */
export { registerAgentPositionPort, registerTerritoryRouter, routeLead } from './routing.service';
export { creditReferralOnActivation, myReferralLink, refer } from './referrals.service';
export { inboundLead } from './inbound.service';
export type { InboundInput } from './inbound.service';

/** LH5: the map's ports and duties — LT-1's fix for the nearby-hot alert, the hourly lapse, the link-opened alert LH7 raises. */
export { registerMapPositionPort, alertLinkOpened, alertNearbyHot, sweepClaims, territoryFor } from './map.service';

/** LH6: the outreach hub — the job's three ticks, the boot seed, the ports LH7 fills. */
export { flushQueued, registerInviteLinkPort, sendMessage, reachability, channelStates } from './outreach.service';
export type { ChannelState, SendInput, SendOutcome } from './outreach.service';
export { ensureDefaultSequences, tickSequences, enrol as enrolInSequence, onTemperature as sequencesOnTemperature } from './sequences.service';
export { purgeRecordings, requestCallback, RECORDING_RETENTION_DAYS } from './calls.service';
export { LEAD_CHANNELS, isLeadChannel } from './conversations.service';
export type { LeadChannelValue } from './conversations.service';
/** LH7: the invite link (D6) and the proposals. */
export { issueInvite, inviteFor, openLanding, landingCopy, registerPartyOpenerPort } from './invites.service';
export type { PartyOpener } from './invites.service';
export { inviteUrl, inviteView, openedAgo, INVITE_DAYS } from './invites.rules';
export { sendProposal, listProposalsFor, acceptProposal, PROPOSAL_KINDS, registerPackagePorts } from './proposals.service';
export type { ProposalView, ProposalKind } from './proposals.service';

// LH5: a lead that turns HOT is offered to the agents within a kilometre.
import { registerTemperatureHook } from './scoring.service';
import { alertNearbyHot as offerNearby } from './map.service';
registerTemperatureHook(async (leadId, to) => {
  if (to === 'HOT') await offerNearby(leadId);
});
// LH7: the outreach copy's `{{link}}` is the lead's live invite, minted on first use.
import { registerInviteLinkPort } from './outreach.service';
import { inviteLinkFor } from './invites.service';
registerInviteLinkPort(inviteLinkFor);

// LH6: a lead that gains or changes its temperature joins the sequence for it (and leaves the old one).
import { onTemperature as sequencesFollowTemperature } from './sequences.service';
registerTemperatureHook(async (leadId, to, from) => {
  await sequencesFollowTemperature(leadId, to, from);
});

// LH3 (D9): the referrer's wallet credit rides the retention watch's activation.
import { registerActivationHook } from './stages.service';
import { creditReferralOnActivation as creditOnActivation } from './referrals.service';
registerActivationHook(async (lead) => {
  await creditOnActivation(lead.id);
});
/** Lot U: the row the leads importer takes, read by `party-imports`' format guide. */
export { createLeadSchema, LEAD_SIDES } from './leads.schema';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
