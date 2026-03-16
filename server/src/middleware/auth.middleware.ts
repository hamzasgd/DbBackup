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

export async function authenticate(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Support token via Authorization header OR ?token= query param (for SSE EventSource)
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;

    const raw = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : queryToken;

    if (!raw) {
      throw new AppError('No token provided', 401);
    }

    const token = raw;
    const payload = verifyAccessToken(token);

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found or inactive', 401);
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
