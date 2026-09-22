import { app } from './app';
import { env } from './config/env';
import { logger } from './shared/logging';
import { prisma } from './shared/database';
import { redis } from './shared/cache';
import { registerGracefulShutdown } from './bootstrap/graceful-shutdown';
import { startPublisherTimerJob, publisherTimerInterval } from './jobs/publisher-timer.job';
import { startRightsRenewalJob, rightsRenewalInterval } from './jobs/rights-renewal.job';
import { startAgentDocumentExpiryJob, agentDocumentExpiryInterval } from './jobs/agent-document-expiry.job';
import { startAgentTimerJob, agentTimerInterval } from './jobs/agent-timer.job';
import { startEventScraperJob, eventScraperInterval } from './jobs/event-scraper.job';
import {
  startCampaignLifecycleJob,
  campaignLifecycleInterval,
} from './jobs/campaign-lifecycle.job';
import {
  startEarningsAccrualJob,
  earningsAccrualInterval,
} from './jobs/earnings-accrual.job';
import {
  startMonthlyStatementsJob,
  monthlyStatementsInterval,
} from './jobs/monthly-statements.job';
import { startKycProviderProbeJob, kycProviderProbeInterval } from './jobs/kyc-provider-probe.job';
import { startKycPurgeJob, kycPurgeInterval } from './jobs/kyc-purge.job';
import { startKycEscalationJob, kycEscalationInterval } from './jobs/kyc-escalation.job';
import { startWorkDueJob, workDueInterval } from './jobs/work-due.job';
import { startFraudSignalScanJob, fraudSignalScanInterval } from './jobs/fraud-signal-scan.job';
import { startNotificationSenderJob, notificationSenderInterval } from './jobs/notification-sender.job';
import { startAnnouncementSenderJob, announcementSenderInterval } from './jobs/announcement-sender.job';
import { startRetentionJob, retentionInterval } from './jobs/retention.job';
import { startRestoreDrillJob, restoreDrillInterval } from './jobs/restore-drill.job';
import { startDataExportJob, dataExportInterval } from './jobs/data-export.job';
import { startHealthSampleJob, healthSampleInterval } from './jobs/health-sample.job';
import { startReportScheduleJob, reportScheduleInterval } from './jobs/report-schedule.job';
import { startPayoutBatchDraftJob, payoutBatchDraftInterval } from './jobs/payout-batch-draft.job';
import { startPrintQuoteExpiryJob, printQuoteExpiryInterval } from './jobs/print-quote-expiry.job';
import { esignExpiryInterval, startEsignExpiryJob } from './jobs/esign-expiry.job';
import { agentTrailRetentionInterval, startAgentTrailRetentionJob } from './jobs/agent-trail-retention.job';
import { leadScoringInterval, startLeadScoringJob } from './jobs/lead-scoring.job';
import { leadPipelineInterval, startLeadPipelineJob } from './jobs/lead-pipeline.job';
import { leadClaimSweepInterval, startLeadClaimSweepJob } from './jobs/lead-claim-sweep.job';
import { leadOutreachTickInterval, startLeadOutreachTickJob } from './jobs/lead-outreach-tick.job';
import { leadIntegrityInterval, startLeadIntegrityJob } from './jobs/lead-integrity.job';
import { startLiveChatSlaJob, liveChatSlaInterval } from './jobs/live-chat-sla.job';
import { startPublisherSubscriptionJob, publisherSubscriptionInterval } from './jobs/publisher-subscription.job';
import { startPackageRenewalJob, packageRenewalInterval } from './jobs/package-renewal.job';
import { startCityWindDownJob, cityWindDownInterval } from './jobs/city-winddown.job';

