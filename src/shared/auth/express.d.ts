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
    }
  }
}
