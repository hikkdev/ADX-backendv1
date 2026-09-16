import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  issueGrantHandler,
  myGrantsHandler,
  openGrantsHandler,
  publisherGrantsHandler,
  revokeGrantHandler,
  agentGrantsHandler,
  partyLogHandler,
} from './access-grants.controller';

export const accessGrantRouter = Router();
accessGrantRouter.use(authenticate);

/**
 * Issuing is not role-gated here on purpose.
 *
 * The check that matters is ownership, and it is in the service: the caller has
 * to be the publisher whose account is being lent out, or ADX. A role gate would
 * be the wrong shape — a publisher is a `PUBLISHER`, but ops issuing on a ticket
 * is an `ADMIN`, and neither of those facts is what makes the request legitimate.
 */
accessGrantRouter.post('/', asyncHandler(issueGrantHandler));

/** The publisher withdrawing early, or ops doing it for them. */
accessGrantRouter.post('/:grantId/revoke', asyncHandler(revokeGrantHandler));

/** What the signed-in agent has been given. Theirs only. */
accessGrantRouter.get('/mine', requireRole('AGENT_PUBLISHER'), asyncHandler(myGrantsHandler));

/** Everything still open, so nobody has to ask who currently has access. */
accessGrantRouter.get('/open', requireRole('ADMIN'), asyncHandler(openGrantsHandler));

/** A publisher's own history. Ownership checked in the service. */
accessGrantRouter.get('/publisher/:publisherId', asyncHandler(publisherGrantsHandler));

/** D6: ops oversight — an agent's grants, and a party's whole record. */
accessGrantRouter.get('/agent/:agentId', requireRole('ADMIN'), asyncHandler(agentGrantsHandler));
accessGrantRouter.get('/log/:partyType/:partyId', requireRole('ADMIN'), asyncHandler(partyLogHandler));