/**
 * Opens the Postgres and Redis connections before the first user needs them.
 *
 * Both pools connect lazily, so without this the first request after a boot
 * paid the whole setup cost itself: measured ~890ms for the Postgres
 * connect + TLS handshake and ~235ms for Redis, which is most of the
 * difference between a ~3.1s first login and a ~0.46s steady-state one. On a
 * host that spins containers down when idle, that first request is a real
 * user's login every time.
 *
 * Deliberately fired after listen() and never awaited: the port must be bound
 * immediately so platform health checks pass, and a warm-up failure is not a
 * reason to refuse traffic — the same query will simply be retried by the
 * first request that needs it.
 */
function warmConnections(): void {
  // Concurrently, on purpose. `min` on the pool only stops idle connections
  // being reaped — it never opens them. Sequential warm-up queries would reuse
  // the same single connection and leave the floor empty, so the first request
  // that fans out (any Promise.all in a repository) would still pay a cold
  // connect. Firing POOL_FLOOR at once forces that many to be established.
  const POOL_FLOOR = 4;
  void Promise.all(
    Array.from({ length: POOL_FLOOR }, () => prisma.$queryRaw`SELECT 1`),
  )
    .then(() => logger.info('Postgres pool warmed', { connections: POOL_FLOOR }))
    .catch((err: unknown) => logger.warn('Postgres warm-up failed', { reason: String(err) }));

  void redis
    .ping()
    .then(() => logger.info('Redis connection warmed'))
    .catch((err: unknown) => logger.warn('Redis warm-up failed', { reason: String(err) }));
}

const server = app.listen(env.PORT, () => {
  logger.info('ADX backend running', { port: env.PORT, env: env.NODE_ENV });
  warmConnections();
  startPublisherTimerJob();
  startRightsRenewalJob();
  startAgentDocumentExpiryJob();
  startAgentTimerJob();
  startEventScraperJob();
  startCampaignLifecycleJob();
  // Publishers are paid as their campaigns run, so this is what makes a live
  // campaign turn into a balance.
  startEarningsAccrualJob();
  // Lot B (Q13): on the first of the month, every publisher's payment advice
  // for the month just ended.
  startMonthlyStatementsJob();
  // Lot D (Q129): the Digio probe moves the provider switch on failure and back.
  startKycProviderProbeJob();
  // Lot D (Q127): Digio-path KYC images and liveness videos, purged 30 days after verification.
  startKycPurgeJob();
  // Lot G (Q127/142): PENDING KYC cases older than N× the review SLA, escalated to Compliance, daily.
  startKycEscalationJob();
  // Lot G (Q118/138): every party through the fraud signals; a hot signal opens a SIGNAL_SCAN case, daily.
  startFraudSignalScanJob();
  // Lot E (decisions 95/126): past-due erasure requests and the retention-due report, daily.
  startRetentionJob();
  // Lot E (decision 95): the newest dump restored into the scratch database and its ledger verified, monthly.
  startRestoreDrillJob();
  // Lot E (Q87/Q147): every queued email and SMS, three attempts, and the nightly purge of the delivery log.
  startNotificationSenderJob();
  // Lot E (Q64/Q130): scheduled and running announcements, fanned out in batches of 500.
  startAnnouncementSenderJob();
  // G6 (Q104): every pending data export, built into its zip and the person told.
  startDataExportJob();
  // Lot G (Q130): one HealthSample per service every five minutes, thirty days kept.
  startHealthSampleJob();
  // Lot G (Q129/Q143): scheduled reports, rendered and mailed as time-limited links.
  startReportScheduleJob();
  // Lot G (Q124): one DRAFT payout batch on the weekly cadence, as the system user; people approve and release.
  startPayoutBatchDraftJob();
  // Lot H (Q147): OPEN print quote requests past their deadline — re-invited once, then expired.
  startPrintQuoteExpiryJob();
  startEsignExpiryJob();
  startAgentTrailRetentionJob();
  startLeadScoringJob();
  startLeadPipelineJob();
  // LH5 (D3): the hourly claim sweep.
  startLeadClaimSweepJob();
  // LH6 (D5): the outreach tick — queued sends, sequence steps, the recording purge.
  startLeadOutreachTickJob();
  // LH10: the integrity scan, the clawback watch and the daily QA draw.
  startLeadIntegrityJob();
  // Lot I: live chats past the first-response target, and idle ones nobody picked up.
  startLiveChatSlaJob();
  // Lot J (B1): the daily publisher-subscription sweep.
  startPublisherSubscriptionJob();
  // Lot J2 (6): the daily package-renewal sweep — the advertiser twin.
  startPackageRenewalJob();
  // Lot V: a city ops withdrew from — its live listings down, its open leads closed, its people told, within the hour.
  startCityWindDownJob();
  // Lot AA: at 08:00 IST, the assignees of every task due tomorrow or overdue are told, once per task per day.
  startWorkDueJob();
});

