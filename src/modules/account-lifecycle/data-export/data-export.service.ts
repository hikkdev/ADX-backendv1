import type { Request } from 'express';
import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { zipFiles } from '../../../shared/zip';
import type { DataExportRequest } from '../../../shared/database';
import { notify } from '../../notifications';
import { purgeStoredFile, storeGeneratedFile } from '../../uploads';
import { prismaDataExportRepository as repository } from './prisma-data-export.repository';
import type { AssembledExport } from './data-export.repository';

/**
 * The data export — G6 (Q104): a person asks for a copy of what ADX holds
 * about them and gets a zip a few minutes later.
 *
 * One open request at a time: a second ask while one is PENDING, or while
 * the last one is READY and not yet expired, is a 409 that names the open
 * one — the file is already there, or about to be. The job
 * (`jobs/data-export.job.ts`) assembles the records, writes
 * `adx-data-export.json` and a `README.txt` into a zip, stores it PRIVATE and
 * owned by the person (so only they — or an admin — can open `/files/:id`),
 * marks the request READY for seven days and tells them by email and push
 * with the deep link into the app. The retention sweep purges the file and
 * marks the row EXPIRED once the seven days are up; the row itself goes at
 * ninety.
 *
 * What the export leaves out is as deliberate as what it carries — see the
 * repository header: no images, no hashes, no other people's contact
 * details.
 */

export const DATA_EXPORT_TTL_DAYS = 7;
/** How long an EXPIRED or FAILED row stays readable on `GET /users/me/data-export` before it is deleted. */
export const DATA_EXPORT_ROW_RETENTION_DAYS = 90;
export const DATA_EXPORT_FILENAME = 'adx-data-export.zip';

const DAY_MS = 24 * 60 * 60 * 1000;

export type DataExportView = {
  id: string;
  status: DataExportRequest['status'];
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  /** The private file behind `/files/:id`, while the export is READY. */
  fileId: string | null;
  /** The in-app deep link the email carries; null until READY. */
  deepLink: string | null;
  error: string | null;
};

export const deepLinkFor = (requestId: string): string => `adx://account/data-export/${requestId}`;

export function toDataExportView(row: DataExportRequest): DataExportView {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    fileId: row.status === 'READY' ? row.fileId : null,
    deepLink: row.status === 'READY' ? deepLinkFor(row.id) : null,
    error: row.status === 'FAILED' ? row.error : null,
  };
}

/* ── the person's two calls ──────────────────────────────────────── */

/** POST /users/me/data-export — 201 with the new PENDING row; 409 while one is open. */
export async function requestDataExport(userId: string, req?: Request, now = new Date()): Promise<DataExportView> {
  const open = await repository.findOpen(userId, now);
  if (open) {
    throw new ApiError(409, 'CONFLICT', open.status === 'PENDING' ? 'Your data export is being prepared' : 'Your data export is ready to download', {
      code: 'DATA_EXPORT_OPEN',
      request: toDataExportView(open),
    });
  }
  const row = await repository.create(userId, now);
  await logActivity(userId, 'DATA_EXPORT_REQUESTED', { req, targetType: 'DataExportRequest', targetId: row.id, module: 'account-lifecycle' });
  return toDataExportView(row);
}

/** GET /users/me/data-export — the latest request, any status; null when there has never been one. */
export async function latestDataExport(userId: string): Promise<DataExportView | null> {
  const row = await repository.findLatest(userId);
  return row ? toDataExportView(row) : null;
}

