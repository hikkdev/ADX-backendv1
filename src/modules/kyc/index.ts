/**
 * KYC — identity verification records that stand on their own.
 *
 * Four subfeatures with the same admin review workflow:
 *   advertiser/       AdvertiserKyc, documents by entity type
 *   user/             UserKyc, a single self-recorded video — the liveness proof (Lot D, Q131)
 *   agent/            AgentKyc, recorded at ADX's desk on the agent's behalf (D4)
 *   employee/         EmployeeKyc, the agent record's twin for staff (Lot D)
 *   document-review/  the per-document decisions every desk shares (Lot D, Q42)
 *
 * Publisher KYC is deliberately NOT here. PublisherKyc is part of the publisher
 * onboarding aggregate and is driven by the Digio integration, so it lives in
 * the `publishers` module — but its per-document decisions, its liveness
 * gate and its purge rules are this module's, reached through the exports
 * below. See docs/backend-modules.md.
 */
export { advertiserKycRouter } from './advertiser/advertiser-kyc.routes';
export { userKycRouter } from './user/user-kyc.routes';
export { agentKycRouter } from './agent/agent-kyc.routes';
export { employeeKycRouter } from './employee/employee-kyc.routes';

/** Used by bootstrap: claims a Digio webhook whose request id is an advertiser's. */
export { handleAdvertiserDigioWebhook } from './advertiser/advertiser-digio.service';
/** N3-B, used by bootstrap: the same for an agent's and an employee's — the desk's one-click Digio request lands on their record. */
export { handleAgentDigioWebhook } from './agent/agent-digio.service';
export { handleEmployeeDigioWebhook } from './employee/employee-digio.service';
/**
 * N3-B: the party state every queue and every party read derive — re-exported
 * from `shared/kyc-state`, where it lives so the party modules `kyc` imports
 * can read it without a ring.
 */
export { KYC_QUEUE_STATES, deriveKycState, kycSummaryOf, kycStateCounts, kycQueueStateSchema, kycPartyStateWhere, kycQueueBaseWhere, kycRecordStateWhere } from '../../shared/kyc-state';
export type { KycQueueState, KycSummary, KycStateCounts } from '../../shared/kyc-state';
/** Used by bootstrap: the two `employees` lookups employee KYC asks through a port (the import would close a ring through `users` and `publishers`). */
export { registerEmployeeLookupPort } from './employee/employee-lookup.port';
/** Lot G (Q126/Q141): the code's intake ladder, for `scripts/seedConfig` to write as `flows.employee-intake`. */
export { CODE_EMPLOYEE_INTAKE_LADDER } from './employee/intake-ladder';
export type { EmployeeLookupPort } from './employee/employee-lookup.port';

/**
 * Lot D (Q42/Q119): the per-document decisions, for `publishers` — its KYC
 * row lives there, the decisions on its tiles live here, one table for both
 * party types so a re-upload request is the same thing on either side.
 */
export {
  recordDocumentReview,
  flagDocuments,
  flaggedDocuments,
  listDocumentReviews,
  listDocumentReviewsWithReviewer,
  clearDocumentReviews,
} from './document-review/document-review.service';
export type { DocumentDecision, DocumentReviewWithReviewer } from './document-review/document-review.service';

/** Lot D (Q131): the liveness gate and state — `publishers` for the review, `users` for the manifest. */
export { hasSubmittedLiveness, livenessStateFor } from './user/user-kyc.service';
export type { LivenessState } from './user/user-kyc.service';

/** Lot D: what the advertiser's own ladder needs — read by `users` for the manifest's partial mode. */
export { advertiserKycReviewStateFor } from './advertiser/advertiser-kyc.service';
/**
 * E7-3: what every case read carries — the age against the review SLA and
 * the reviewer / assignee / recorder as `{ id, name }`. `publishers` spreads
 * it over its own case; the names come through `registerKycUserLabelPort`,
 * which bootstrap fills from `users.findUserLabels`.
 */
export { kycCaseExtras, registerKycUserLabelPort, resetKycUserLabelPort } from './case-read';
/** E10-1: the same port, for a queue — `publishers` names the assignee on every row through it. G11-1: `kycLabelFor` picks one `{ id, name } | null` out of the lookup. */
export { kycUserLabels, kycLabelFor } from './case-read';
export type { KycCaseExtras, KycCaseRow, UserLabelPort as KycUserLabelPort } from './case-read';
/** Lot F: the manifest pin — the version to stamp on a KYC row at its first submission; `publishers` pins its own row with it. */
export { resolveManifestVersion } from './manifest-pin';

/** Lot D (Q127): the purge job's three sweeps and the rules they share; `publishers` applies the same rules to its row. */
export { purgeVerifiedLivenessVideos } from './user/user-kyc.service';
export { purgeVerifiedAdvertiserImages } from './advertiser/advertiser-kyc-purge.service';
export { PURGE_AFTER_DAYS, purgeCutoff, maskPan, trimDigioPayload } from './purge.rules';

/** Lot D (Q42/Q119): the desk bodies the publisher twin shares. */
export {
  KYC_QUEUE_STATUSES,
  documentDecisionSchema,
  reuploadRequestSchema,
  assignCaseSchema,
  bulkAssignSchema,
  assignedToSchema,
} from './kyc.schema';
export type { DocumentDecisionInput, ReuploadRequestInput, AssignCaseInput, BulkAssignInput } from './kyc.schema';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';

/**
 * Lot G (Q127/142): escalation — one service, three sources. `publishers`
 * calls `escalateKyc` from its queue's button; `fraud` calls
 * `escalateKycForFraudLink` when a case is opened; `jobs/kyc-escalation.job`
 * calls `escalateAgedKycCases` nightly. `kycEscalateSchema` is the body both
 * buttons take.
 */
export { escalateKyc, escalateKycForFraudLink, escalateAgedKycCases, ESCALATION_ROLE_NAMES } from './escalation.service';
export type { KycEscalation, KycEscalationTarget, AgedEscalationReport } from './escalation.service';
export { kycEscalateSchema, escalatedFilterSchema } from './kyc.schema';
export type { KycEscalateInput } from './kyc.schema';

/** Lot N: the desk's request body and facet, shared with the publisher twin. */
export { kycRequestSchema, requestedFilterSchema, KYC_REQUEST_CHANNELS, KYC_DEEP_LINK, kycChannelLabel } from './kyc.schema';
export type { KycRequestInput, KycRequestChannel } from './kyc.schema';
// AG-1: the applicant's identity papers, mirrored onto the desk's KYC record (registered on agents' application port by bootstrap).
export { mirrorAgentIdentityDocument } from './agent/agent-kyc.service';
