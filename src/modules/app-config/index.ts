/**
 * App config — the single `AppConfig` row holding the enum catalogue and the
 * flow-editor definitions the agent app boots from.
 *
 * Distinct from `src/config/`, which is process environment validation, and
 * from `integrations`, which owns provider credentials in a different row.
 */
export { appStatusRouter, configRouter, platformSettingsRouter } from './app-config.routes';
export { DEFAULT_APP_STATUS, gateFor, SERVICE_KEYS } from './app-status';
export type { AppStatus, ServiceKey, ServiceState } from './app-status';
export { APP_ENUMS } from './app-enums';

/** Used by `order-milestones` to pick a default plan for a listing category. */
export { getCategoryPlanId } from './app-config.service';
/** DR 05: `agents` keeps the tier ladder's thresholds and support lines in named rows. */
export { getConfigObject, saveConfigObject } from './app-config.service';

/**
 * Q83: the onboarding ladder as data. `users` reads `flows.onboarding` (at
 * the version a party started on) through `getFlow`, checks it against the
 * template vocabulary, and composes the manifest from it — or from its code
 * ladder when the key is absent. `scripts/seedConfig` writes the seed
 * through the same vocabulary so the two cannot drift.
 */
export { getFlow, ONBOARDING_FLOW_KEY, LISTING_FLOW_KEY, KNOWN_FLOWS } from './app-config.service';
export type { FlowShape, FlowSummary } from './app-config.service';
/**
 * Lot G (Q126/Q141): the two step ladders. `orders` reads `flows.agent-job`
 * and `kyc/employee` reads `flows.employee-intake` through `getFlow`, each
 * checked against its schema here and falling back to the code ladder.
 */
export {
  AGENT_JOB_FLOW_KEY,
  EMPLOYEE_INTAKE_FLOW_KEY,
  AGENT_JOB_PROOFS,
  EMPLOYEE_INTAKE_PROOFS,
  REQUIRED_AGENT_JOB_PROOFS,
  REQUIRED_EMPLOYEE_INTAKE_PROOFS,
  agentJobLadderSchema,
  employeeIntakeLadderSchema,
} from './step-ladder';
export type { AgentJobProof, EmployeeIntakeProof, StepLadder, LadderStep, LadderProof, AgentJobLadder, EmployeeIntakeLadder } from './step-ladder';
/** Lot F: `scripts/seedConfig` writes the shipped flows through this — byte-equal keeps the version, a change bumps it and keeps the `flows.<key>:v<N>` snapshot. */
export { seedAppConfig } from './app-config.service';
/** The wizard vocabulary, for `scripts/seedConfig` to check the listing flow against before writing it; `canonicalJson` is how it tells "unchanged" from a jsonb column that reorders keys. */
export { canonicalJson, wizardFlowSchema } from './flow-schema';
export {
  KYC_CAPTURE_COLUMNS,
  REQUIRED_KYC_COLUMNS,
  onboardingTemplateSchema,
  templateIssues,
} from './onboarding-template';
export type { KycCaptureColumn, OnboardingStepDef, OnboardingTemplate, OnboardingTile } from './onboarding-template';

/**
 * Lot A (Q31): the platform settings row. `getPlatformSettings()` is what
 * every other module reads — the KYC SLA, the auto-publish switch, the
 * marketplace floors — cached a minute and invalidated by the PUT.
 */
export { DEFAULT_PLATFORM_SETTINGS, getPlatformSettings } from './platform-settings';
export type { PlatformSettings, SupportPriority, LiveChatSettings, AdminTwoFactorPolicy } from './platform-settings';
/**
 * Lot J2: the subscription purchase rules, one policy per audience.
 * `revenue` reads `publisher`, `packages` reads `advertiser`; `payments`
 * asks the payer's audience which gateways it may offer.
 */
export { getSubscriptionPolicy, PAYMENT_GATEWAYS, SUBSCRIPTION_CYCLES, SUBSCRIPTION_CHANGE_POLICIES } from './platform-settings';
export type { SubscriptionPolicy, SubscriptionAudience, SubscriptionCycle, SubscriptionChangePolicy } from './platform-settings';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
