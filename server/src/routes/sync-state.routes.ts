import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getSyncState,
  getSyncHistory,
  activateSyncConfiguration,
  pauseSyncConfiguration,
  resumeSyncConfiguration,
  stopSyncConfiguration,
} from '../controllers/sync-state.controller';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);

// State management endpoints
router.get('/:id/state', getSyncState);
router.get('/:id/history', getSyncHistory);
router.post('/:id/activate', activateSyncConfiguration);
router.post('/:id/pause', pauseSyncConfiguration);
router.post('/:id/resume', resumeSyncConfiguration);
router.post('/:id/stop', stopSyncConfiguration);

export default router;
