import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { pageQueryFrom } from '../../shared/pagination';
import {
  activateTemplate,
  createTemplate,
  currentTemplate,
  deleteTemplate,
  getTemplate,
  listAcceptances,
  listTemplates,
  partyAgreements,
  searchParties,
  staleParties,
  updateTemplate,
} from './agreements.service';
import {
  acceptanceFilterSchema,
  activateTemplateSchema,
  agreementKindSchema,
  createTemplateSchema,
  partyTypeSchema,
  staleQuerySchema,
  updateTemplateSchema,
} from './agreements.schema';

/** Every handler validates the same way: parse, or 400 with the flattened error. */
function parse<T>(
  schema: {
    safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error?.flatten());
  }
  return result.data as T;
}

const actor = (req: Request): string => {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return sub;
};

const param = (req: Request, name: string): string => req.params[name] as string;

/* Live text --------------------------------------------------------- */

export async function currentTemplateHandler(req: Request, res: Response): Promise<void> {
  const kind = parse(agreementKindSchema, param(req, 'kind'));
  res.json({ success: true, data: await currentTemplate(kind) });
}

/* Templates --------------------------------------------------------- */

export async function listTemplatesHandler(req: Request, res: Response): Promise<void> {
  const kind =
    req.query['kind'] === undefined ? undefined : parse(agreementKindSchema, req.query['kind']);
  res.json({ success: true, data: await listTemplates(kind) });
}

export async function getTemplateHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getTemplate(param(req, 'id')) });
}

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createTemplateSchema, req.body);
  const template = await createTemplate({ ...body, createdByUserId: actor(req) });
  res.status(201).json({ success: true, data: template });
}

export async function updateTemplateHandler(req: Request, res: Response): Promise<void> {
  const patch = parse(updateTemplateSchema, req.body);
  res.json({ success: true, data: await updateTemplate(param(req, 'id'), patch) });
}

export async function deleteTemplateHandler(req: Request, res: Response): Promise<void> {
  await deleteTemplate(param(req, 'id'));
  res.status(204).end();
}

export async function activateTemplateHandler(req: Request, res: Response): Promise<void> {
  // E7-3: an optional `{ requiresReacceptance }` body, applied with the activation.
  const body = parse(activateTemplateSchema, req.body ?? {});
  res.json({ success: true, data: await activateTemplate(param(req, 'id'), body) });
}

/* Acceptances and parties ------------------------------------------- */

export async function listAcceptancesHandler(req: Request, res: Response): Promise<void> {
  const filter = parse(acceptanceFilterSchema, req.query);
  res.json({ success: true, data: await listAcceptances(filter, pageQueryFrom(req.query)) });
}

/** Lot D (Q55): who is behind the live platform terms, and whether that blocks them. */
export async function staleHandler(req: Request, res: Response): Promise<void> {
  const { kind } = parse(staleQuerySchema, req.query);
  res.json({ success: true, data: await staleParties(kind) });
}

export async function searchPartiesHandler(req: Request, res: Response): Promise<void> {
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
  res.json({ success: true, data: await searchParties(q) });
}

export async function partyAgreementsHandler(req: Request, res: Response): Promise<void> {
  const type = parse(partyTypeSchema, param(req, 'partyType'));
  res.json({ success: true, data: await partyAgreements(type, param(req, 'partyId')) });
}
