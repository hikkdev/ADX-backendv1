/**
 * Training — the flat library two apps read (`GET /training`, unchanged) and,
 * since DR 05, the curriculum beside it: ordered modules, per-agent progress,
 * quizzes and the ADX-CERT certificate.
 *
 * Moved out of `agents/milestones`, which used to answer the library routes;
 * the curriculum is its own domain with its own tables, and `agents` is
 * already the module everything else reads.
 */
export { trainingRouter } from './training.routes';
export type { Curriculum, ModuleRow, ModuleView, QuizView, QuizResult, CertificationView } from './training.service';
export { MODULE_STATES, CERTIFICATION_STATES } from './training.rules';
// AG-1: the certificate's state, for the agent application's ladder (registered on agents' port by bootstrap).
export { getCertification, getAssessmentStanding } from './training.service';
export type { AssessmentStanding } from './training.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
