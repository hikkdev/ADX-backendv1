import fs from 'node:fs';
import type { Request } from 'express';
import sharp from 'sharp';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { storeUpload, type IncomingFile } from '../uploads';
import { prismaMediaRepository as repository } from './prisma-media.repository';
import {
  MEDIA_FORMATS,
  MEDIA_SPECS,
  checkAgainstSpec,
  specFor,
  type MediaAsset,
  type MediaFilter,
  type MediaPatch,
  type MediaSpec,
  type MediaSpecKey,
} from './media.types';

/**
 * LM-1: the media library — every picture a layout block, a tile or a paid
 * placement draws, with the words that go with it.
 *
 * A picture is stored once, through the uploads door (purpose MEDIA, a
 * public file), and described here: its size, the spec it was checked
 * against, its alt text. It is never edited — a different picture is a new
 * asset — and never deleted, only archived, because a layout version in the
 * history still names it; a picture a PUBLISHED layout draws cannot even be
 * archived, so what people see never loses its image under them.
 */

type Actor = { userId: string; req?: Request | undefined };

export type MediaView = MediaAsset & { archived: boolean };
const view = (asset: MediaAsset): MediaView => ({ ...asset, archived: asset.archivedAt !== null });

export const listSpecs = (): readonly MediaSpec[] => MEDIA_SPECS;

export async function listMedia(filter: MediaFilter): Promise<MediaView[]> {
  return (await repository.list(filter)).map(view);
}

export async function getMedia(id: string): Promise<MediaView> {
  const asset = await repository.findById(id);
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'No such picture in the library');
  return view(asset);
}

/** For `layouts` (and anything else that draws): the assets behind a set of ids, archived ones included — the caller decides. */
export async function findMediaByIds(ids: readonly string[]): Promise<MediaAsset[]> {
  return repository.findByIds([...new Set(ids)]);
}

/**
 * The pixel size of an image on disk, the way a viewer shows it: an EXIF
 * orientation of 5–8 is a quarter turn, so the stored width and height swap.
 */
export async function readImageSize(path: string): Promise<{ width: number; height: number; format: string | null }> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(path).metadata();
  } catch {
    throw new ApiError(400, 'INVALID_IMAGE', 'That file could not be read as an image');
  }
  if (!meta.width || !meta.height) throw new ApiError(400, 'INVALID_IMAGE', 'That file could not be read as an image');
  const turned = (meta.orientation ?? 1) >= 5;
  return { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height, format: meta.format ?? null };
}

export type StoreMediaInput = {
  spec?: MediaSpecKey | undefined;
  altText?: string | undefined;
  title?: string | undefined;
  tags?: string[] | undefined;
  /** A buyer's artwork for their own ad (promotions); null for ADX's own library. */
  ownerAdvertiserId?: string | null | undefined;
};

/**
 * Checks a multipart file against its spec, stores it through the uploads
 * door and records it in the library. Refused before anything is stored:
 * the temp file is removed and nothing is written. Exported for
 * `promotions`, whose buyer uploads ad artwork into the same library.
 */
