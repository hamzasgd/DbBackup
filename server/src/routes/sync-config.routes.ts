import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  createSyncConfiguration,
  getSyncConfigurations,
  getSyncConfiguration,
  updateSyncConfiguration,
  deleteSyncConfiguration,
} from '../controllers/sync-config.controller';
import {
  getSchemaComparison,
  createMissingTables,
} from '../controllers/sync-schema.controller';
import {
  getUnresolvedConflicts,
  resolveConflict,
} from '../controllers/sync-conflict.controller';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);

// Sync configuration CRUD endpoints
router.post('/', createSyncConfiguration);
router.get('/', getSyncConfigurations);
router.get('/:id', getSyncConfiguration);
router.patch('/:id', updateSyncConfiguration);
router.delete('/:id', deleteSyncConfiguration);

// Schema management endpoints
router.get('/:id/schema-comparison', getSchemaComparison);
router.post('/:id/create-missing-tables', createMissingTables);

// Conflict management endpoints
router.get('/:id/conflicts', getUnresolvedConflicts);

export default router;
