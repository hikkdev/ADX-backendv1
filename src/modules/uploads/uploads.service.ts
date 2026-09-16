import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import type { UploadedFile } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { deleteStoredFile, openPrivateFile, uploadFile } from '../../shared/storage';
import { prismaUploadsRepository as repository } from './prisma-uploads.repository';
import { agentMayViewFile, disputePartyMayViewFile, supportPartyMayViewFile } from './file-access.port';
import { KYC_PURPOSES, PURPOSE_FOLDER, isPrivatePurpose, type UploadPurpose } from './uploads.schema';

export type IncomingFile = {
  /** Temp path multer wrote to. Always removed, success or failure. */
  path: string;
  /** Generated name, used as the stored object key. */
  filename: string;
  /** Name the client sent, kept for display. */
  originalname: string;
  mimetype: string;
  size: number;
};

/** The one URL a private file ever has: this API, by id. */
export function privateFileUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/api/v1/files/${id}`;
}

/**
 * Lot F: who may file a document AS somebody else. `ownerUserId` names the
 * party the document belongs to; the hand that carried it is the uploader.
 * An ADMIN may, and so may the party's agent — but only under a live
 * PROFILE grant on that party, the same authority every on-behalf write
 * asks for (`assertMayActFor` WRITE / `assertAgentMayWrite`). The question
 * is the port's: a live grant is what it answers. Anyone else naming an
 * owner is refused with 403, so a stranger cannot plant a file in a party's
 * KYC.
 */
export async function assertMayUploadFor(uploader: FileViewer, ownerUserId: string | null | undefined): Promise<void> {
  if (!ownerUserId || ownerUserId === uploader.userId || uploader.isAdmin) return;
  if (await agentMayViewFile(uploader.userId, ownerUserId)) return;
  throw new ApiError(403, 'FORBIDDEN', 'You cannot upload a document on behalf of that account without a live grant', {
    ownerUserId,
  });
}

/**
 * Hands the temp file to the configured storage provider, then records it.
 *
 * The temp file is removed in a finally block: leaving it behind on a failed
 * upload would slowly fill the uploads/tmp directory. Deletion failure is
 * non-fatal and deliberately swallowed.
 *
 * Lot D (Q61): a private purpose is stored out of public reach and recorded
 * with a `/files/:id` URL instead — the id is minted here so the URL can
 * name the row it is about to create. `ownerUserId` is the party the
 * document belongs to when the uploader is somebody else.
 */
export async function storeUpload(
  userId: string,
  file: IncomingFile,
  purpose: UploadPurpose,
  baseUrl: string,
  options: { ownerUserId?: string | null; isAdmin?: boolean } = {},
) {
  await assertMayUploadFor({ userId, isAdmin: options.isAdmin ?? false }, options.ownerUserId);
  const isPrivate = isPrivatePurpose(purpose);
  const id = randomUUID().replace(/-/g, '');
  let url: string | null;
  let storageKey: string;
  try {
    const result = await uploadFile({
      filePath: file.path,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: PURPOSE_FOLDER[purpose] ?? 'misc',
      baseUrl,
      visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
    });
    url = result.url;
    storageKey = result.storageKey;
  } finally {
    fs.promises.unlink(file.path).catch(() => {});
  }

  return repository.record({
    id,
    userId,
    url: url ?? privateFileUrl(baseUrl, id),
    filename: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    purpose,
    visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
    ownerUserId: options.ownerUserId ?? null,
    storageKey,
  });
}

/**
 * Lot B (Q85): a file the platform generated — a payout batch's bank upload,
 * a statement kept as imported — stored and recorded like any upload, so a
 * batch can name its export by `UploadedFile.id`. Written to a temp file
 * first because the storage adapter takes a path, and removed the same way.
 *
 * Lot D: an INVOICE is a private purpose, so it lands behind `/files/:id`
 * like a document; pass `ownerUserId` so the party it was issued to can open it.
 */
export async function storeGeneratedFile(
  userId: string,
  input: {
    content: Buffer | string;
    filename: string;
    mimeType: string;
    purpose: UploadPurpose;
    baseUrl?: string;
    ownerUserId?: string | null;
  },
) {
  const tmp = path.join(os.tmpdir(), `adx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.promises.writeFile(tmp, input.content);
  const safeName = input.filename.replace(/[^\w.\-]+/g, '_');
  const objectName = `${Date.now()}-${safeName}`;
  const isPrivate = isPrivatePurpose(input.purpose);
  const id = randomUUID().replace(/-/g, '');
  let url: string | null;
  let storageKey: string;
  try {
    const result = await uploadFile({
      filePath: tmp,
      filename: objectName,
      mimeType: input.mimeType,
      folder: PURPOSE_FOLDER[input.purpose] ?? 'misc',
      baseUrl: input.baseUrl ?? '',
      visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
    });
    url = result.url;
    storageKey = result.storageKey;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
  const size = typeof input.content === 'string' ? Buffer.byteLength(input.content) : input.content.length;
  return repository.record({
    id,
    userId,
    url: url ?? privateFileUrl(input.baseUrl ?? '', id),
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: size,
    purpose: input.purpose,
    visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
    ownerUserId: input.ownerUserId ?? null,
    storageKey,
  });
}