// Without this handler, a port conflict (e.g. a leftover dev server still
// holding the port) throws as an uncaught exception and kills the process
// silently — new requests then get served by the stale process instead,
// so nothing ever appears in this terminal again. Fail loudly instead.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${env.PORT} is already in use — another server instance is still running. ` +
        `Stop it (check for a leftover node/tsx process) before starting a new one.`,
      { port: env.PORT },
    );
  } else {
    logger.error('Server failed to start', { err });
  }
  process.exit(1);
});

registerGracefulShutdown(server, () => {
  if (publisherTimerInterval) clearInterval(publisherTimerInterval);
  if (rightsRenewalInterval) clearInterval(rightsRenewalInterval);
  if (agentDocumentExpiryInterval) clearInterval(agentDocumentExpiryInterval);
  if (agentTimerInterval) clearInterval(agentTimerInterval);
  if (eventScraperInterval) clearInterval(eventScraperInterval);
  if (campaignLifecycleInterval) clearInterval(campaignLifecycleInterval);
  if (earningsAccrualInterval) clearInterval(earningsAccrualInterval);
  if (monthlyStatementsInterval) clearInterval(monthlyStatementsInterval);
  if (kycProviderProbeInterval) clearInterval(kycProviderProbeInterval);
  if (kycPurgeInterval) clearInterval(kycPurgeInterval);
  if (kycEscalationInterval) clearInterval(kycEscalationInterval);
  if (workDueInterval) clearInterval(workDueInterval);
  if (fraudSignalScanInterval) clearInterval(fraudSignalScanInterval);
  if (notificationSenderInterval) clearInterval(notificationSenderInterval);
  if (announcementSenderInterval) clearInterval(announcementSenderInterval);
  if (retentionInterval) clearInterval(retentionInterval);
  if (restoreDrillInterval) clearInterval(restoreDrillInterval);
  if (dataExportInterval) clearInterval(dataExportInterval);
  if (healthSampleInterval) clearInterval(healthSampleInterval);
  if (reportScheduleInterval) clearInterval(reportScheduleInterval);
  if (payoutBatchDraftInterval) clearInterval(payoutBatchDraftInterval);
  if (printQuoteExpiryInterval) clearInterval(printQuoteExpiryInterval);
  if (esignExpiryInterval) clearInterval(esignExpiryInterval);
  if (agentTrailRetentionInterval) clearInterval(agentTrailRetentionInterval);
  if (leadScoringInterval) clearInterval(leadScoringInterval);
  if (leadPipelineInterval) clearInterval(leadPipelineInterval);
  if (leadClaimSweepInterval) clearInterval(leadClaimSweepInterval);
  if (leadOutreachTickInterval) clearInterval(leadOutreachTickInterval);
  if (leadIntegrityInterval) clearInterval(leadIntegrityInterval);
  if (liveChatSlaInterval) clearInterval(liveChatSlaInterval);
  if (publisherSubscriptionInterval) clearInterval(publisherSubscriptionInterval);
  if (packageRenewalInterval) clearInterval(packageRenewalInterval);
  if (cityWindDownInterval) clearInterval(cityWindDownInterval);
});
