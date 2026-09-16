import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** What an incoming id may look like once it is ours: printable, no whitespace, bounded. */
const MAX_REQUEST_ID_LENGTH = 64;
const SAFE_CHARS = /[^A-Za-z0-9._:-]/g;

/**
 * Takes an upstream id when the proxy sent one, otherwise mints one. The
 * sanitising is not decorative: this value is echoed in a response header and
 * written to every log line and audit row for the request, so it is the one
 * client-controlled string that lands everywhere.
 */
export function sanitiseRequestId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(SAFE_CHARS, '').slice(0, MAX_REQUEST_ID_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The first middleware on the app. Every later layer — the request logger,
 * the error envelope, the audit rows — reads `req.requestId`; nothing else
 * sets it.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = sanitiseRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** The id for a request, or undefined outside the HTTP pipeline (jobs, scripts). */
export function getRequestId(req: Request | undefined): string | undefined {
  return req?.requestId;
}
