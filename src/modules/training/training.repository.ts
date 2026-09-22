import type {
  AgentCertification,
  AgentTrainingProgress,
  Prisma,
  TrainingAttempt,
  TrainingAudience,
  TrainingModule,
  TrainingModuleKind,
  TrainingOption,
  TrainingQuestion,
  TrainingResource,
} from '../../shared/database';

export type QuestionWithOptions = TrainingQuestion & { options: TrainingOption[] };
export type ModuleWithCounts = TrainingModule & { _count: { questions: number } };

export type NewModule = {
  ordinal: number;
  title: string;
  summary: string | null;
  durationMins: number | null;
  videoUrl: string | null;
  lessonBody: string | null;
  transcript: string | null;
  takeaways: string[];
  unlockAfterOrdinal: number | null;
  passPercent: number;
  isActive: boolean;
  /** AG-4: whom it is for, what it is, and an assessment's clock. */
  audience: TrainingAudience;
  kind: TrainingModuleKind;
  timeLimitMins: number | null;
};
export type ModulePatch = Partial<NewModule>;

/** AG-4: the sides an agent works — the audiences whose modules they see beside ALL. */
export type AgentSides = { publisher: boolean; advertiser: boolean };

export type NewQuestion = { prompt: string; options: { label: string; isCorrect: boolean }[] };

export type NewTrainingResource = {
  title: string;
  category: string;
  duration?: string;
  subtitle?: string;
  topic?: string;
  status?: string;
  statusVariant?: string;
  videoUrl?: string;
  documentUrl?: string;
};

/** A certification with the agent it names — the desk's row. */
export type CertificationWithAgent = AgentCertification & { agent: { id: string; displayId: string | null; user: { name: string | null } } };

export interface TrainingRepository {
  /* The curriculum. */
  /** AG-4: the active modules for these sides — audience ALL always, a side's own when they work it; every side when none is given. */
  findActiveModules(sides?: AgentSides): Promise<TrainingModule[]>;
  /** AG-4: which sides the agent holds a role for. */
  agentSides(agentId: string): Promise<AgentSides>;
  findModules(): Promise<ModuleWithCounts[]>;
  findModule(id: string): Promise<TrainingModule | null>;
  createModule(data: NewModule): Promise<TrainingModule>;
  updateModule(id: string, patch: ModulePatch): Promise<TrainingModule>;
  /** Active questions with their options, in order. `isCorrect` rides along; the service strips it. */
  findQuestions(moduleId: string): Promise<QuestionWithOptions[]>;
  /** Replaces the module's question set wholesale. */
  replaceQuestions(moduleId: string, questions: NewQuestion[]): Promise<QuestionWithOptions[]>;

  /* The agent's standing. */
  findProgress(agentId: string): Promise<AgentTrainingProgress[]>;
  upsertProgress(
    agentId: string,
    moduleId: string,
    data: { percent: number; lastPositionSec?: number | null; completedAt?: Date },
  ): Promise<AgentTrainingProgress>;
  createAttempt(data: {
    agentId: string;
    moduleId: string;
    submittedAt: Date;
    score: number;
    total: number;
    passed: boolean;
    answers: Prisma.InputJsonValue;
  }): Promise<TrainingAttempt>;
  /** The best attempt per module, for "Score 5/5" on a row. */
  bestAttempts(agentId: string): Promise<TrainingAttempt[]>;

  /* The certificate. */
  findCertification(agentId: string): Promise<AgentCertification | null>;
  createCertification(agentId: string, certificateId: string, issuedAt: Date): Promise<AgentCertification>;
  /** T-B: the revoke answers the desk's row — the certification with its agent — as the list does. */
  revokeCertification(id: string, data: { revokedAt: Date; revokedReason: string; revokedByUserId: string }): Promise<CertificationWithAgent>;
  listCertifications(): Promise<CertificationWithAgent[]>;
  agentName(agentId: string): Promise<string | null>;

  /* The library, unchanged. */
  findTrainingResources(opts: { category?: string; search?: string }): Promise<TrainingResource[]>;
  createTrainingResource(data: NewTrainingResource): Promise<TrainingResource>;
}
