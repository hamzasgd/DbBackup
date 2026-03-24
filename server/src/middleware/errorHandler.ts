import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import {
  AppError,
  PrismaError,
} from '../errors';

export { AppError };

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Handle known error types
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Handle Prisma errors using code pattern matching (Pxxxx codes)
  if (isPrismaError(err)) {
    const prismaError = new PrismaError(err);
    res.status(prismaError.statusCode).json({
      success: false,
      error: {
        code: prismaError.code,
        message: prismaError.message,
      },
    });
    return;
  }

  // Handle unexpected errors
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    },
  });
}

function isPrismaError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' && code.startsWith('P');
  }
  return false;
}
