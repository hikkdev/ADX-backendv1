import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import {
  createModuleSchema,
  createTrainingResourceSchema,
  patchModuleSchema,
  progressSchema,
  putQuestionsSchema,
  revokeCertificationSchema,
  submitQuizSchema,
} from './training.schema';
import {
  createModule,
  createTrainingResource,
  getCertification,
  getCurriculum,
  getModule,
  getModuleForAdmin,
  getQuiz,
  getTrainingResources,
  listCertifications,
  listModules,
  patchModule,
  putQuestions,
  reportProgress,
  revokeCertification,
  submitQuiz,
} from './training.service';

const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  return parsed.data as T;
};

/* The library, unchanged. */

export async function getTrainingHandler(req: Request, res: Response): Promise<void> {
  const resources = await getTrainingResources({
    category: req.query['category'] as string | undefined,
    search: req.query['search'] as string | undefined,
  });
  res.json({ success: true, data: resources });
}

export async function createTrainingHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof createTrainingResourceSchema.parse>>(createTrainingResourceSchema, req.body);
  res.status(201).json({ success: true, data: await createTrainingResource(input) });
}

/* The curriculum. */

export async function getCurriculumHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getCurriculum(req.user!.sub) });
}

export async function getModuleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getModule(req.user!.sub, req.params['moduleId'] as string) });
}

export async function progressHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof progressSchema.parse>>(progressSchema, req.body);
  res.json({ success: true, data: await reportProgress(req.user!.sub, req.params['moduleId'] as string, input) });
}

export async function getQuizHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getQuiz(req.user!.sub, req.params['moduleId'] as string) });
}

export async function submitQuizHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof submitQuizSchema.parse>>(submitQuizSchema, req.body);
  res.status(201).json({ success: true, data: await submitQuiz(req.user!.sub, req.params['moduleId'] as string, input.answers) });
}

export async function getCertificationHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getCertification(req.user!.sub) });
}

/* ADMIN. */

export async function listModulesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listModules() });
}

export async function getModuleAdminHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getModuleForAdmin(req.params['moduleId'] as string) });
}

export async function createModuleHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof createModuleSchema.parse>>(createModuleSchema, req.body);
  res.status(201).json({ success: true, data: await createModule(input) });
}

export async function patchModuleHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof patchModuleSchema.parse>>(patchModuleSchema, req.body);
  res.json({ success: true, data: await patchModule(req.params['moduleId'] as string, input) });
}

export async function putQuestionsHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof putQuestionsSchema.parse>>(putQuestionsSchema, req.body);
  res.json({ success: true, data: await putQuestions(req.params['moduleId'] as string, input) });
}

export async function listCertificationsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listCertifications() });
}

export async function revokeCertificationHandler(req: Request, res: Response): Promise<void> {
  const input = parse<ReturnType<typeof revokeCertificationSchema.parse>>(revokeCertificationSchema, req.body);
  res.json({ success: true, data: await revokeCertification(req.params['certificationId'] as string, input.reason, req.user!.sub) });
}