export async function storeMediaFile(
  file: IncomingFile,
  input: StoreMediaInput,
  actor: Actor & { isAdmin: boolean; baseUrl: string },
): Promise<MediaView> {
  const drop = () => fs.promises.unlink(file.path).catch(() => undefined);
  try {
    if (!(MEDIA_FORMATS as readonly string[]).includes(file.mimetype)) {
      throw new ApiError(400, 'INVALID_IMAGE', 'The library takes JPEG, PNG or WebP pictures');
    }
    const size = await readImageSize(file.path);
    const target = specFor(input.spec);
    if (target) {
      const verdict = checkAgainstSpec({ width: size.width, height: size.height, bytes: file.size, mime: file.mimetype }, target);
      if (!verdict.ok) {
        throw new ApiError(400, 'INVALID_IMAGE', verdict.problems[0]!, {
          spec: target.key,
          problems: verdict.problems,
          width: size.width,
          height: size.height,
          bytes: file.size,
          expected: { width: target.width, height: target.height, minWidth: target.minWidth, minHeight: target.minHeight, maxBytes: target.maxBytes },
        });
      }
    }
    const stored = await storeUpload(actor.userId, file, 'MEDIA', actor.baseUrl, { isAdmin: actor.isAdmin });
    const asset = await repository.create({
      fileId: stored.id,
      url: stored.url,
      mime: file.mimetype,
      width: size.width,
      height: size.height,
      bytes: file.size,
      altText: input.altText?.trim() || null,
      title: input.title?.trim() || file.originalname.replace(/\.[^.]+$/, '').slice(0, 120) || null,
      tags: input.tags ?? [],
      spec: target?.key ?? null,
      ownerAdvertiserId: input.ownerAdvertiserId ?? null,
      createdByUserId: actor.userId,
    });
    await logActivity(actor.userId, 'MEDIA_UPLOADED', {
      req: actor.req,
      targetType: 'MediaAsset',
      targetId: asset.id,
      module: 'media',
      metadata: { spec: asset.spec, width: asset.width, height: asset.height, bytes: asset.bytes, ownerAdvertiserId: asset.ownerAdvertiserId },
    });
    return view(asset);
  } catch (err) {
    await drop();
    throw err;
  }
}

export async function patchMedia(id: string, patch: MediaPatch, actor: Actor): Promise<MediaView> {
  const asset = await repository.findById(id);
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'No such picture in the library');
  const clean: MediaPatch = {};
  if (patch.altText !== undefined) clean.altText = patch.altText?.trim() || null;
  if (patch.title !== undefined) clean.title = patch.title?.trim() || null;
  if (patch.tags !== undefined) clean.tags = patch.tags;
  const updated = await repository.update(id, clean);
  await logActivity(actor.userId, 'MEDIA_EDITED', {
    req: actor.req,
    targetType: 'MediaAsset',
    targetId: id,
    module: 'media',
    metadata: { fields: Object.keys(clean) },
  });
  return view(updated);
}

/**
 * Archived pictures leave the picker. One a published layout draws is
 * refused, with where it is drawn. An advertiser's ad artwork (28 Sep 2026)
 * is refused while a booking that shows it is still open — a draft, waiting
 * for money or review, scheduled or live — because the ad would lose its
 * picture under the buyer; once the booking ends, is rejected or cancelled
 * it may go.
 */
export async function archiveMedia(id: string, actor: Actor): Promise<MediaView> {
  const asset = await repository.findById(id);
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'No such picture in the library');
  if (asset.archivedAt) return view(asset);
  if (asset.ownerAdvertiserId) {
    const open = await repository.openAdBookings(id);
    if (open.length > 0) {
      const booking = open[0]!;
      throw new ApiError(
        409,
        'AD_ARTWORK_IN_USE',
        `This is an advertiser's ad artwork on booking ${booking.displayId ?? booking.id}, which is still open — it can be archived once the booking ends, is rejected or cancelled.`,
        { reason: 'AD_ARTWORK_IN_USE', ownerAdvertiserId: asset.ownerAdvertiserId, bookings: open },
      );
    }
  }
  const usedIn = await repository.publishedUsage(id);
  if (usedIn.length > 0) {
    const surfaces = [...new Set(usedIn.map((use) => use.surface))];
    throw new ApiError(409, 'CONFLICT', `This picture is on a published layout (${surfaces.join(', ')}). Take it off the layout and publish first.`, {
      reason: 'MEDIA_IN_USE',
      surfaces,
      usedIn,
    });
  }
  const archived = await repository.setArchived(id, new Date());
  await logActivity(actor.userId, 'MEDIA_ARCHIVED', { req: actor.req, targetType: 'MediaAsset', targetId: id, module: 'media' });
  return view(archived);
}

export async function restoreMedia(id: string, actor: Actor): Promise<MediaView> {
  const asset = await repository.findById(id);
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'No such picture in the library');
  if (!asset.archivedAt) return view(asset);
  const restored = await repository.setArchived(id, null);
  await logActivity(actor.userId, 'MEDIA_RESTORED', { req: actor.req, targetType: 'MediaAsset', targetId: id, module: 'media' });
  return view(restored);
}
