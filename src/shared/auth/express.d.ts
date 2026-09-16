import type { AccessTokenPayload } from './jwt';

/**
 * Attaches the verified access-token payload to Express's Request type.
 *
 * This lives in its own declaration file so the augmentation survives module
 * moves: tsconfig includes every file under src, so the global is in scope
 * regardless of which file happens to import authenticate() at any point.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      /**
       * The unparsed request body, captured for signature verification.
       *
       * A webhook HMAC covers the exact bytes the provider sent. Re-serialising
       * the parsed object changes key order and whitespace, so the digest never
       * matches — the raw buffer has to be kept as the body is read.
       */
      rawBody?: Buffer;
      /**
       * The correlation id for this request — taken from an incoming
       * x-request-id or minted by shared/http/request-id, the first
       * middleware on the app. Echoed in the response header, the log lines,
       * the error envelope and every audit row the request writes.
       */
      requestId?: string;
    }
  }
}
