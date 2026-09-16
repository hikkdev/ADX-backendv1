import type { Request, Response } from 'express';
import { latestDataExport, requestDataExport } from './data-export.service';

/** POST /users/me/data-export — 201 with the PENDING request; 409 while one is open. */
export async function requestDataExportHandler(req: Request, res: Response): Promise<void> {
  const view = await requestDataExport(req.user!.sub, req);
  res.status(201).json({ success: true, data: view });
}

/** GET /users/me/data-export — the latest request, or `null` when there has never been one. */
export async function latestDataExportHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await latestDataExport(req.user!.sub) });
}
