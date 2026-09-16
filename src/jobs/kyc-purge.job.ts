import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { purgeCutoff, purgeVerifiedAdvertiserImages, purgeVerifiedLivenessVideos } from '../modules/kyc';
import { purgeVerifiedPublisherImages } from '../modules/publishers';
import { purgeVerifiedPrintPartnerImages } from '../modules/print-partners';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'kycPurgeJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:kyc-purge-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:kyc-purge:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let kycPurgeInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The KYC image purge — Lot D (Q127), daily.
 *
 * Thirty days after Digio verified a publisher, an advertiser or (Lot N) a
 * print partner, the images
 * on the record go: the private files are removed, the URL columns nulled,
 * the PAN masked to its last four, the Digio payload trimmed to the decision,
 * `imagesPurgedAt` stamped, and KYC_IMAGES_PURGED written against the party.
 * The Digio request and reference ids, status and verified-at stay — that
 * is the proof. Manual-path records are never touched by this job: those
 * images live in private storage until the account closes and its retention
 * runs. Liveness videos go thirty days after their own VERIFIED, keeping
 * when they were recorded, by whom, and what the reviewer said.
 *
 * Runs on an hourly interval rather than a cron so a process that started at
 * noon still catches the day; the day lock is what makes it once.
 */
export async function kycPurgeTick(now = new Date()): Promise<void> {
  recordHeartbeat('kyc-purge', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;

    // E6: the system account, the first admin only as a stand-in.
    const actor = (await systemUserId()) ?? (await listAdminUserIds())[0];
    if (!actor) {
      logger.warn('KYC purge skipped: no system or admin user to attribute the audit rows to', { tag: TAG });
      return;
    }

    const cutoff = purgeCutoff(now);
    // Lot N: the print partner's Digio-path record goes the same way.
    const [publishers, advertisers, printPartners, videos] = await Promise.all([
      purgeVerifiedPublisherImages(cutoff, actor),
      purgeVerifiedAdvertiserImages(cutoff, actor),
      purgeVerifiedPrintPartnerImages(cutoff, actor),
      purgeVerifiedLivenessVideos(cutoff),
    ]);
    logger.info('KYC images purged', {
      tag: TAG,
      cutoff,
      publishers: publishers.length,
      advertisers: advertisers.length,
      printPartners: printPartners.length,
      videos: videos.length,
    });
  } catch (err) {
    logger.error('kycPurgeJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startKycPurgeJob(): void {
  kycPurgeInterval = setInterval(() => void kycPurgeTick(), INTERVAL_MS);
}
