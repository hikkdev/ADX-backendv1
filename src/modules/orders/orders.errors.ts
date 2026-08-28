import { ApiError } from '../../shared/errors';

/**
 * Order services throw bare sentinel `Error`s so they stay free of HTTP
 * concerns. This is the single place those become status codes — the shape the
 * original `svcErr` helper had, kept verbatim.
 */
const MAP: Record<string, [number, string]> = {
  ORDER_NOT_FOUND: [404, 'Order not found'],
  LISTING_NOT_FOUND: [404, 'Listing not found'],
  LISTING_NOT_ACTIVE: [400, 'Listing is not active'],
  LISTING_NOT_AVAILABLE: [400, 'Listing is currently occupied by an active campaign'],
  NOT_YOUR_ORDER: [403, 'You do not have access to this order'],
  WRONG_STATUS: [400, 'Order is not in the required state for this action'],
  ASSIGNMENT_NOT_FOUND: [404, 'No pending assignment for you on this order'],
  OTP_NOT_REQUESTED: [400, 'OTP has not been requested yet'],
  OTP_EXPIRED: [400, 'OTP expired. Request a new one.'],
  OTP_INVALID: [400, 'Invalid OTP'],
  ALREADY_COMPLETED: [400, 'Cannot cancel a completed order'],
  COUNTER_LIMIT_REACHED: [400, 'Max slot negotiations reached. Escalated to sales team.'],
};

/** Rethrows a sentinel as an ApiError, or the original error if unrecognised. */
export function orderError(e: any): never {
  const entry = MAP[e?.message];
  if (!entry) throw e;

  const [statusCode, message] = entry;
  if (statusCode === 404) throw new ApiError(404, 'NOT_FOUND', message);
  if (statusCode === 403) throw new ApiError(403, 'FORBIDDEN', message);
  throw new ApiError(statusCode, 'BAD_REQUEST', message);
}
