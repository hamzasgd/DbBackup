import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  triggerSync,
  triggerFullSync,
  syncProgressSSE,
} from '../controllers/sync-operations.controller';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);

// Sync operation endpoints
router.post('/:id/trigger', triggerSync);
router.post('/:id/full-sync', triggerFullSync);
router.get('/:id/progress', syncProgressSSE);

export default router;
