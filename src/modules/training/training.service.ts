import type { AgentCertification, TrainingAttempt, TrainingModule } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import { allocateIdentifier } from '../identifiers';
import { prismaTrainingRepository as repository } from './prisma-training.repository';
import type { CertificationWithAgent, NewTrainingResource, QuestionWithOptions } from './training.repository';
import type { CreateModuleInput, PatchModuleInput, PutQuestionsInput } from './training.schema';
import {
  certificationProgress,
  moduleStateOf,
  nextPercent,
  scoreLine,
  scoreQuiz,
  PROGRESS_STEPS,
  type CertificationState,
  type ModuleState,
} from './training.rules';

/**
 * The curriculum (DR 05).
 *
 * `GET /training` — the flat library both apps read — is untouched and still
 * answered here. Everything under `/training/curriculum`, `/modules`,
 * `/certification` is new. Decision 12: there is no separate exam; every
 * module has a quiz, attempts are unlimited and the best one counts, a failed
 * quiz locks nothing, and the certificate is minted the moment the last
 * active module is passed. Decision 13: there is no PDF, because nothing in
 * the platform renders one; the certificate is a record with an identifier
 * the apps can share and the console can print.
 */

export type ModuleRow = {
  id: string;
  ordinal: number;
  title: string;
  summary: string | null;
  durationMins: number | null;
  state: ModuleState;
  /** The "60%" on an in-progress row. */
  percent: number;
  /** The best attempt, for "Score 5/5" — null before any. */
  best: { score: number; total: number; passed: boolean } | null;
};

export type CertificationView = {
  state: CertificationState;
  progress: { passed: number; total: number; pct: number };
  certificateId: string | null;
  issuedAt: string | null;
  agentName: string | null;
  /** The titles still to pass, so the screen can say what is left. */
  remaining: string[];
};

export type Curriculum = {
  modules: ModuleRow[];
  /** The resume card: the in-progress module with the highest ordinal, else the first open one. */
  resume: ModuleRow | null;
  certification: CertificationView;
};

export type ModuleView = ModuleRow & {
  videoUrl: string | null;
  lessonBody: string | null;
  transcript: string | null;
  takeaways: string[];
  passPercent: number;
  lastPositionSec: number | null;
  questionCount: number;
  /** The next module on the index, for "START MODULE 5". */
  next: { id: string; ordinal: number; title: string } | null;
};

export type QuizView = {
  moduleId: string;
  passPercent: number;
  questions: { id: string; ordinal: number; prompt: string; options: { id: string; ordinal: number; label: string }[] }[];
};

export type QuizResult = {
  score: number;
  total: number;
  passed: boolean;
  line: string;
  module: ModuleRow;
  next: { id: string; ordinal: number; title: string } | null;
  certification: CertificationView;
};

type Standing = {
  modules: TrainingModule[];
  progress: Map<string, { percent: number; completedAt: Date | null; lastPositionSec: number | null }>;
  best: Map<string, TrainingAttempt>;
  passedOrdinals: Set<number>;
  certification: AgentCertification | null;
};

async function standingOf(agentId: string): Promise<Standing> {
  const [modules, progressRows, attempts, certification] = await Promise.all([
    repository.findActiveModules(),
    repository.findProgress(agentId),
    repository.bestAttempts(agentId),
    repository.findCertification(agentId),
  ]);
  const progress = new Map(progressRows.map((row) => [row.moduleId, { percent: row.percent, completedAt: row.completedAt, lastPositionSec: row.lastPositionSec }]));
  const best = new Map(attempts.map((attempt) => [attempt.moduleId, attempt]));
  const passedOrdinals = new Set(modules.filter((m) => progress.get(m.id)?.completedAt).map((m) => m.ordinal));
  return { modules, progress, best, passedOrdinals, certification };
}

function rowOf(module: TrainingModule, standing: Standing): ModuleRow {
  const progress = standing.progress.get(module.id) ?? null;
  const best = standing.best.get(module.id) ?? null;
  return {
    id: module.id,
    ordinal: module.ordinal,
    title: module.title,
    summary: module.summary,
    durationMins: module.durationMins,
    state: moduleStateOf(module, progress, standing.passedOrdinals),
    percent: progress?.completedAt ? 100 : progress?.percent ?? 0,
    best: best ? { score: best.score, total: best.total, passed: best.passed } : null,
  };
}

function nextOf(module: TrainingModule, standing: Standing) {
  const after = standing.modules.find((m) => m.ordinal > module.ordinal);
  return after ? { id: after.id, ordinal: after.ordinal, title: after.title } : null;
}

