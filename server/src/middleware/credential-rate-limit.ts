import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../config/logger';

/**
 * Rate limiter for credential access endpoints.
 * Prevents credential scraping attacks by limiting requests per user.
 */
export const credentialRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window per user
  keyGenerator: (req: Request) => {
    // Use user ID if authenticated, otherwise use IP
    const user = (req as any).user;
    return user ? `cred:${user.userId}` : `cred:${req.ip}`;
  },
  handler: (req: Request, res: Response) => {
    const user = (req as any).user;
    const identifier = user ? `user ${user.userId}` : `IP ${req.ip}`;
    logger.warn(`Credential rate limit exceeded for ${identifier}`);
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many credential access requests. Please try again later.',
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Stricter rate limiter for sensitive operations like credential decryption
 */
export const credentialDecryptRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 decrypt requests per window per user
  keyGenerator: (req: Request) => {
    const user = (req as any).user;
    return user ? `decrypt:${user.userId}` : `decrypt:${req.ip}`;
  },
  handler: (req: Request, res: Response) => {
    const user = (req as any).user;
    const identifier = user ? `user ${user.userId}` : `IP ${req.ip}`;
    logger.warn(`Credential decrypt rate limit exceeded for ${identifier}`);
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many credential decryption requests. Please try again later.',
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});
