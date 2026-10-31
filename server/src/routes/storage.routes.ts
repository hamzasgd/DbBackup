import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getStorageSettings, upsertStorageSettings, testStorageConnection, storageUsage } from '../controllers/storage.controller';

const router = Router();
router.use(authenticate);

router.get('/', getStorageSettings);
router.put('/', upsertStorageSettings);
router.post('/test', testStorageConnection);
router.get('/usage', storageUsage);

export default router;