async function certificationOf(standing: Standing, agentName: string | null): Promise<CertificationView> {
  const passed = standing.modules.filter((m) => standing.passedOrdinals.has(m.ordinal));
  const progress = certificationProgress(passed.length, standing.modules.length);
  const cert = standing.certification;
  const state: CertificationState = cert ? (cert.revokedAt ? 'REVOKED' : 'CERTIFIED') : 'LOCKED';
  return {
    state,
    progress,
    certificateId: cert && !cert.revokedAt ? cert.certificateId : null,
    issuedAt: cert && !cert.revokedAt ? cert.issuedAt.toISOString() : null,
    agentName,
    remaining: standing.modules.filter((m) => !standing.passedOrdinals.has(m.ordinal)).map((m) => m.title),
  };
}

export async function getCurriculum(userId: string): Promise<Curriculum> {
  const me = await requireAgentProfile(userId);
  const standing = await standingOf(me.id);
  const rows = standing.modules.map((module) => rowOf(module, standing));
  const inProgress = [...rows].reverse().find((row) => row.state === 'IN_PROGRESS') ?? null;
  const resume = inProgress ?? rows.find((row) => row.state === 'NOT_STARTED') ?? null;
  return { modules: rows, resume, certification: await certificationOf(standing, await repository.agentName(me.id)) };
}

async function openModule(userId: string, moduleId: string) {
  const me = await requireAgentProfile(userId);
  const module = await repository.findModule(moduleId);
  if (!module || !module.isActive) throw new ApiError(404, 'NOT_FOUND', 'No such module');
  const standing = await standingOf(me.id);
  const row = rowOf(module, standing);
  if (row.state === 'LOCKED') throw new ApiError(409, 'CONFLICT', 'Finish the module before this one first');
  return { me, module, standing, row };
}

/** Opening a module is the first progress it gets. */
export async function getModule(userId: string, moduleId: string): Promise<ModuleView> {
  const { me, module, standing, row } = await openModule(userId, moduleId);
  const progress = standing.progress.get(module.id);
  if (!progress || (progress.percent === 0 && !progress.completedAt)) {
    await repository.upsertProgress(me.id, module.id, { percent: PROGRESS_STEPS.OPENED });
    row.percent = Math.max(row.percent, PROGRESS_STEPS.OPENED);
    if (row.state === 'NOT_STARTED') row.state = 'IN_PROGRESS';
  }
  const questions = await repository.findQuestions(module.id);
  return {
    ...row,
    videoUrl: module.videoUrl,
    lessonBody: module.lessonBody,
    transcript: module.transcript,
    takeaways: module.takeaways,
    passPercent: module.passPercent,
    lastPositionSec: progress?.lastPositionSec ?? null,
    questionCount: questions.length,
    next: nextOf(module, standing),
  };
}

/** The app reports where it got to; the figure only climbs, and 100 is the quiz's to give. */
export async function reportProgress(userId: string, moduleId: string, input: { percent: number; positionSec?: number | null }) {
  const { me, module, standing } = await openModule(userId, moduleId);
  const current = standing.progress.get(module.id);
  if (current?.completedAt) return rowOf(module, standing);
  const percent = nextPercent(current?.percent ?? 0, input.percent);
  const saved = await repository.upsertProgress(me.id, module.id, {
    percent,
    ...(input.positionSec !== undefined ? { lastPositionSec: input.positionSec } : {}),
  });
  standing.progress.set(module.id, { percent: saved.percent, completedAt: saved.completedAt, lastPositionSec: saved.lastPositionSec });
  return rowOf(module, standing);
}

const stripCorrectness = (questions: QuestionWithOptions[]) =>
  questions.map((q) => ({
    id: q.id,
    ordinal: q.ordinal,
    prompt: q.prompt,
    options: q.options.map((o) => ({ id: o.id, ordinal: o.ordinal, label: o.label })),
  }));

/** The questions and their options. Correctness never crosses the wire. */
export async function getQuiz(userId: string, moduleId: string): Promise<QuizView> {
  const { module } = await openModule(userId, moduleId);
  const questions = await repository.findQuestions(module.id);
  if (questions.length === 0) throw new ApiError(409, 'CONFLICT', 'This module has no quiz yet');
  return { moduleId: module.id, passPercent: module.passPercent, questions: stripCorrectness(questions) };
}

/**
 * Scores, records the attempt, and on a pass completes the module — and, if
 * it was the last one, mints the certificate. A pass on a module already
 * passed is recorded but changes nothing; a fail locks nothing.
 */
