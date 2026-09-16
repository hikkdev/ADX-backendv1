/**
 * The pure half of the curriculum: which state a module row is in, what the
 * certification says, and how a quiz is scored. No I/O.
 */

/** The four row states the index draws at once. */
export const MODULE_STATES = ['COMPLETED', 'IN_PROGRESS', 'NOT_STARTED', 'LOCKED'] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export type ModuleFacts = {
  ordinal: number;
  unlockAfterOrdinal: number | null;
};

export type ProgressFacts = {
  percent: number;
  completedAt: Date | null;
} | null;

/**
 * A module is COMPLETED once its quiz has been passed, IN_PROGRESS once it has
 * been opened, LOCKED while the module it waits on has not been passed, and
 * NOT_STARTED otherwise. A completed module is never locked — the work was
 * done — and the first module is always open.
 */
export function moduleStateOf(module: ModuleFacts, progress: ProgressFacts, passedOrdinals: ReadonlySet<number>): ModuleState {
  if (progress?.completedAt) return 'COMPLETED';
  if (module.unlockAfterOrdinal !== null && !passedOrdinals.has(module.unlockAfterOrdinal)) return 'LOCKED';
  if (progress && progress.percent > 0) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

export const CERTIFICATION_STATES = ['LOCKED', 'CERTIFIED', 'REVOKED'] as const;
export type CertificationState = (typeof CERTIFICATION_STATES)[number];

/**
 * "Certification progress 4 of 8": passed modules over active modules. The
 * certificate is minted the moment the last one passes; until then the exam
 * row on the index is locked. There is no separate exam — decision 12: the
 * curriculum IS the exam, one quiz per module, and the certificate is the
 * proof that every quiz was passed.
 */
export function certificationProgress(passed: number, total: number): { passed: number; total: number; pct: number } {
  return { passed, total, pct: total > 0 ? Math.floor((passed / total) * 100) : 0 };
}

/** The progress milestones the app reports as it goes; the quiz sets 100. */
export const PROGRESS_STEPS = { OPENED: 10, VIDEO: 40, LESSON_READ: 70, PASSED: 100 } as const;

/** Percent only climbs: a re-read of module 4 cannot take "60%" back to 10. */
export function nextPercent(current: number, reported: number): number {
  const clamped = Math.max(0, Math.min(99, Math.floor(reported)));
  return Math.max(current, clamped);
}

export type QuizQuestion = { id: string; options: { id: string; isCorrect: boolean }[] };
export type QuizAnswer = { questionId: string; optionId: string };

/**
 * One point per question whose chosen option is the correct one. An answer to
 * a question that is not on the quiz, or an option that is not on its
 * question, scores nothing rather than throwing — a stale quiz screen is not
 * an error. Pass is by percent against the module's own mark.
 */
export function scoreQuiz(questions: QuizQuestion[], answers: QuizAnswer[], passPercent: number): { score: number; total: number; passed: boolean } {
  const chosen = new Map(answers.map((answer) => [answer.questionId, answer.optionId]));
  let score = 0;
  for (const question of questions) {
    const optionId = chosen.get(question.id);
    if (optionId && question.options.some((option) => option.id === optionId && option.isCorrect)) score += 1;
  }
  const total = questions.length;
  const passed = total > 0 && (score / total) * 100 >= passPercent;
  return { score, total, passed };
}

/** "Score 5/5 — perfect run" / "Score 4/5 — passed" / "Score 2/5 — try again". */
export function scoreLine(score: number, total: number, passed: boolean): string {
  if (total > 0 && score === total) return `Score ${score}/${total} — perfect run`;
  return `Score ${score}/${total} — ${passed ? 'passed' : 'try again'}`;
}