/* ── the build ───────────────────────────────────────────────────── */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Sep 2026", Indian time — what the email prints as the expiry. */
export function formatExpiry(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

export function readmeFor(request: DataExportRequest, assembled: AssembledExport, expiresAt: Date): string {
  const count = (list: unknown[]) => String(list.length);
  return [
    'ADX — your data export',
    '======================',
    '',
    `Request ${request.id}, asked for on ${request.requestedAt.toISOString()} and prepared on ${new Date().toISOString()}.`,
    `This file is available to you until ${expiresAt.toISOString()} (${formatExpiry(expiresAt)}, Indian time) and is then deleted.`,
    '',
    'What is inside',
    '--------------',
    'adx-data-export.json — one JSON document with these sections:',
    '',
    '  profile        your account record (name, mobile, email, language, when it was created and last signed in)',
    '  roles          the roles your login holds',
    '  parties        your publisher, advertiser and agent records, where you have them',
    '  kyc            the status and decisions on your identity checks — the documents themselves are not included;',
    '                 you can open them in the app',
    `  listings       the spots you have listed (${count(assembled.listings)})`,
    `  orders         the bookings you placed as an advertiser and the bookings on your spots as a publisher (${count(assembled.orders)})`,
    `  campaigns      your campaigns (${count(assembled.campaigns)})`,
    `  wallets        each wallet with its full ledger of entries (${count(assembled.wallets)})`,
    `  withdrawals    every withdrawal you asked for (${count(assembled.withdrawals)})`,
    `  invoices       the tax invoices, proformas and credit notes issued to you — the figures, not the PDFs (${count(assembled.invoices)})`,
    `  notifications  every notice ADX sent you in the app (${count(assembled.notifications)})`,
    `  sessions       every sign-in session, with the device and address it came from (${count(assembled.sessions)})`,
    `  activity       what you did on ADX, as the activity log records it (${count(assembled.activity)})`,
    '  preferences    your notification and app preferences',
    '',
    'What is not inside',
    '------------------',
    'Identity document images and videos, password and session secrets, and the contact details of',
    'other people on shared records (a booking names the spot and the campaign, not the other party).',
    'Money is written as decimal strings in INR; times are ISO 8601 in UTC.',
    '',
    'Questions: raise a ticket from the app (Help & support) and quote the request id above.',
    '',
  ].join('\n');
}

/**
 * One request, start to finish. A failure marks the row FAILED with the
 * reason and rethrows nothing: the job logs it and moves on, and the person
 * can ask again.
 */
export async function buildDataExport(requestId: string, now = new Date()): Promise<DataExportRequest> {
  const request = await repository.findById(requestId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Data export request not found');
  if (request.status !== 'PENDING') return request;

  try {
    const assembled = await repository.assemble(request.userId);
    if (!assembled) throw new Error('The account behind this request no longer exists');

    const expiresAt = new Date(now.getTime() + DATA_EXPORT_TTL_DAYS * DAY_MS);
    const json = JSON.stringify({ exportedAt: now.toISOString(), requestId: request.id, ...assembled }, null, 2);
    const archive = zipFiles(
      [
        { name: 'adx-data-export.json', data: json, mtime: now },
        { name: 'README.txt', data: readmeFor(request, assembled, expiresAt), mtime: now },
      ],
      now,
    );
    const stored = await storeGeneratedFile(request.userId, {
      content: archive,
      filename: DATA_EXPORT_FILENAME,
      mimeType: 'application/zip',
      purpose: 'DATA_EXPORT',
      ownerUserId: request.userId,
    });
    const ready = await repository.markReady(request.id, { fileId: stored.id, readyAt: now, expiresAt });

    await logActivity(request.userId, 'DATA_EXPORT_READY', {
      targetType: 'DataExportRequest',
      targetId: request.id,
      module: 'account-lifecycle',
      metadata: { fileId: stored.id, sizeBytes: archive.length, expiresAt: expiresAt.toISOString() },
    });

    const name = typeof assembled.profile?.['name'] === 'string' && assembled.profile['name'] ? String(assembled.profile['name']) : 'there';
    await notify(
      'DATA_EXPORT_READY',
      request.userId,
      { name, url: deepLinkFor(request.id), expiresAt: formatExpiry(expiresAt) },
      {
        type: 'SYSTEM',
        inApp: {
          type: 'SYSTEM',
          title: 'Your data export is ready',
          subtitle: `Available until ${formatExpiry(expiresAt)}`,
          message: 'The copy of your ADX data you asked for is ready to download from Account > Your data.',
          suggestedAction: 'Download your data',
          relatedId: request.id,
        },
      },
    ).catch((err: unknown) => logger.warn('Data export ready, but the person could not be told', { requestId: request.id, reason: err instanceof Error ? err.message : String(err) }));

    return ready;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Data export failed', { requestId: request.id, reason });
    return repository.markFailed(request.id, reason);
  }
}

/** The job's tick: every PENDING request, oldest first. */
export async function processPendingDataExports(limit = 20, now = new Date()): Promise<{ picked: number; ready: number; failed: number }> {
  const pending = await repository.findPending(limit);
  const tally = { picked: pending.length, ready: 0, failed: 0 };
  for (const request of pending) {
    const after = await buildDataExport(request.id, now).catch((err: unknown) => {
      logger.error('Data export build threw', { requestId: request.id, reason: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (after?.status === 'READY') tally.ready += 1;
    else tally.failed += 1;
  }
  return tally;
}

/* ── retention ───────────────────────────────────────────────────── */

/**
 * For the daily retention sweep (`ops`): every READY export past its seven
 * days loses its file and becomes EXPIRED; EXPIRED and FAILED rows older
 * than ninety days are deleted. The only automatic destruction the sweep
 * does — and the one thing it destroys is a copy the person already has.
 */
export async function purgeExpiredDataExports(now = new Date()): Promise<{ expired: number; deleted: number }> {
  const expired = await repository.findExpired(now);
  for (const row of expired) {
    if (row.fileId) {
      await purgeStoredFile(row.fileId).catch((err: unknown) =>
        logger.warn('Expired data export file not removed', { requestId: row.id, fileId: row.fileId, reason: err instanceof Error ? err.message : String(err) }),
      );
    }
    await repository.markExpired(row.id);
  }
  const deleted = await repository.deleteFinishedBefore(new Date(now.getTime() - DATA_EXPORT_ROW_RETENTION_DAYS * DAY_MS));
  return { expired: expired.length, deleted };
}