export async function submitQuiz(
  userId: string,
  moduleId: string,
  answers: { questionId: string; optionId: string }[],
  now = new Date(),
): Promise<QuizResult> {
  const { me, module, standing } = await openModule(userId, moduleId);
  const questions = await repository.findQuestions(module.id);
  if (questions.length === 0) throw new ApiError(409, 'CONFLICT', 'This module has no quiz yet');

  const { score, total, passed } = scoreQuiz(questions, answers, module.passPercent);
  const attempt = await repository.createAttempt({ agentId: me.id, moduleId: module.id, submittedAt: now, score, total, passed, answers });

  const previousBest = standing.best.get(module.id);
  if (!previousBest || attempt.score > previousBest.score) standing.best.set(module.id, attempt);

  if (passed && !standing.progress.get(module.id)?.completedAt) {
    const saved = await repository.upsertProgress(me.id, module.id, { percent: PROGRESS_STEPS.PASSED, completedAt: now });
    standing.progress.set(module.id, { percent: saved.percent, completedAt: saved.completedAt, lastPositionSec: saved.lastPositionSec });
    standing.passedOrdinals.add(module.ordinal);

    const allPassed = standing.modules.every((m) => standing.passedOrdinals.has(m.ordinal));
    if (allPassed && !standing.certification) {
      const certificateId = await allocateIdentifier('CERTIFICATE');
      standing.certification = await repository.createCertification(me.id, certificateId, now);
    }
  }

  return {
    score,
    total,
    passed,
    line: scoreLine(score, total, passed),
    module: rowOf(module, standing),
    next: nextOf(module, standing),
    certification: await certificationOf(standing, await repository.agentName(me.id)),
  };
}

export async function getCertification(userId: string): Promise<CertificationView> {
  const me = await requireAgentProfile(userId);
  const standing = await standingOf(me.id);
  return certificationOf(standing, await repository.agentName(me.id));
}

/* ─── ADMIN ────────────────────────────────────────────────────────────── */

export type ModuleAdminView = Omit<ModuleView, 'state' | 'percent' | 'best' | 'lastPositionSec' | 'next'> & {
  isActive: boolean;
  unlockAfterOrdinal: number | null;
  createdAt: string;
  updatedAt: string;
};

function toAdminView(module: TrainingModule, questionCount: number): ModuleAdminView {
  return {
    id: module.id,
    ordinal: module.ordinal,
    title: module.title,
    summary: module.summary,
    durationMins: module.durationMins,
    videoUrl: module.videoUrl,
    lessonBody: module.lessonBody,
    transcript: module.transcript,
    takeaways: module.takeaways,
    passPercent: module.passPercent,
    questionCount,
    isActive: module.isActive,
    unlockAfterOrdinal: module.unlockAfterOrdinal,
    createdAt: module.createdAt.toISOString(),
    updatedAt: module.updatedAt.toISOString(),
  };
}

export async function listModules(): Promise<ModuleAdminView[]> {
  return (await repository.findModules()).map((m) => toAdminView(m, m._count.questions));
}

export async function getModuleForAdmin(id: string) {
  const module = await repository.findModule(id);
  if (!module) throw new ApiError(404, 'NOT_FOUND', 'No such module');
  const questions = await repository.findQuestions(id);
  return { ...toAdminView(module, questions.length), questions };
}

export async function createModule(input: CreateModuleInput) {
  const module = await repository.createModule(input);
  return toAdminView(module, 0);
}

export async function patchModule(id: string, input: PatchModuleInput) {
  const existing = await repository.findModule(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No such module');
  if (input.unlockAfterOrdinal !== undefined && input.unlockAfterOrdinal !== null) {
    const ordinal = input.ordinal ?? existing.ordinal;
    if (input.unlockAfterOrdinal >= ordinal) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A module can only wait on one that comes before it');
    }
  }
  const module = await repository.updateModule(id, input);
  const questions = await repository.findQuestions(id);
  return toAdminView(module, questions.length);
}

export async function putQuestions(id: string, input: PutQuestionsInput) {
  const existing = await repository.findModule(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No such module');
  return repository.replaceQuestions(id, input.questions);
}

/** The desk's row: the certification with the agent's display id and name. T-B: the revoke answers it too. */
function toCertificationRow(row: CertificationWithAgent) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentDisplayId: row.agent.displayId,
    agentName: row.agent.user.name,
    certificateId: row.certificateId,
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
  };
}

export async function listCertifications() {
  return (await repository.listCertifications()).map(toCertificationRow);
}

export async function revokeCertification(id: string, reason: string, byUserId: string, now = new Date()) {
  const rows = await repository.listCertifications();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such certification');
  if (row.revokedAt) throw new ApiError(409, 'CONFLICT', 'Already revoked');
  const revoked = await repository.revokeCertification(id, { revokedAt: now, revokedReason: reason, revokedByUserId: byUserId });
  await logActivity(byUserId, 'CERTIFICATION_REVOKED', undefined, { certificateId: row.certificateId, agentId: row.agentId, reason });
  return toCertificationRow(revoked);
}

/* ─── The library, unchanged ───────────────────────────────────────────── */

export async function getTrainingResources(opts: { category?: string; search?: string } = {}) {
  return repository.findTrainingResources(opts);
}

export async function createTrainingResource(data: NewTrainingResource) {
  return repository.createTrainingResource(data);
}
