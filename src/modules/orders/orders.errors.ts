import { ApiError, type ApiErrorCode } from '../../shared/errors';

/**
 * Order services throw bare sentinel `Error`s so they stay free of HTTP
 * concerns. This is the single place those become status codes — the shape the
 * original `svcErr` helper had, kept verbatim.
 */
const MAP: Record<string, [number, string, ApiErrorCode?]> = {
  ORDER_NOT_FOUND: [404, 'Order not found'],
  LISTING_NOT_FOUND: [404, 'Listing not found'],
  LISTING_NOT_ACTIVE: [400, 'Listing is not active'],
  LISTING_NOT_AVAILABLE: [400, 'No slot left on this listing for those dates'],
  NOT_YOUR_ORDER: [403, 'You do not have access to this order'],
  WRONG_STATUS: [400, 'Order is not in the required state for this action'],
  ASSIGNMENT_NOT_FOUND: [404, 'No pending assignment for you on this order'],
  OFFER_EXPIRED: [400, 'This offer has expired. ADX has offered the job to another agent.'],
  PICKUP_CODE_MISMATCH: [400, 'That code belongs to a different order. Check the package label.'],
  OTP_NOT_REQUESTED: [400, 'OTP has not been requested yet'],
  OTP_EXPIRED: [400, 'OTP expired. Request a new one.'],
  OTP_INVALID: [400, 'Invalid OTP'],
  ALREADY_COMPLETED: [400, 'Cannot cancel a completed order'],
  COUNTER_LIMIT_REACHED: [400, 'Max slot negotiations reached. Escalated to sales team.'],
  ATTESTATION_REQUIRED: [
    400,
    'Confirm that what you have filed is accurate before submitting the installation.',
  ],
  EVIDENCE_INCOMPLETE: [
    400,
    'Some proof is still missing. Check in at the site and photograph it before and after.',
  ],
  FULFILMENT_LOCKED: [
    400,
    'ADX has already acted on this booking. Ask support if you need the fulfilment changed.',
  ],
  NO_MEETING_PLACE: [
    400,
    'Add your address before accepting a booking — the agent needs somewhere to collect the material.',
  ],
  // Lot D (Q90): the ops overrides.
  OPS_WINDOW_OPEN: [409, 'The party still has time to answer. The override opens when their window closes.'],
  OPS_NO_CHECKIN: [409, 'The agent has not checked in at the site. Prints can only be collected for an agent who is there.'],
  NO_PUBLISHER_ACCOUNT: [409, 'This listing has no publisher account to act for.'],
  SAME_AGENT: [400, 'That agent already holds this order.'],
  // Lot D (Q120): the print gate. Its own code so the console routes to the review queue.
  CREATIVE_NOT_APPROVED: [
    409,
    'The artwork for this order has not been approved. Approve it in the creative review queue before marking prints ready.',
    'CREATIVE_NOT_APPROVED',
  ],
};

/** Rethrows a sentinel as an ApiError, or the original error if unrecognised. */
export function orderError(e: any): never {
  const entry = MAP[e?.message];
  if (!entry) throw e;

  const [statusCode, message, code] = entry;
  if (code) throw new ApiError(statusCode, code, message);
  if (statusCode === 404) throw new ApiError(404, 'NOT_FOUND', message);
  if (statusCode === 403) throw new ApiError(403, 'FORBIDDEN', message);
  if (statusCode === 409) throw new ApiError(409, 'CONFLICT', message);
  throw new ApiError(statusCode, 'BAD_REQUEST', message);
}
