import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler to automatically catch errors and pass them to next()
 * Eliminates the need for try/catch in every controller method
 *
 * @example
 * router.get('/backups', asyncHandler(getBackups));
 * router.post('/backups', asyncHandler(createBackup));
 */
export const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};