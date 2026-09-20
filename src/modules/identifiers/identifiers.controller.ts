import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import type { PartyType } from '../../shared/database';
import { backfillPublisherIdentifiers, backfillUserIdentifiers } from './identifiers.backfill';
import {
  getFormat,
  listFormats,
  previewIdentifier,
  updateFormat,
} from './identifiers.service';
import { partyTypeSchema, previewSchema, updateFormatSchema } from './identifiers.schema';

function party(req: Request): PartyType {
  const parsed = partyTypeSchema.safeParse(req.params['party']);
  if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', 'Unknown party type');
  return parsed.data;
}

export async function listFormatsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listFormats() });
}

export async function getFormatHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getFormat(party(req)) });
}

export async function updateFormatHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateFormatSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  res.json({ success: true, data: await updateFormat(party(req), parsed.data) });
}

/** Renders a candidate format without consuming a sequence number. */
export async function previewFormatHandler(req: Request, res: Response): Promise<void> {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const samples = [1, 2, 12].map((seq) => previewIdentifier(parsed.data, new Date(), seq));
  res.json({ success: true, data: { samples } });
}

export async function backfillHandler(_req: Request, res: Response): Promise<void> {
  // QR-4: people too — every account minted before the USER series existed.
  const publishers = await backfillPublisherIdentifiers();
  const users = await backfillUserIdentifiers();
  res.json({ success: true, data: { ...publishers, users } });
}
