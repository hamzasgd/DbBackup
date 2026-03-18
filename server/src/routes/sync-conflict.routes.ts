import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { resolveConflict } from '../controllers/sync-conflict.controller';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);

// Conflict resolution endpoint
router.post('/:conflictId/resolve', resolveConflict);

export default router;