/**
 * Lot B (Q13): the record behind a file id. `invoices` resolves the PDF it
 * rendered, and the file a publisher attached to their own invoice, through
 * this rather than by trusting a URL typed into a body.
 */
export const findUploadedFile = (id: string) => repository.findById(id);

/* ── Lot D (Q61): reading and removing a file by id ──────────────────────── */

export type FileViewer = { userId: string; isAdmin: boolean };

const ownerOf = (file: UploadedFile) => file.ownerUserId ?? file.userId;

/**
 * Who may open a private file: its owner, an admin, or the party's agent
 * under a live grant (answered through the port). A public file is open to
 * anyone signed in, as its URL already was. Lot F: a DISPUTE_EVIDENCE file
 * is also open to the other side of the case it sits on — the publisher,
 * advertiser or agent the dispute is between, or their agent under a grant
 * — because evidence filed against somebody is theirs to see. Lot I: a
 * SUPPORT_ATTACHMENT is open to the requester of the ticket it sits on.
 */
async function mayView(file: UploadedFile, viewer: FileViewer): Promise<boolean> {
  if (file.visibility !== 'PRIVATE') return true;
  if (viewer.isAdmin || ownerOf(file) === viewer.userId) return true;
  if (await agentMayViewFile(viewer.userId, ownerOf(file))) return true;
  if (file.purpose === 'DISPUTE_EVIDENCE') {
    // The file's own people: the case has to be one of theirs.
    return disputePartyMayViewFile(viewer.userId, file.id, [...new Set([ownerOf(file), file.userId])]);
  }
  // Lot I: a support attachment is open to the thread's other side — the
  // requester, when ADX attached it (the desk was admitted above).
  if (file.purpose === 'SUPPORT_ATTACHMENT') return supportPartyMayViewFile(viewer.userId, file.id);
  return false;
}

export type OpenedFile =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; path: string; mimeType: string; filename: string };

/**
 * GET /files/:id. A public file redirects to where it always lived; a
 * private one goes to a five-minute presigned read (R2) or a local stream.
 * Opening an identity document is itself recorded — FILE_VIEWED — so the
 * party's access record can say who looked.
 */
export async function openFile(id: string, viewer: FileViewer, req?: Request): Promise<OpenedFile> {
  const file = await repository.findById(id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'File not found');
  if (!(await mayView(file, viewer))) throw new ApiError(403, 'FORBIDDEN', 'You cannot open this file');

  if (file.visibility !== 'PRIVATE' || !file.storageKey) {
    return { kind: 'redirect', url: file.url };
  }

  if (KYC_PURPOSES.has(file.purpose)) {
    await logActivity(viewer.userId, 'FILE_VIEWED', {
      req,
      targetType: 'UploadedFile',
      targetId: file.id,
      module: 'uploads',
      metadata: { purpose: file.purpose, ownerUserId: ownerOf(file) },
    });
  }

  const opened = await openPrivateFile(file.storageKey, { filename: file.filename, mimeType: file.mimeType });
  if (opened.kind === 'redirect') return opened;
  return { kind: 'stream', path: opened.path, mimeType: file.mimeType, filename: file.filename };
}

/**
 * E6: the object behind a stored file for a module that has ALREADY decided
 * the caller may read it — `invoices` serving a PDF on a route that ran its
 * own ownership check. No viewer rule here, no FILE_VIEWED row (these are not
 * identity documents); the bytes come back as a local path or a presigned
 * read for the caller to stream. Never mount this behind a route of its own.
 */
export async function openStoredFile(id: string): Promise<OpenedFile | null> {
  const file = await repository.findById(id);
  if (!file) return null;
  if (file.visibility !== 'PRIVATE' || !file.storageKey) return { kind: 'redirect', url: file.url };
  const opened = await openPrivateFile(file.storageKey, { filename: file.filename, mimeType: file.mimeType });
  if (opened.kind === 'redirect') return opened;
  return { kind: 'stream', path: opened.path, mimeType: file.mimeType, filename: file.filename };
}

/** DELETE /files/:id — the owner or an admin; the object goes best-effort, the row for certain. */
export async function deleteFile(id: string, viewer: FileViewer, req?: Request): Promise<void> {
  const file = await repository.findById(id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'File not found');
  if (!viewer.isAdmin && ownerOf(file) !== viewer.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this file');
  }
  if (file.storageKey) await deleteStoredFile(file.storageKey);
  await repository.remove(id);
  await logActivity(viewer.userId, 'FILE_DELETED', {
    req,
    targetType: 'UploadedFile',
    targetId: file.id,
    module: 'uploads',
    metadata: { purpose: file.purpose, visibility: file.visibility, ownerUserId: ownerOf(file) },
  });
}

/* ── Lot D (Q127): what the purge jobs need ───────────────────────────────── */

/** The id inside a `/files/:id` URL, or null for a public URL from before Lot D. */
export function fileIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /\/files\/([A-Za-z0-9_-]+)(?:[?#]|$)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Removes a file outright — object and row — with no viewer to check,
 * because the caller is the retention job, not a person. Missing is fine:
 * a purge that runs twice must not fail the second time.
 */
export async function purgeStoredFile(id: string): Promise<boolean> {
  const file = await repository.findById(id);
  if (!file) return false;
  if (file.storageKey) await deleteStoredFile(file.storageKey);
  await repository.remove(id);
  return true;
}
