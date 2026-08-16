import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { APP_ENUMS } from '../constants/appEnums';

const FALLBACK_CONFIG = {
  enums: APP_ENUMS,
  flows: {},
};

export async function getConfigHandler(_req: Request, res: Response): Promise<void> {
  const row = await prisma.appConfig.findUnique({ where: { key: 'main' } });
  const data = row ? (row.value as object) : FALLBACK_CONFIG;
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data });
}

export async function putConfigHandler(req: Request, res: Response): Promise<void> {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    return;
  }
  if (typeof body.flows !== 'object' || Array.isArray(body.flows)) {
    res.status(400).json({ success: false, error: 'Missing required field: flows (object)' });
    return;
  }
  if (typeof body.enums !== 'object' || Array.isArray(body.enums)) {
    res.status(400).json({ success: false, error: 'Missing required field: enums (object)' });
    return;
  }
  const row = await prisma.appConfig.upsert({
    where: { key: 'main' },
    update: { value: body },
    create: { key: 'main', value: body },
  });
  res.json({ success: true, data: row.value });
}
