import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { sectionOverviewQuerySchema, sectionParamSchema } from './section-overviews.schema';
import { sectionOverview } from './section-overviews.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// GET /section-overviews/:section?from&to&city — one overview read per user section, cached a minute.
export async function sectionOverviewHandler(req: Request, res: Response): Promise<void> {
  const params = sectionParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error);
  const query = sectionOverviewQuerySchema.safeParse(req.query);
  if (!query.success) throw invalid(query.error);
  res.json({ success: true, data: await sectionOverview(params.data.section, query.data) });
}
