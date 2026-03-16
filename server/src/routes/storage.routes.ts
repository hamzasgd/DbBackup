import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getStorageSettings, upsertStorageSettings, testStorageConnection } from '../controllers/storage.controller';

const router = Router();
router.use(authenticate);

router.get('/', getStorageSettings);
router.put('/', upsertStorageSettings);
router.post('/test', testStorageConnection);

export default router;
