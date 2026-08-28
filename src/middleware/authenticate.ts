import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../lib/errors';
import { verifyAccessToken, type AccessTokenPayload } from '../services/token.service';
import { prisma } from '../lib/prisma';
import type { Role } from '../generated/prisma';

const CLAIM_TTL_MS = 48 * 60 * 60 * 1000;

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing authorization header');
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  next();
}

export function requireRole(...roles: Role[]) {
  const guard = (req: Request, _res: Response, next: NextFunction): void => {
    const userRoles = req.user?.roles ?? [];
    const hasRole = roles.some((r) => userRoles.includes(r));
    if (!hasRole) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
    next();
  };
  // Name encodes the roles so the route-inventory snapshot records which
  // roles guard each route, not just that some guard exists. Metadata only.
  Object.defineProperty(guard, 'name', { value: `requireRole(${roles.join('|')})`, configurable: true });
  return guard;
}

// Blocks PUBLISHER users from accessing protected routes until onboarding is complete.
// Also handles 48hr auto-expiry: if claimedAt + 48h has passed and still IN_ONBOARDING, resets to PENDING.
export async function requirePublisherOnboarded(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userRoles = req.user?.roles ?? [];
    if (!userRoles.includes('PUBLISHER')) {
      next();
      return;
    }

    const userId = req.user!.sub;
    const publisher = await prisma.publisher.findUnique({ where: { userId } });

    if (!publisher) {
      throw new ApiError(403, 'FORBIDDEN', 'Publisher profile not found. Complete registration first.');
    }

    // 48hr auto-expiry check
    if (
      publisher.onboardingStatus === 'IN_ONBOARDING' &&
      publisher.claimedAt &&
      Date.now() - publisher.claimedAt.getTime() > CLAIM_TTL_MS
    ) {
      await prisma.$transaction([
        prisma.qrCode.updateMany({
          where: { type: 'PUBLISHER', refId: publisher.id, isActive: true },
          data: { isActive: false },
        }),
        prisma.publisher.update({
          where: { id: publisher.id },
          data: { onboardingStatus: 'PENDING_ONBOARDING', agentId: null, claimedAt: null },
        }),
      ]);
      throw new ApiError(403, 'FORBIDDEN', 'Onboarding expired. Please generate a new QR code.');
    }

    if (publisher.onboardingStatus !== 'ONBOARDING_COMPLETE') {
      throw new ApiError(403, 'FORBIDDEN', 'Complete onboarding before accessing this feature.');
    }

    next();
  } catch (err) {
    next(err);
  }
}
