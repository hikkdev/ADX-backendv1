import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 05 — the training curriculum.
 *
 * Pinned: the four row states; progress that only climbs and never reaches
 * 100 except through a passed quiz; correctness that never crosses the wire;
 * a quiz scored by the module's own pass mark, unlimited attempts, the best
 * one counting, a fail locking nothing; a module locked until the one it
 * waits on is passed; the certificate minted through `identifiers` on the
 * last pass, once; and `GET /training` — the library — untouched.
 */

const { repository, agents, identifiers, audit } = vi.hoisted(() => ({
  repository: {
    findActiveModules: vi.fn(),
    agentSides: vi.fn(async () => ({ publisher: true, advertiser: false })),
    findModules: vi.fn(),
    findModule: vi.fn(),
    createModule: vi.fn(),
    updateModule: vi.fn(),
    findQuestions: vi.fn(),
    replaceQuestions: vi.fn(),
    findProgress: vi.fn(),
    upsertProgress: vi.fn(),
    createAttempt: vi.fn(),
    bestAttempts: vi.fn(),
    findCertification: vi.fn(),
    createCertification: vi.fn(),
    revokeCertification: vi.fn(),
    listCertifications: vi.fn(),
    agentName: vi.fn(),
    findTrainingResources: vi.fn(),
    createTrainingResource: vi.fn(),
  },
  agents: { requireAgentProfile: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-training.repository', () => ({ prismaTrainingRepository: repository }));
vi.mock('../../agents', () => agents);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../../shared/audit', () => audit);

import { moduleStateOf, nextPercent, scoreLine, scoreQuiz } from '../training.rules';
import { getCurriculum, getModule, getQuiz, listCertifications, patchModule, reportProgress, revokeCertification, submitQuiz } from '../training.service';
import { putQuestionsSchema } from '../training.schema';

const NOW = new Date('2026-09-11T06:00:00.000Z');

const mod = (ordinal: number, over: Record<string, unknown> = {}) => ({
  id: `mod_${ordinal}`,
  ordinal,
  title: `Module ${ordinal}`,
  summary: null,
  durationMins: 12,
  videoUrl: null,
  lessonBody: 'Lesson',
  transcript: null,
  takeaways: ['One'],
  unlockAfterOrdinal: ordinal > 1 ? ordinal - 1 : null,
  passPercent: 80,
  isActive: true,
  audience: 'ALL',
  kind: 'LESSON',
  timeLimitMins: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const progress = (moduleId: string, percent: number, completedAt: Date | null = null) => ({
  id: `prg_${moduleId}`,
  agentId: 'agt_1',
  moduleId,
  percent,
  lastPositionSec: null,
  startedAt: NOW,
  completedAt,
  updatedAt: NOW,
});

const questions = [
  { id: 'q1', moduleId: 'mod_1', ordinal: 1, prompt: 'Q1', isActive: true, createdAt: NOW, options: [
    { id: 'q1a', questionId: 'q1', ordinal: 1, label: 'A', isCorrect: true },
    { id: 'q1b', questionId: 'q1', ordinal: 2, label: 'B', isCorrect: false },
  ] },
  { id: 'q2', moduleId: 'mod_1', ordinal: 1, prompt: 'Q2', isActive: true, createdAt: NOW, options: [
    { id: 'q2a', questionId: 'q2', ordinal: 1, label: 'A', isCorrect: false },
    { id: 'q2b', questionId: 'q2', ordinal: 2, label: 'B', isCorrect: true },
  ] },
];

beforeEach(() => {
  vi.clearAllMocks();
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });
  repository.findActiveModules.mockResolvedValue([mod(1), mod(2), mod(3)]);
  repository.findModule.mockImplementation(async (id: string) => [mod(1), mod(2), mod(3)].find((m) => m.id === id) ?? null);
  repository.findProgress.mockResolvedValue([]);
  repository.bestAttempts.mockResolvedValue([]);
  repository.findCertification.mockResolvedValue(null);
  repository.agentName.mockResolvedValue('Ravi Kumar');
  repository.findQuestions.mockResolvedValue(questions);
  repository.upsertProgress.mockImplementation(async (_a, moduleId, data) => progress(moduleId, data.percent, data.completedAt ?? null));
  repository.createAttempt.mockImplementation(async (data) => ({ id: 'att_1', startedAt: NOW, ...data }));
  repository.createCertification.mockImplementation(async (agentId, certificateId, issuedAt) => ({
    id: 'cert_1', agentId, certificateId, issuedAt, revokedAt: null, revokedReason: null, revokedByUserId: null,
  }));
  identifiers.allocateIdentifier.mockResolvedValue('ADX-CERT-1109-2601');
});

describe('the rules', () => {
  it('draws the four row states', () => {
    const passed = new Set([1]);
    expect(moduleStateOf(mod(1), progress('mod_1', 100, NOW), passed)).toBe('COMPLETED');
    expect(moduleStateOf(mod(2), progress('mod_2', 60), passed)).toBe('IN_PROGRESS');
    expect(moduleStateOf(mod(2), null, passed)).toBe('NOT_STARTED');
    expect(moduleStateOf(mod(3), null, passed)).toBe('LOCKED');
    // A completed module is never locked, whatever happened to the one before it.
    expect(moduleStateOf(mod(3), progress('mod_3', 100, NOW), new Set())).toBe('COMPLETED');
  });

  it('lets percent climb but never fall, and never reach 100 on its own', () => {
    expect(nextPercent(60, 40)).toBe(60);
    expect(nextPercent(60, 70)).toBe(70);
    expect(nextPercent(60, 100)).toBe(99);
  });

  it('scores against the module\'s own pass mark and tolerates a stale quiz', () => {
    expect(scoreQuiz(questions, [{ questionId: 'q1', optionId: 'q1a' }, { questionId: 'q2', optionId: 'q2b' }], 80)).toEqual({ score: 2, total: 2, passed: true });
    expect(scoreQuiz(questions, [{ questionId: 'q1', optionId: 'q1a' }, { questionId: 'q2', optionId: 'q2a' }], 80)).toEqual({ score: 1, total: 2, passed: false });
    expect(scoreQuiz(questions, [{ questionId: 'q1', optionId: 'q1a' }], 50)).toEqual({ score: 1, total: 2, passed: true });
    expect(scoreQuiz(questions, [{ questionId: 'gone', optionId: 'x' }, { questionId: 'q1', optionId: 'q2b' }], 80).score).toBe(0);
    expect(scoreLine(5, 5, true)).toBe('Score 5/5 — perfect run');
    expect(scoreLine(2, 5, false)).toBe('Score 2/5 — try again');
  });
});

describe('the index', () => {
  it('lists the modules with their state, the resume card and the locked certification', async () => {
    repository.findProgress.mockResolvedValue([progress('mod_1', 100, NOW), progress('mod_2', 60)]);
    repository.bestAttempts.mockResolvedValue([{ id: 'a', agentId: 'agt_1', moduleId: 'mod_1', startedAt: NOW, submittedAt: NOW, score: 5, total: 5, passed: true, answers: [] }]);
    const curriculum = await getCurriculum('usr_agent');
    expect(curriculum.modules.map((m) => `${m.ordinal}:${m.state}:${m.percent}`)).toEqual(['1:COMPLETED:100', '2:IN_PROGRESS:60', '3:LOCKED:0']);
    expect(curriculum.modules[0]!.best).toEqual({ score: 5, total: 5, passed: true });
    expect(curriculum.resume?.ordinal).toBe(2);
    expect(curriculum.certification).toMatchObject({ state: 'LOCKED', progress: { passed: 1, total: 3, pct: 33 }, certificateId: null, remaining: ['Module 2', 'Module 3'] });
  });
});

describe('a module', () => {
  it('opens with its first progress, and refuses a locked one', async () => {
    const view = await getModule('usr_agent', 'mod_1');
    expect(repository.upsertProgress).toHaveBeenCalledWith('agt_1', 'mod_1', { percent: 10 });
    expect(view.state).toBe('IN_PROGRESS');
    expect(view.next).toEqual({ id: 'mod_2', ordinal: 2, title: 'Module 2' });
    expect(view.questionCount).toBe(2);
    await expect(getModule('usr_agent', 'mod_3')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records progress that only climbs, and nothing once it is complete', async () => {
    repository.findProgress.mockResolvedValue([progress('mod_1', 60)]);
    await reportProgress('usr_agent', 'mod_1', { percent: 40, positionSec: 120 });
    expect(repository.upsertProgress).toHaveBeenCalledWith('agt_1', 'mod_1', { percent: 60, lastPositionSec: 120 });

    repository.findProgress.mockResolvedValue([progress('mod_1', 100, NOW)]);
    repository.upsertProgress.mockClear();
    const row = await reportProgress('usr_agent', 'mod_1', { percent: 70 });
    expect(repository.upsertProgress).not.toHaveBeenCalled();
    expect(row.state).toBe('COMPLETED');
  });

  it('serves the quiz without correctness', async () => {
    const quiz = await getQuiz('usr_agent', 'mod_1');
    expect(quiz.questions[0]!.options[0]).toEqual({ id: 'q1a', ordinal: 1, label: 'A' });
    expect(JSON.stringify(quiz)).not.toContain('isCorrect');
  });
});

describe('the quiz', () => {
  it('records the attempt, completes the module on a pass, and points at the next one', async () => {
    const result = await submitQuiz('usr_agent', 'mod_1', [{ questionId: 'q1', optionId: 'q1a' }, { questionId: 'q2', optionId: 'q2b' }], NOW);
    expect(repository.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ score: 2, total: 2, passed: true }));
    expect(repository.upsertProgress).toHaveBeenCalledWith('agt_1', 'mod_1', { percent: 100, completedAt: NOW });
    expect(result.line).toBe('Score 2/2 — perfect run');
    expect(result.module.state).toBe('COMPLETED');
    expect(result.next?.ordinal).toBe(2);
    expect(result.certification.progress).toEqual({ passed: 1, total: 3, pct: 33 });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
  });

  it('a fail is recorded and locks nothing', async () => {
    repository.findProgress.mockResolvedValue([progress('mod_1', 70)]);
    const result = await submitQuiz('usr_agent', 'mod_1', [{ questionId: 'q1', optionId: 'q1b' }, { questionId: 'q2', optionId: 'q2a' }], NOW);
    expect(result.passed).toBe(false);
    expect(repository.upsertProgress).not.toHaveBeenCalled();
    expect(result.module.state).toBe('IN_PROGRESS');
    expect(result.module.best).toEqual({ score: 0, total: 2, passed: false });
  });

  it('mints the certificate through identifiers on the last pass, once', async () => {
    repository.findProgress.mockResolvedValue([progress('mod_1', 100, NOW), progress('mod_2', 100, NOW), progress('mod_3', 70)]);
    const result = await submitQuiz('usr_agent', 'mod_3', [{ questionId: 'q1', optionId: 'q1a' }, { questionId: 'q2', optionId: 'q2b' }], NOW);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('CERTIFICATE');
    expect(repository.createCertification).toHaveBeenCalledWith('agt_1', 'ADX-CERT-1109-2601', NOW);
    expect(result.certification).toMatchObject({ state: 'CERTIFIED', certificateId: 'ADX-CERT-1109-2601', agentName: 'Ravi Kumar', progress: { passed: 3, total: 3, pct: 100 } });

    // A second perfect run on the same module changes nothing.
    repository.findProgress.mockResolvedValue([progress('mod_1', 100, NOW), progress('mod_2', 100, NOW), progress('mod_3', 100, NOW)]);
    repository.findCertification.mockResolvedValue({ id: 'cert_1', agentId: 'agt_1', certificateId: 'ADX-CERT-1109-2601', issuedAt: NOW, revokedAt: null });
    repository.createCertification.mockClear();
    await submitQuiz('usr_agent', 'mod_3', [{ questionId: 'q1', optionId: 'q1a' }, { questionId: 'q2', optionId: 'q2b' }], NOW);
    expect(repository.createCertification).not.toHaveBeenCalled();
  });
});

describe('the desk', () => {
  it('needs exactly one correct option per question', () => {
    expect(putQuestionsSchema.safeParse({ questions: [{ prompt: 'Q', options: [{ label: 'A', isCorrect: true }, { label: 'B' }] }] }).success).toBe(true);
    expect(putQuestionsSchema.safeParse({ questions: [{ prompt: 'Q', options: [{ label: 'A' }, { label: 'B' }] }] }).success).toBe(false);
    expect(putQuestionsSchema.safeParse({ questions: [{ prompt: 'Q', options: [{ label: 'A', isCorrect: true }, { label: 'B', isCorrect: true }] }] }).success).toBe(false);
  });

  it('refuses a module that waits on one after it', async () => {
    await expect(patchModule('mod_2', { unlockAfterOrdinal: 3 })).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.updateModule).not.toHaveBeenCalled();
  });
});

/* T-B — a write answers the same view its read answers. */
describe('revoking a certification', () => {
  const cert = (over: Record<string, unknown> = {}) => ({
    id: 'crt_1',
    agentId: 'agt_1',
    certificateId: 'ADX-CERT-2026-0001',
    issuedAt: NOW,
    revokedAt: null,
    revokedReason: null,
    revokedByUserId: null,
    agent: { id: 'agt_1', displayId: 'AGT-0007', user: { name: 'Meera S' } },
    ...over,
  });

  it('answers the desk row — agentDisplayId and agentName beside the revoked certificate, as the list does', async () => {
    repository.listCertifications.mockResolvedValue([cert()]);
    repository.revokeCertification.mockImplementation(async (_id: string, data: Record<string, unknown>) => cert(data));
    const revoked = await revokeCertification('crt_1', 'Cheated on the quiz', 'usr_admin', NOW);
    expect(repository.revokeCertification).toHaveBeenCalledWith('crt_1', { revokedAt: NOW, revokedReason: 'Cheated on the quiz', revokedByUserId: 'usr_admin' });
    expect(revoked).toEqual({
      id: 'crt_1',
      agentId: 'agt_1',
      agentDisplayId: 'AGT-0007',
      agentName: 'Meera S',
      certificateId: 'ADX-CERT-2026-0001',
      issuedAt: NOW.toISOString(),
      revokedAt: NOW.toISOString(),
      revokedReason: 'Cheated on the quiz',
    });
    expect(revoked).not.toHaveProperty('agent');
    // the same shape the list answers
    repository.listCertifications.mockResolvedValue([cert({ revokedAt: NOW, revokedReason: 'Cheated on the quiz' })]);
    expect((await listCertifications())[0]).toEqual(revoked);
  });

  it('refuses a second revoke', async () => {
    repository.listCertifications.mockResolvedValue([cert({ revokedAt: NOW })]);
    await expect(revokeCertification('crt_1', 'again', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

/**
 * AG-4: a curriculum per side, and the assessment as a module kind.
 */
describe('AG-4: sides and assessments', () => {
  it('asks for the modules of the sides the agent works, and the certificate counts the lessons alone', async () => {
    const { getCurriculum, submitQuiz, getAssessmentStanding } = await import('../training.service');
    agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1' });
    repository.agentSides.mockResolvedValue({ publisher: false, advertiser: true });
    const assessment = mod(3, { kind: 'ASSESSMENT', audience: 'ADVERTISER_AGENT', passPercent: 60, timeLimitMins: 20, unlockAfterOrdinal: null });
    repository.findActiveModules.mockResolvedValue([mod(1, { unlockAfterOrdinal: null }), mod(2), assessment]);
    repository.findProgress.mockResolvedValue([
      { moduleId: 'mod_1', percent: 100, completedAt: new Date(), lastPositionSec: null },
      { moduleId: 'mod_2', percent: 100, completedAt: new Date(), lastPositionSec: null },
    ]);
    repository.bestAttempts.mockResolvedValue([{ moduleId: 'mod_3', score: 9, total: 20, passed: false }]);
    repository.findCertification.mockResolvedValue(null);
    repository.agentName.mockResolvedValue('Ravi');

    const curriculum = await getCurriculum('usr_1');
    expect(repository.findActiveModules).toHaveBeenCalledWith({ publisher: false, advertiser: true });
    expect(curriculum.modules.map((m) => m.kind)).toEqual(['LESSON', 'LESSON', 'ASSESSMENT']);
    // Two lessons of two passed: the certificate is complete even though the assessment is not.
    expect(curriculum.certification.progress).toEqual({ passed: 2, total: 2, pct: 100 });
    expect(curriculum.certification.remaining).toEqual([]);

    const standing = await getAssessmentStanding('agt_1');
    expect(standing).toEqual({ required: true, passed: false, modules: [{ id: 'mod_3', title: 'Module 3', passPercent: 60, timeLimitMins: 20, best: { score: 9, total: 20, passed: false, percent: 45 } }] });

    // Passing the assessment records the attempt and mints nothing.
    repository.findModule.mockResolvedValue(assessment);
    repository.findQuestions.mockResolvedValue([{ id: 'q1', ordinal: 1, prompt: 'Q', isActive: true, options: [{ id: 'o1', ordinal: 1, label: 'A', isCorrect: true }, { id: 'o2', ordinal: 2, label: 'B', isCorrect: false }] }]);
    repository.createAttempt.mockResolvedValue({ moduleId: 'mod_3', score: 1, total: 1, passed: true });
    repository.upsertProgress.mockResolvedValue({ percent: 100, completedAt: new Date(), lastPositionSec: null });
    identifiers.allocateIdentifier.mockClear();
    repository.createCertification.mockClear();
    const result = await submitQuiz('usr_1', 'mod_3', [{ questionId: 'q1', optionId: 'o1' }]);
    expect(result.passed).toBe(true);
    expect(repository.createCertification).not.toHaveBeenCalled();
  });
});
