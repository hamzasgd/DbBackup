import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/token.service';
import { prisma } from '../config/database';
import { AppError } from './errorHandler';

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

/** Bearer header first, then ?token= (EventSource can't set headers). Throws 401 when absent. */
function extractToken(req: Request): string {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const fromHeader = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : undefined;
  const raw = fromHeader ?? queryToken;
  if (!raw) {
    throw new AppError('No token provided', 401);
  }
  return raw;
}

export async function authenticate(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Support token via Authorization header OR ?token= query param (for SSE EventSource)
    const payload = verifyAccessToken(extractToken(req));

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, isActive: true, tokenVersion: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found or inactive', 401);
    }

    // Invalidate access tokens issued before a password change / "revoke all sessions".
    // Tokens minted before this field existed carry no tokenVersion → treated as 0.
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new AppError('Session no longer valid — please sign in again', 401);
    }

    req.user = { userId: payload.userId, email: payload.email };
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError('Invalid or expired token', 401));
    }
  }
}
