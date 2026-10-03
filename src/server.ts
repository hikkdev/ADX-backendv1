import { app } from './app';
import { env } from './config/env';
import { logger } from './shared/logging';
import { prisma } from './shared/database';
import { isRedisOutage, redis } from './shared/cache';
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
import { startWeeklySummaryJob, weeklySummaryInterval } from './jobs/weekly-summary.job';
import { startKycProviderProbeJob, kycProviderProbeInterval } from './jobs/kyc-provider-probe.job';
import { startKycPurgeJob, kycPurgeInterval } from './jobs/kyc-purge.job';
import { startKycEscalationJob, kycEscalationInterval } from './jobs/kyc-escalation.job';
import { startWorkDueJob, workDueInterval } from './jobs/work-due.job';
import { startFraudSignalScanJob, fraudSignalScanInterval } from './jobs/fraud-signal-scan.job';
import { startOrderRiskRescreenJob, orderRiskRescreenInterval } from './jobs/order-risk-rescreen.job';
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
import { startPromotionsJob, promotionsInterval } from './jobs/promotions.job';
import { startStorageSweepJob, storageSweepInterval } from './jobs/storage-sweep.job';
import { startVerificationStatusSweepJob, verificationStatusSweepInterval } from './jobs/verification-status-sweep.job';
import { startHolidayCalendarJob, holidayCalendarInterval } from './jobs/holiday-calendar.job';
import { errorThrottled } from './shared/logging/throttled';

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

/*
 * The one net for a Redis outage (26 Sep 2026): a background Redis call
 * nobody caught becomes an unhandled rejection, and Node ends the process on
 * one — so a stopped Redis container took the whole API down. A Redis
 * outage is logged and the server stays up (requests degrade, jobs skip
 * their ticks); ANY other unhandled rejection is re-thrown, and Node stops
 * the process exactly as it did before.
 */
process.on('unhandledRejection', (reason) => {
  if (isRedisOutage(reason)) {
    errorThrottled('Redis unavailable — a background call failed; the server stays up', { err: (reason as Error).message });
    return;
  }
  throw reason;
});

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
  // WS-1 (DR 12): every advertiser's campaign digest, Monday 09:00 IST.
  startWeeklySummaryJob();
  // Lot D (Q129): the Digio probe moves the provider switch on failure and back.
  startKycProviderProbeJob();
  // Lot D (Q127): Digio-path KYC images and liveness videos, purged 30 days after verification.
  startKycPurgeJob();
  // Lot G (Q127/142): PENDING KYC cases older than N× the review SLA, escalated to Compliance, daily.
  startKycEscalationJob();
  // Lot G (Q118/138): every party through the fraud signals; a hot signal opens a SIGNAL_SCAN case, daily.
  startFraudSignalScanJob();
  // Order fraud screening: every open order re-scored, daily; watch mode flags, never holds unless switched on.
  startOrderRiskRescreenJob();
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
  // LM-1: paid placements cross their dates — live, ended, the unpaid hour, the unreviewed ad refunded.
  startPromotionsJob();
  // ST-3: weekly — files nothing refers to are marked; removal only when Settings › Storage turns it on (off by default).
  startStorageSweepJob();
  // Cashfree Phase 1: pending verification attempts read back until they finish; overdue Cashfree sessions expired.
  startVerificationStatusSweepJob();
  // HC-1: weekly — the public holiday calendar read into the Holidays page, while Settings › Integrations has it on.
  startHolidayCalendarJob();
});

/**
 * A port conflict would otherwise throw as an uncaught exception and kill the
 * process silently, leaving the *stale* instance serving every request while
 * nothing more appeared in this terminal.
 *
 * Failing loudly is still the end of it, but not the first move. On a restart
 * the previous instance may hold the port for a moment: nodemon hard-kills its
 * child on Windows, so no graceful shutdown runs, and the operating system
 * releases the listener a beat after the process is gone. The replacement was
 * landing inside that beat, exiting 1, and nodemon printed "app crashed —
 * waiting for file changes" and stopped watching. Every backend edit looked
 * like a crash.
 *
 * So a bind that fails because the port is held is retried for a few seconds
 * first. Only a port held by something that is genuinely not going away ends
 * the process, which is the case the loud message was written for.
 */
const BIND_RETRY_MS = 400;
const BIND_RETRY_LIMIT = 30;
let bindAttempts = 0;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    bindAttempts += 1;
    if (bindAttempts <= BIND_RETRY_LIMIT) {
      /* Info, not error: on a dev restart this is the expected handover, and
         the `listening` callback above still fires when the retry lands. */
      logger.info(`Port ${env.PORT} is still held — waiting for the previous instance to release it`, {
        port: env.PORT,
        attempt: bindAttempts,
        of: BIND_RETRY_LIMIT,
      });
      setTimeout(() => server.listen(env.PORT), BIND_RETRY_MS).unref();
      return;
    }
    logger.error(
      `Port ${env.PORT} is already in use — another server instance is still running. ` +
        `Stop it (check for a leftover node/tsx process) before starting a new one.`,
      { port: env.PORT, waitedMs: BIND_RETRY_MS * BIND_RETRY_LIMIT },
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
  if (weeklySummaryInterval) clearInterval(weeklySummaryInterval);
  if (kycProviderProbeInterval) clearInterval(kycProviderProbeInterval);
  if (kycPurgeInterval) clearInterval(kycPurgeInterval);
  if (kycEscalationInterval) clearInterval(kycEscalationInterval);
  if (workDueInterval) clearInterval(workDueInterval);
  if (fraudSignalScanInterval) clearInterval(fraudSignalScanInterval);
  if (orderRiskRescreenInterval) clearInterval(orderRiskRescreenInterval);
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
  if (promotionsInterval) clearInterval(promotionsInterval);
  if (storageSweepInterval) clearInterval(storageSweepInterval);
  if (verificationStatusSweepInterval) clearInterval(verificationStatusSweepInterval);
  if (holidayCalendarInterval) clearInterval(holidayCalendarInterval);
});
